// The firmware's boot entries as they lie in the variable store
// (uefi-vars.ts): BootOrder and the Boot#### it lists, from the UEFI
// specification 2.10, section 3.1.3 "Load Options" (EFI_LOAD_OPTION) and
// chapter 10 "Device Path Protocol" (the node types), as EDK2's
// MdePkg/Include/Uefi/UefiSpec.h and Protocol/DevicePath.h define them.
//
// Only BootOrder is ever written, and only as a new order of the numbers it
// already holds: no Boot#### is created, changed or deleted.
//
// Pure code over bytes, no Node APIs: it runs in the MaskROM worker too.

import { ATTR, findVariable, GUID, type VarChange, type VarStore } from './uefi-vars';

export const LOAD_OPTION = { ACTIVE: 0x1, FORCE_RECONNECT: 0x2, HIDDEN: 0x8, CATEGORY: 0x1f00, CATEGORY_APP: 0x100 } as const;

/** What the device path points at, in a word the page shows. */
export type DeviceKind = 'emmc' | 'sd' | 'usb' | 'nvme' | 'sata' | 'ufs' | 'network' | 'disk' | 'firmware' | 'other';

export interface DevicePathNode { type: number; subType: number; data: Uint8Array }

export interface LoadOption {
  attributes: number;
  active: boolean;
  hidden: boolean;
  /** LOAD_OPTION_CATEGORY_APP: a firmware application (the setup menu, the shell), not something to start an OS from. */
  app: boolean;
  description: string;
  /** The nodes of the first device path instance, without the end node. */
  nodes: DevicePathNode[];
  kind: DeviceKind;
  /** The file the entry starts (the FilePath nodes joined), or null. */
  file: string | null;
  optionalDataBytes: number;
}

export class LoadOptionError extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function ucs2z(b: Uint8Array, o: number, end: number): { s: string; next: number } | null {
  let s = '';
  for (let i = o; i + 1 < end; i += 2) {
    const c = u16(b, i);
    if (c === 0) return { s, next: i + 2 };
    s += String.fromCharCode(c);
  }
  return null;
}

/** The nodes of a device path list up to the first end node; throws when a node runs past `end` or has a length below 4. */
export function devicePathNodes(b: Uint8Array, at: number, end: number): DevicePathNode[] {
  const out: DevicePathNode[] = [];
  let p = at;
  while (p + 4 <= end) {
    const type = b[p], subType = b[p + 1], len = u16(b, p + 2);
    if (len < 4 || p + len > end) throw new LoadOptionError(`a device path node at byte ${p} has length ${len}`);
    if (type === 0x7f) return out;
    out.push({ type, subType, data: b.subarray(p + 4, p + len) });
    p += len;
  }
  if (p !== end || out.length) throw new LoadOptionError('the device path has no end node');
  return out;
}

const NETWORK = new Set([0x0b, 0x0c, 0x0d, 0x18, 0x1f, 0x1e, 0x13]); // MAC, IPv4, IPv6, URI, DNS, WiFi, iSCSI
const USB = new Set([0x05, 0x0f, 0x10, 0x11]); // USB, USB class, USB WWID, device logical unit

/** The device a path points at: the first node that says so, network and USB before the storage under them. */
export function deviceKind(nodes: DevicePathNode[]): DeviceKind {
  const msg = nodes.filter((n) => n.type === 0x03).map((n) => n.subType);
  if (msg.some((s) => NETWORK.has(s))) return 'network';
  if (msg.some((s) => USB.has(s))) return 'usb';
  if (msg.includes(0x1d)) return 'emmc';
  if (msg.includes(0x1a)) return 'sd';
  if (msg.includes(0x17)) return 'nvme';
  if (msg.includes(0x19)) return 'ufs';
  if (msg.includes(0x12) || msg.includes(0x01) || msg.includes(0x02)) return 'sata';
  if (nodes.some((n) => n.type === 0x04 && (n.subType === 0x06 || n.subType === 0x07))) return 'firmware';
  if (nodes.some((n) => n.type === 0x04 && (n.subType === 0x01 || n.subType === 0x02))) return 'disk';
  return 'other';
}

/** The FilePath nodes (media, subtype 4) joined into one path, or null. */
export function filePath(nodes: DevicePathNode[]): string | null {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type !== 0x04 || n.subType !== 0x04) continue;
    // The PathName is NUL-terminated; a node without the NUL ends where the node does.
    let s = '';
    for (let i = 0; i + 1 < n.data.length; i += 2) {
      const c = u16(n.data, i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    if (s) parts.push(s);
  }
  if (!parts.length) return null;
  return parts.reduce((a, x) => (a.endsWith('\\') || x.startsWith('\\') ? a + x : `${a}\\${x}`));
}

/** Parse an EFI_LOAD_OPTION; throws LoadOptionError when it does not hold together. */
export function parseLoadOption(data: Uint8Array): LoadOption {
  if (data.length < 8) throw new LoadOptionError(`it is ${data.length} bytes, shorter than any load option`);
  const attributes = u32(data, 0);
  const pathBytes = u16(data, 4);
  const d = ucs2z(data, 6, data.length);
  if (!d) throw new LoadOptionError('its description is not a NUL-terminated string');
  const pathAt = d.next;
  if (pathAt + pathBytes > data.length) throw new LoadOptionError(`its device path (${pathBytes} bytes) runs past its end`);
  const nodes = pathBytes ? devicePathNodes(data, pathAt, pathAt + pathBytes) : [];
  return {
    attributes,
    active: (attributes & LOAD_OPTION.ACTIVE) !== 0,
    hidden: (attributes & LOAD_OPTION.HIDDEN) !== 0,
    app: (attributes & LOAD_OPTION.CATEGORY) === LOAD_OPTION.CATEGORY_APP,
    description: d.s,
    nodes,
    kind: deviceKind(nodes),
    file: filePath(nodes),
    optionalDataBytes: data.length - pathAt - pathBytes,
  };
}

