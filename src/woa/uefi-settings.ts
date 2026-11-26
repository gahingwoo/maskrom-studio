// The firmware's setup options, as the "settings" section of an edk2-rk3576
// release's FEATURES.json describes them (edk2-rk3576 docs/dev/features-json.md,
// settings schema 1: one entry per question on a setup page, with the EFI
// variable it is stored in, the byte offset and width of the value, the
// default, the allowed values and their labels, and the menu path), applied
// to the board's variable store (uefi-vars.ts).
//
// What may be changed: oneof, checkbox and numeric options whose variable on
// the board has the size the release gives (a different size means another
// layout, so the option is shown read-only), and only the variables the
// section lists. A variable that is not on the board yet is created only
// when the release describes every byte of it and the board runs that very
// firmware. Strings and ordered lists are shown, never written.
//
// No Node APIs: the MaskROM worker uses it too.

import {
  findVariable, freshVarStore, isErasedArea, parseVarStore, protectedReason, setVariables,
  VarStoreError, type VarChange, type VarStore,
} from './uefi-vars';

export const SETTINGS_SCHEMA = 1;

export interface Text { en: string; zh: string | null }

export interface SettingOption {
  id: string;
  prompt: Text;
  /** The page path in the firmware's menu, e.g. ["Device Manager", "RK3576 Platform Configuration", "Display"]. */
  menu: string[];
  variable: { name: string; guid: string; attributes: number; size: number };
  offset: number;
  width: number;
  type: 'oneof' | 'checkbox' | 'numeric' | 'string' | 'orderedlist';
  default: number | string | null;
  values: Array<{ value: number; label: Text }>;
  min?: number;
  max?: number;
  step?: number;
  resetRequired: boolean;
  hiddenWhen: string[];
  grayedOutWhen: string[];
  /** For an option the firmware shows only where a "<X>Supported" variable says so: that build's value, null when probed at boot. */
  boardSupport?: { variable: string; value: number | null };
}

export class SettingsError extends Error {}

const text = (v: unknown): Text | null => {
  if (typeof v === 'string') return { en: v, zh: null };
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const en = typeof o['en-US'] === 'string' ? o['en-US'] : Object.values(o).find((x) => typeof x === 'string') as string | undefined;
  if (en === undefined) return null;
  return { en: en.trim(), zh: typeof o['zh-Hans'] === 'string' ? (o['zh-Hans'] as string).trim() : null };
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The options of a board's "settings" section, or a sentence saying why
 * there are none (a release before FEATURES.json, no section, a schema this
 * app does not know). Entries that do not have the fields it needs are left out.
 */
export function settingOptions(section: unknown): SettingOption[] | string {
  if (section === undefined || section === null) return 'This firmware release does not describe its settings (FEATURES.json has no settings section; releases 0.4.1 and older have none).';
  if (typeof section !== 'object') return 'The settings section of FEATURES.json is not an object.';
  const s = section as { schema?: unknown; options?: unknown };
  if (s.schema !== SETTINGS_SCHEMA) return `The settings section of FEATURES.json has schema ${String(s.schema)}; this app reads schema ${SETTINGS_SCHEMA}. Update the app.`;
  if (!Array.isArray(s.options)) return 'The settings section of FEATURES.json has no options.';
  const out: SettingOption[] = [];
  for (const raw of s.options) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const v = o.variable as Record<string, unknown> | undefined;
    const prompt = text(o.prompt);
    const type = o.type;
    if (typeof o.id !== 'string' || !prompt || !v || typeof v.name !== 'string' || typeof v.guid !== 'string') continue;
    if (type !== 'oneof' && type !== 'checkbox' && type !== 'numeric' && type !== 'string' && type !== 'orderedlist') continue;
    const attributes = num(v.attributes), size = num(v.size), offset = num(o.offset), width = num(o.width);
    if (attributes === undefined || size === undefined || offset === undefined || width === undefined) continue;
    if (size <= 0 || width <= 0 || offset < 0 || offset + width > size) continue;
    const values = Array.isArray(o.values) ? o.values.flatMap((x) => {
      const e = x as { value?: unknown; label?: unknown };
      const value = num(e?.value);
      const label = text(e?.label);
      return value === undefined || !label ? [] : [{ value, label }];
    }) : [];
    const bs = o.boardSupport as { variable?: unknown; value?: unknown } | undefined;
    out.push({
      id: o.id, prompt, menu: strs(o.menu), variable: { name: v.name, guid: v.guid.toLowerCase(), attributes, size },
      offset, width, type, default: typeof o.default === 'number' || typeof o.default === 'string' ? o.default : null, values,
      ...(num(o.min) !== undefined ? { min: num(o.min) } : {}), ...(num(o.max) !== undefined ? { max: num(o.max) } : {}),
      ...(num(o.step) !== undefined ? { step: num(o.step) } : {}),
      resetRequired: o.resetRequired === true, hiddenWhen: strs(o.hiddenWhen), grayedOutWhen: strs(o.grayedOutWhen),
      ...(bs && typeof bs.variable === 'string' ? { boardSupport: { variable: bs.variable, value: typeof bs.value === 'boolean' ? (bs.value ? 1 : 0) : num(bs.value) ?? null } } : {}),
    });
  }
  return out;
}

