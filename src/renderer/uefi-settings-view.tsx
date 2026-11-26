// The UEFI settings of a board, read over MaskROM (the settings job of
// woa-worker.ts): the value on the board next to the firmware's default,
// with controls made from the release's settings list (FEATURES.json,
// uefi-settings.ts), grouped by the page they are on in the firmware's menu.
// Nothing is written until the summary of the changes is confirmed. Also the
// smaller picker of values to set with a firmware write.
import { useMemo, useState } from 'react';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, Button, Card, CardBody, CardTitle, Content, FormSelect, FormSelectOption,
  List, ListItem, Stack, TextInput, Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useI18n } from './i18n';
import { parseVarStore, VarStoreError, type VarStore } from '../woa/uefi-vars';
import { settingRows, valueProblem, type Locked, type SettingOption, type SettingRow, type SettingsRequest, type Text } from '../woa/uefi-settings';

/** What the settings job read from the board (woa-worker.ts settings-read). */
export interface SettingsRead { lba: number; area: Uint8Array; stamp: string | null; dt: string; problem: string | null; sameFirmware: boolean }

type Edits = Record<string, number>;

function useWords() {
  const { t, lang, msg } = useI18n();
  const text = (x: Text) => (lang === 'zh-CN' && x.zh ? x.zh : x.en);
  const value = (o: SettingOption, v: number | string | null): string => {
    if (v === null) return t('uefi.value.none');
    if (typeof v === 'string') return v === '' ? t('uefi.value.empty') : v;
    const hit = o.values.find((x) => x.value === v);
    if (hit) return text(hit.label);
    if (o.type === 'checkbox') return t(v ? 'uefi.value.on' : 'uefi.value.off');
    return String(v);
  };
  const locked = (l: Locked): string => (l.code === 'layout' ? t('uefi.locked.layout', { board: l.board, release: l.release })
    : l.code === 'attributes' ? t('uefi.locked.attributes', { board: `0x${l.board.toString(16)}`, release: `0x${l.release.toString(16)}` })
      : l.code === 'grayed' ? t('uefi.locked.grayed', { when: l.when }) : t(`uefi.locked.${l.code}`));
  return { t, msg, text, value, locked };
}

/** The page path without "Device Manager", which every option has. */
const groupOf = (o: SettingOption) => (o.menu[0] === 'Device Manager' ? o.menu.slice(1) : o.menu).join(' / ') || o.variable.name;

function groups(rows: SettingRow[]): Array<[string, SettingRow[]]> {
  const m = new Map<string, SettingRow[]>();
  for (const r of rows) { const g = groupOf(r.option); m.set(g, [...(m.get(g) ?? []), r]); }
  return [...m.entries()];
}

/** A control for one option: its values, or a number; `blank` adds "leave as it is" (the firmware write). */
function ValueControl({ row, value, onChange, blank }: { row: SettingRow; value: number | undefined; onChange: (v: number | undefined) => void; blank: string | null }) {
  const w = useWords();
  const o = row.option;
  const [typed, setTyped] = useState(value === undefined ? '' : String(value));
  if (row.locked) return <span className="muted">{w.locked(row.locked)}</span>;
  if (o.type === 'numeric') {
    const n = typed.trim() === '' ? undefined : Number(typed);
    const bad = n !== undefined && valueProblem(o, n);
    return (
      <Stack>
        <TextInput id={`uefi-${o.id}`} aria-label={w.text(o.prompt)} value={typed} type="number" validated={bad ? 'error' : 'default'}
          placeholder={blank ?? (row.effective === null ? '' : String(row.effective))}
          onChange={(_e, v) => { setTyped(v); const x = v.trim() === '' ? undefined : Number(v); onChange(x === undefined || valueProblem(o, x) ? undefined : x); }} />
        <span className="muted">{w.t('uefi.range', { min: o.min ?? 0, max: o.max ?? '?', step: o.step ?? 1 })}</span>
      </Stack>
    );
  }
  const values = o.values.length ? o.values : [{ value: 0, label: { en: w.t('uefi.value.off'), zh: null } }, { value: 1, label: { en: w.t('uefi.value.on'), zh: null } }];
  const shown = value ?? (blank === null && typeof row.effective === 'number' ? row.effective : undefined);
  return (
    <FormSelect id={`uefi-${o.id}`} aria-label={w.text(o.prompt)} value={shown === undefined ? '' : String(shown)}
      onChange={(_e, v) => onChange(v === '' ? undefined : Number(v))}>
      {(blank !== null || shown === undefined) && <FormSelectOption value="" label={blank ?? w.t('uefi.value.none')} />}
      {values.map((x) => <FormSelectOption key={x.value} value={String(x.value)} label={w.text(x.label)} />)}
    </FormSelect>
  );
}