/** The UEFI name of boot entry `n`: Boot0001, Boot000A (four upper-case hex digits). */
export const bootName = (n: number) => `Boot${n.toString(16).toUpperCase().padStart(4, '0')}`;

const WINDOWS_LOADER = '\\efi\\microsoft\\boot\\bootmgfw.efi';

/** The entry starts Windows Boot Manager from its usual place. */
export function isWindowsEntry(o: LoadOption | null): boolean {
  if (!o?.file) return false;
  const f = o.file.replace(/\//g, '\\').toLowerCase();
  return (f.startsWith('\\') ? f : `\\${f}`).endsWith(WINDOWS_LOADER);
}

export interface BootEntry {
  /** Where it is in BootOrder (its original place, so that repeated numbers stay apart). */
  slot: number;
  number: number;
  name: string;
  /** Not there: BootOrder lists a number without a Boot#### variable. */
  missing: boolean;
  option: LoadOption | null;
  /** Why the entry could not be read, or null. */
  problem: string | null;
}

export interface BootOrderRead {
  /** BootOrder's numbers, or null when the store has no BootOrder. */
  order: number[] | null;
  attributes: number;
  entries: BootEntry[];
  /** Why BootOrder cannot be rewritten here, or null. */
  locked: string | null;
}

const BOOT_ORDER_ATTRIBUTES = ATTR.NON_VOLATILE | ATTR.BOOTSERVICE_ACCESS | ATTR.RUNTIME_ACCESS;

/** BootOrder and the entries it lists, in its order. */
export function readBootOrder(store: VarStore | null): BootOrderRead {
  const rec = store ? findVariable(store, 'BootOrder', GUID.globalVariable).cur : null;
  if (!store || !rec) return { order: null, attributes: BOOT_ORDER_ATTRIBUTES, entries: [], locked: 'The firmware has not saved a boot order yet.' };
  let locked: string | null = null;
  if (rec.data.length % 2) locked = `BootOrder is ${rec.data.length} bytes, not a list of 2-byte numbers.`;
  else if (rec.attributes !== BOOT_ORDER_ATTRIBUTES) locked = `BootOrder has attributes 0x${rec.attributes.toString(16)}, not 0x7.`;
  else if (rec.monotonicCount || rec.pubKeyIndex || rec.timestampSet) locked = 'BootOrder carries authentication data.';
  const order: number[] = [];
  for (let i = 0; i + 1 < rec.data.length; i += 2) order.push(u16(rec.data, i));
  const entries = order.map((number, slot): BootEntry => {
    const name = bootName(number);
    const v = findVariable(store, name, GUID.globalVariable).cur ?? findVariable(store, name.replace(/[A-F]/g, (c) => c.toLowerCase()), GUID.globalVariable).cur;
    if (!v) return { slot, number, name, missing: true, option: null, problem: null };
    try {
      return { slot, number, name, missing: false, option: parseLoadOption(v.data), problem: null };
    } catch (e) {
      if (e instanceof LoadOptionError) return { slot, number, name, missing: false, option: null, problem: e.message };
      throw e;
    }
  });
  return { order, attributes: rec.attributes, entries, locked };
}

/** Windows Boot Manager entries first, everything else after them, each group in the order it had. */
export function windowsFirst(entries: BootEntry[]): BootEntry[] {
  return [...entries.filter((e) => isWindowsEntry(e.option)), ...entries.filter((e) => !isWindowsEntry(e.option))];
}

/** Move entry `from` to place `to`. */
export function moveEntry<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

export class BootOrderError extends Error {}

const sorted = (a: number[]) => a.slice().sort((x, y) => x - y);

/**
 * The write that makes BootOrder `order`: the numbers it already holds, in a
 * new order, with the attributes it has. Throws BootOrderError when `order`
 * is not that, or BootOrder cannot be written. null: the order is unchanged.
 */
export function bootOrderChange(store: VarStore, order: number[]): VarChange | null {
  const r = readBootOrder(store);
  if (!r.order) throw new BootOrderError('The board has no boot order saved, so there is none to change.');
  if (r.locked) throw new BootOrderError(`${r.locked} It is not changed here.`);
  if (!order.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)) throw new BootOrderError('The new boot order holds a number that is not a boot entry number.');
  const a = sorted(r.order), b = sorted(order);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new BootOrderError('The new boot order does not hold exactly the entries the board has; entries are never added or removed here.');
  }
  if (order.every((x, i) => x === r.order![i])) return null;
  const data = new Uint8Array(order.length * 2);
  order.forEach((n, i) => { data[i * 2] = n & 0xff; data[i * 2 + 1] = n >> 8; });
  return { name: 'BootOrder', guid: GUID.globalVariable, attributes: r.attributes, data };
}

/** The only variable a boot order change writes. */
export const isBootOrder = (name: string, guid: string) => name === 'BootOrder' && guid.toLowerCase() === GUID.globalVariable;