// --- values ------------------------------------------------------------------

export function readField(data: Uint8Array, o: SettingOption): number | string {
  if (o.type === 'string') {
    let s = '';
    for (let i = o.offset; i + 1 < o.offset + o.width; i += 2) {
      const c = data[i] | (data[i + 1] << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  let v = 0;
  for (let i = o.width - 1; i >= 0; i--) v = v * 256 + data[o.offset + i];
  return v;
}

function writeField(data: Uint8Array, o: SettingOption, v: number): void {
  let x = v;
  for (let i = 0; i < o.width; i++) { data[o.offset + i] = x % 256; x = Math.floor(x / 256); }
}

/** Why `v` is not a value this option takes, or null. */
export function valueProblem(o: SettingOption, v: unknown): string | null {
  if (o.type === 'string' || o.type === 'orderedlist') return `${o.prompt.en}: this kind of option is not changed here.`;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return `${o.prompt.en}: ${String(v)} is not a value it takes.`;
  if (o.width < 8 && v >= 2 ** (8 * o.width)) return `${o.prompt.en}: ${v} does not fit in ${o.width} bytes.`;
  if (o.type === 'oneof' || o.type === 'checkbox') {
    const allowed = o.values.length ? o.values.map((x) => x.value) : [0, 1];
    if (!allowed.includes(v)) return `${o.prompt.en}: ${v} is not one of its values.`;
  }
  if (o.type === 'numeric') {
    if (o.min !== undefined && v < o.min) return `${o.prompt.en}: ${v} is below ${o.min}.`;
    if (o.max !== undefined && v > o.max) return `${o.prompt.en}: ${v} is above ${o.max}.`;
    if (o.step && o.min !== undefined && (v - o.min) % o.step !== 0) return `${o.prompt.en}: ${v} is not a step of ${o.step} from ${o.min}.`;
  }
  return null;
}

// --- conditions --------------------------------------------------------------

/**
 * Evaluate a hiddenWhen/grayedOutWhen text (features.py expr_text: "and",
 * "or", "not", comparisons, "&", "|", "+", "-", numbers and <variable>@<offset>).
 * null when it cannot be told: a reference without a known value, or text
 * this does not read ("expression not decoded").
 */
export function evalCondition(src: string, lookup: (variable: string, offset: number) => number | null): boolean | null {
  const toks = src.match(/[A-Za-z_][A-Za-z0-9_]*@\d+|0x[0-9a-fA-F]+|\d+|==|!=|>=|<=|[()&|+\-<>]|\b(?:and|or|not|true|false)\b|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  type V = number | null;
  const atom = (): V => {
    const t = toks[i++];
    if (t === undefined) throw new Error('end');
    if (t === '(') { const v = or(); if (toks[i++] !== ')') throw new Error(')'); return v; }
    if (t === 'not') { const v = atom(); return v === null ? null : v ? 0 : 1; }
    if (t === 'true') return 1;
    if (t === 'false') return 0;
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return Number(t);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)@(\d+)$/.exec(t);
    if (m) return lookup(m[1], Number(m[2]));
    throw new Error(t);
  };
  const arith = (): V => {
    let l = atom();
    while (['&', '|', '+', '-'].includes(peek())) {
      const op = toks[i++]; const r = atom();
      l = l === null || r === null ? null : op === '&' ? Number(BigInt(l) & BigInt(r)) : op === '|' ? Number(BigInt(l) | BigInt(r)) : op === '+' ? l + r : l - r;
    }
    return l;
  };
  const cmp = (): V => {
    const l = arith();
    const op = peek();
    if (!['==', '!=', '<', '>', '<=', '>='].includes(op)) return l;
    i++;
    const r = arith();
    if (l === null || r === null) return null;
    const v = op === '==' ? l === r : op === '!=' ? l !== r : op === '<' ? l < r : op === '>' ? l > r : op === '<=' ? l <= r : l >= r;
    return v ? 1 : 0;
  };
  const and = (): V => {
    let l = cmp();
    while (peek() === 'and') { i++; const r = cmp(); l = l === 0 || r === 0 ? 0 : l === null || r === null ? null : 1; }
    return l;
  };
  function or(): V {
    let l = and();
    while (peek() === 'or') { i++; const r = and(); l = (l !== null && l !== 0) || (r !== null && r !== 0) ? 1 : l === null || r === null ? null : 0; }
    return l;
  }
  try {
    const v = or();
    if (i !== toks.length) return null;
    return v === null ? null : v !== 0;
  } catch { return null; }
}

// --- the board's settings ----------------------------------------------------

/** Why an option is shown but cannot be changed. */
export type Locked =
  | { code: 'kind' }
  | { code: 'unsupported' }
  | { code: 'layout'; board: number; release: number }
  | { code: 'attributes'; board: number; release: number }
  | { code: 'missing' }
  | { code: 'protected' }
  | { code: 'grayed'; when: string };

export interface SettingRow {
  option: SettingOption;
  /** The value on the board; null when the variable is not there (the firmware uses its default) or cannot be read. */
  current: number | string | null;
  /** The value the firmware uses: the current one, or the default when the variable is not there. */
  effective: number | string | null;
  locked: Locked | null;
  /** The firmware's menu hides it now (with the values as they will be after the edits); null when that cannot be told. */
  hidden: boolean | null;
}

export interface BoardSettings {
  /** null: the store is erased (the firmware has not started since it was written). */
  store: VarStore | null;
  /** The board runs the firmware the settings section was made for. */
  sameFirmware: boolean;
}

const key = (name: string, guid: string) => `${guid.toLowerCase()}\0${name}`;

/** The variables an option list may write: nothing else is ever written. */
export function allowedVariables(options: SettingOption[]): (name: string, guid: string) => boolean {
  const set = new Set(options.map((o) => key(o.variable.name, o.variable.guid)));
  return (name, guid) => set.has(key(name, guid));
}

/** Every byte of the variable is some option's value, so it can be built from the defaults. */
function coversVariable(options: SettingOption[], o: SettingOption): boolean {
  const mine = options.filter((x) => x.variable.name === o.variable.name && x.variable.guid === o.variable.guid);
  const bytes = new Uint8Array(o.variable.size);
  for (const x of mine) {
    if (x.type === 'string' || x.type === 'orderedlist' || typeof x.default !== 'number') return false;
    bytes.fill(1, x.offset, x.offset + x.width);
  }
  return bytes.every((b) => b === 1);
}

export function settingRows(options: SettingOption[], board: BoardSettings, edits: Record<string, number> = {}): SettingRow[] {
  const live = (o: SettingOption) => (board.store ? findVariable(board.store, o.variable.name, o.variable.guid).cur : null);
  const rows: SettingRow[] = options.map((o) => {
    const rec = live(o);
    let locked: Locked | null = null;
    let current: number | string | null = null;
    if (rec) {
      if (rec.data.length !== o.variable.size) locked = { code: 'layout', board: rec.data.length, release: o.variable.size };
      else current = readField(rec.data, o);
      if (!locked && rec.attributes !== o.variable.attributes) locked = { code: 'attributes', board: rec.attributes, release: o.variable.attributes };
      if (!locked && protectedReason(rec.name, rec.guid, rec.attributes)) locked = { code: 'protected' };
    } else if (!(coversVariable(options, o) && board.sameFirmware)) locked = { code: 'missing' };
    if (protectedReason(o.variable.name, o.variable.guid, o.variable.attributes)) locked = { code: 'protected' };
    if (o.type === 'string' || o.type === 'orderedlist') locked = { code: 'kind' };
    if (o.boardSupport && o.boardSupport.value === 0) locked = { code: 'unsupported' };
    return { option: o, current, effective: rec ? current : o.default, locked, hidden: null };
  });
  // The conditions, over the values the firmware will see after the edits.
  const value = (variable: string, offset: number): number | null => {
    for (const r of rows) {
      if (r.option.variable.name !== variable || r.option.offset !== offset) continue;
      const v = edits[r.option.id] ?? r.effective;
      return typeof v === 'number' ? v : null;
    }
    const sup = options.find((o) => o.boardSupport?.variable === variable)?.boardSupport;
    return sup && offset === 0 ? sup.value : null;
  };
  for (const r of rows) {
    const hide = r.option.hiddenWhen.map((c) => evalCondition(c, value));
    r.hidden = hide.some((x) => x === true) ? true : hide.every((x) => x === false) ? false : null;
    if (!r.locked) {
      const gray = r.option.grayedOutWhen.find((c) => evalCondition(c, value) === true);
      if (gray) r.locked = { code: 'grayed', when: gray };
    }
  }
  return rows;
}

/**
 * The variable writes that make the board's settings `edits` (option id to
 * value), in the order of the options. Throws SettingsError for an edit that
 * is not allowed (a locked option, a value it does not take).
 */
export function changesFor(options: SettingOption[], board: BoardSettings, edits: Record<string, number>): VarChange[] {
  const rows = settingRows(options, board, edits);
  const byVar = new Map<string, { o: SettingOption; data: Uint8Array; before: Uint8Array | null }>();
  for (const [id, v] of Object.entries(edits)) {
    const r = rows.find((x) => x.option.id === id);
    if (!r) throw new SettingsError(`${id} is not one of this firmware's settings.`);
    const o = r.option;
    if (r.locked) throw new SettingsError(`${o.prompt.en} cannot be changed here (${r.locked.code}).`);
    const why = valueProblem(o, v);
    if (why) throw new SettingsError(why);
    const k = key(o.variable.name, o.variable.guid);
    let e = byVar.get(k);
    if (!e) {
      const rec = board.store ? findVariable(board.store, o.variable.name, o.variable.guid).cur : null;
      let data: Uint8Array;
      if (rec) data = rec.data.slice();
      else {
        // Not on the board: built from every option's default (settingRows locked it unless they cover it all).
        data = new Uint8Array(o.variable.size);
        for (const x of options) if (x.variable.name === o.variable.name && x.variable.guid === o.variable.guid) writeField(data, x, x.default as number);
      }
      e = { o, data, before: rec ? rec.data : null };
      byVar.set(k, e);
    }
    writeField(e.data, o, v);
  }
  const out: VarChange[] = [];
  for (const e of byVar.values()) {
    if (e.before && e.before.length === e.data.length && e.before.every((x, i) => x === e.data[i])) continue;
    out.push({ name: e.o.variable.name, guid: e.o.variable.guid, attributes: e.o.variable.attributes, data: e.data });
  }
  return out;
}

/** "Reset to defaults": delete every listed variable the board has; the firmware then uses its defaults. */
export function resetChanges(options: SettingOption[], store: VarStore | null): VarChange[] {
  if (!store) return [];
  const seen = new Set<string>();
  const out: VarChange[] = [];
  for (const o of options) {
    const k = key(o.variable.name, o.variable.guid);
    if (seen.has(k)) continue;
    seen.add(k);
    const rec = findVariable(store, o.variable.name, o.variable.guid).cur;
    if (!rec || protectedReason(rec.name, rec.guid, rec.attributes)) continue;
    out.push({ name: o.variable.name, guid: o.variable.guid, attributes: rec.attributes, data: null });
  }
  return out;
}

// --- what a job writes ---------------------------------------------------------

/** What the page asks a settings job to do with the area it read. */
export type SettingsRequest =
  | { kind: 'edit'; edits: Record<string, number> }
  | { kind: 'reset' }
  | { kind: 'restore'; area: Uint8Array };

export interface SettingsPlan {
  /** The new area, or null when it would be the same as the board's. */
  bytes: Uint8Array | null;
  /** Variables written or deleted. */
  variables: string[];
  reclaimed: boolean;
}

/** The firmware build stamp ("rk3576-CM5IO-0.4.2") equals the version FEATURES.json was made for. */
export function sameFirmware(stamp: string | null, firmwareVersion: string | null): boolean {
  return !!stamp && !!firmwareVersion && stamp === firmwareVersion;
}

/**
 * The bytes to write over `area` (the 192 KiB the board holds) for `req`.
 * The area must parse; an erased one gets a new store (as the firmware
 * would make on its first start) with only the edited variables in it.
 * Throws VarStoreError or SettingsError with the reason when it must not be written.
 */
export function planSettings(area: Uint8Array, req: SettingsRequest, options: SettingOption[], same: boolean): SettingsPlan {
  const allowed = allowedVariables(options);
  if (req.kind === 'restore') {
    const s = parseVarStore(req.area);
    if (!s.live.length) throw new VarStoreError('The backup holds no variables.');
    const equal = req.area.length === area.length && req.area.every((x, i) => x === area[i]);
    return { bytes: equal ? null : req.area.slice(), variables: [], reclaimed: false };
  }
  const erased = isErasedArea(area);
  const base = erased ? freshVarStore() : area;
  const store = parseVarStore(base);
  const board: BoardSettings = { store: erased ? null : store, sameFirmware: same };
  const changes = req.kind === 'reset' ? resetChanges(options, board.store) : changesFor(options, board, req.edits);
  if (changes.length === 0) return { bytes: null, variables: [], reclaimed: false };
  const r = setVariables(base, changes, allowed);
  return { bytes: r.bytes, variables: r.changed, reclaimed: r.reclaimed };
}