/** The changes `edits` make, as "prompt: from to" lines. */
function editLines(rows: SettingRow[], edits: Edits, w: ReturnType<typeof useWords>): string[] {
  return rows.filter((r) => edits[r.option.id] !== undefined && edits[r.option.id] !== r.effective)
    .map((r) => w.t('uefi.change', { what: w.text(r.option.prompt), from: w.value(r.option, r.effective), to: w.value(r.option, edits[r.option.id]) }));
}

export function SettingsEditor({ options, why, read, release, onApply, onClose, pickBackup }: {
  /** The release's options, or null with `why` when it has none. */
  options: SettingOption[] | null; why: string | null;
  read: SettingsRead;
  /** The release the options come from and the firmware version they were made for. */
  release: { tag: string | null; firmwareVersion: string | null };
  onApply: (req: SettingsRequest) => void;
  onClose: () => void;
  pickBackup: () => Promise<{ name: string; data: Uint8Array } | { error: string } | null>;
}) {
  const w = useWords();
  const { t, msg } = w;
  const [edits, setEdits] = useState<Edits>({});
  const [ask, setAsk] = useState<{ req: SettingsRequest; title: string; lines: string[] } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const parsed = useMemo((): { store: VarStore | null; error: string | null } => {
    if (read.problem === 'erased') return { store: null, error: null };
    try { return { store: parseVarStore(read.area), error: null }; } catch (e) {
      return { store: null, error: e instanceof VarStoreError ? e.message : String(e) };
    }
  }, [read]);
  const board = { store: parsed.store, sameFirmware: read.sameFirmware };
  const rows = useMemo(() => (options && !parsed.error ? settingRows(options, board, edits) : []), [options, parsed, edits, read.sameFirmware]); // eslint-disable-line react-hooks/exhaustive-deps
  const lines = editLines(rows, edits, w);
  const canEdit = !!options && !parsed.error;

  const restore = async () => {
    setBackupError(null);
    const r = await pickBackup();
    if (!r) return;
    if ('error' in r) { setBackupError(msg(r.error)); return; }
    let s: VarStore;
    try { s = parseVarStore(r.data); } catch (e) { setBackupError(t('uefi.backup.bad', { why: msg(String((e as Error).message)) })); return; }
    const diff = options ? settingRows(options, { store: s, sameFirmware: true }).flatMap((b) => {
      const now = rows.find((x) => x.option.id === b.option.id);
      return now && now.effective !== b.effective ? [w.t('uefi.change', { what: w.text(b.option.prompt), from: w.value(b.option, now.effective), to: w.value(b.option, b.effective) })] : [];
    }) : [];
    setAsk({ req: { kind: 'restore', area: r.data }, title: t('uefi.ask.restore', { file: r.name, n: s.live.length }), lines: diff.length ? diff : [t('uefi.ask.restore.same')] });
  };
  const reset = () => {
    const ls = rows.filter((r) => r.current !== null && r.current !== r.option.default)
      .map((r) => w.t('uefi.change', { what: w.text(r.option.prompt), from: w.value(r.option, r.current), to: w.value(r.option, r.option.default) }));
    setAsk({ req: { kind: 'reset' }, title: t('uefi.ask.reset'), lines: ls.length ? ls : [t('uefi.ask.reset.same')] });
  };

  if (ask) {
    return (
      <Card id="uefi-confirm">
        <CardTitle>{ask.title}</CardTitle>
        <CardBody>
          <Stack hasGutter>
            <List id="uefi-changes">{ask.lines.map((l) => <ListItem key={l}>{l}</ListItem>)}</List>
            <Content component="p">{t('uefi.ask.how')}</Content>
            {rows.some((r) => r.option.resetRequired && edits[r.option.id] !== undefined) && <Content component="p" className="muted">{t('uefi.ask.restart')}</Content>}
            <ActionList>
              <ActionListGroup>
                <ActionListItem><Button id="uefi-write" variant="danger" onClick={() => onApply(ask.req)}>{t('uefi.write')}</Button></ActionListItem>
                <ActionListItem><Button variant="secondary" onClick={() => setAsk(null)}>{t('back')}</Button></ActionListItem>
              </ActionListGroup>
            </ActionList>
          </Stack>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card id="uefi-settings">
      <CardTitle>{t('uefi.title')}</CardTitle>
      <CardBody>
        <Stack hasGutter>
          <Content component="p">{t('uefi.read', { lba: read.lba, firmware: read.stamp ?? t('uefi.firmware.unknown'), dt: read.dt })}</Content>
          {read.problem === 'erased' && <Alert isInline variant="info" title={t('uefi.erased')} />}
          {parsed.error && <Alert isInline variant="danger" title={t('uefi.bad.title')}>{msg(parsed.error)} {t('uefi.bad.text')}</Alert>}
          {!options && <Alert isInline variant="warning" title={t('uefi.noList.title')}>{msg(why ?? '')}</Alert>}
          {options && !read.sameFirmware && (
            <Alert isInline variant="warning" title={t('uefi.other.title')}>
              {t('uefi.other.text', { release: release.tag ?? '?', made: release.firmwareVersion ?? '?', board: read.stamp ?? t('uefi.firmware.unknown') })}
            </Alert>
          )}
          {canEdit && groups(rows).map(([g, rs]) => (
            <Stack key={g}>
              <Title headingLevel="h3" size="md">{g}</Title>
              <Table aria-label={g} variant="compact">
                <Thead><Tr><Th width={35}>{t('uefi.col.option')}</Th><Th>{t('uefi.col.board')}</Th><Th>{t('uefi.col.default')}</Th><Th width={30}>{t('uefi.col.new')}</Th></Tr></Thead>
                <Tbody>
                  {rs.map((r) => (
                    <Tr key={r.option.id} id={`uefi-row-${r.option.id}`}>
                      <Td dataLabel={t('uefi.col.option')}>{w.text(r.option.prompt)}{r.hidden ? <div className="muted">{t('uefi.hidden')}</div> : null}</Td>
                      <Td dataLabel={t('uefi.col.board')}>{r.locked?.code === 'layout' ? '?' : r.current === null ? t('uefi.value.notSet') : w.value(r.option, r.current)}</Td>
                      <Td dataLabel={t('uefi.col.default')}>{w.value(r.option, r.option.default)}</Td>
                      <Td dataLabel={t('uefi.col.new')}>
                        <ValueControl row={r} value={edits[r.option.id]} blank={null}
                          onChange={(v) => setEdits((e) => { const n = { ...e }; if (v === undefined || v === r.effective) delete n[r.option.id]; else n[r.option.id] = v; return n; })} />
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Stack>
          ))}
          {backupError && <Alert isInline variant="danger" title={backupError} />}
          <ActionList>
            <ActionListGroup>
              <ActionListItem><Button id="uefi-review" variant="primary" isDisabled={!canEdit || lines.length === 0}
                onClick={() => setAsk({ req: { kind: 'edit', edits }, title: t('uefi.ask.edit', { n: lines.length }), lines })}>{t('uefi.review', { n: lines.length })}</Button></ActionListItem>
              <ActionListItem><Button id="uefi-reset" variant="secondary" isDisabled={!canEdit || !parsed.store} onClick={reset}>{t('uefi.reset')}</Button></ActionListItem>
              <ActionListItem><Button id="uefi-restore" variant="secondary" onClick={restore}>{t('uefi.restore')}</Button></ActionListItem>
            </ActionListGroup>
            <ActionListGroup>
              <ActionListItem><Button id="uefi-close" variant="link" onClick={onClose}>{t('uefi.close')}</Button></ActionListItem>
            </ActionListGroup>
          </ActionList>
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * Values to set with a firmware write, before the board is read: each option
 * starts at "leave as it is". `keep`: the board's settings are kept (its
 * variables exist), else the write starts a new store, where only options the
 * release describes in full can be set.
 */
export function FlashSettingsPicker({ options, edits, onChange, keep }: { options: SettingOption[]; edits: Edits; onChange: (e: Edits) => void; keep: boolean }) {
  const w = useWords();
  const rows = settingRows(options, { store: null, sameFirmware: true }, edits)
    .map((r) => (keep && r.locked?.code === 'missing' ? { ...r, locked: null } : r));
  return (
    <Stack hasGutter id="flash-settings">
      <Content component="p" className="muted">{w.t(keep ? 'uefi.flash.keep' : 'uefi.flash.fresh')}</Content>
      {groups(rows).map(([g, rs]) => (
        <Stack key={g}>
          <Title headingLevel="h3" size="md">{g}</Title>
          <Table aria-label={g} variant="compact">
            <Thead><Tr><Th width={40}>{w.t('uefi.col.option')}</Th><Th>{w.t('uefi.col.default')}</Th><Th width={35}>{w.t('uefi.col.set')}</Th></Tr></Thead>
            <Tbody>
              {rs.map((r) => (
                <Tr key={r.option.id}>
                  <Td dataLabel={w.t('uefi.col.option')}>{w.text(r.option.prompt)}</Td>
                  <Td dataLabel={w.t('uefi.col.default')}>{w.value(r.option, r.option.default)}</Td>
                  <Td dataLabel={w.t('uefi.col.set')}>
                    <ValueControl row={r} value={edits[r.option.id]} blank={w.t('uefi.leave')}
                      onChange={(v) => { const n = { ...edits }; if (v === undefined) delete n[r.option.id]; else n[r.option.id] = v; onChange(n); }} />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Stack>
      ))}
    </Stack>
  );
}

/** "Prompt: value" lines for the values a firmware write sets. */
export function flashLines(options: SettingOption[], edits: Edits, w: { text: (x: Text) => string; value: (o: SettingOption, v: number) => string }): string[] {
  return options.filter((o) => edits[o.id] !== undefined).map((o) => `${w.text(o.prompt)}: ${w.value(o, edits[o.id])}`);
}

export function useSettingWords() {
  const w = useWords();
  return { text: w.text, value: (o: SettingOption, v: number) => w.value(o, v) };
}
