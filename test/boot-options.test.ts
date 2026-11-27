// Boot entries and BootOrder (boot-options.ts) on the two real stores of
// uefi-vars.test.ts, their zeroed Boot#### given believable load options
// (boot-fixture.ts). With VARSTORE_OUT set, the rewritten stores are saved
// for the EDK2 checkers CI runs (scripts/varstore), as uefi-vars.test.ts does.
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  bootName, bootOrderChange, BootOrderError, deviceKind, devicePathNodes, isWindowsEntry, LoadOptionError, moveEntry, parseLoadOption,
  readBootOrder, windowsFirst,
} from '../src/woa/boot-options';
import { findVariable, freshVarStore, GUID, parseVarStore, setVariables, type VarStore } from '../src/woa/uefi-vars';
import { planSettings, settingOptions, type SettingOption } from '../src/woa/uefi-settings';
import { dp, loadOption, ROCK4D_ENTRIES, TSPI_ENTRIES, withBootEntries } from './boot-fixture';

const fixture = (name: string): Uint8Array => new Uint8Array(gunzipSync(readFileSync(join(__dirname, 'fixtures', `nvdata-${name}.bin.gz`))));
const features = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'edk2-features.json'), 'utf8'));
const opts = settingOptions(features.boards.TaishanPi3M.settings) as SettingOption[];
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const listing = (s: VarStore) => s.live.map((r) => `${r.name} ${r.guid} 0x${r.attributes.toString(16)} ${hex(r.data)}`);
const bootOrderOf = (area: Uint8Array) => readBootOrder(parseVarStore(area)).order;

function keep(name: string, bytes: Uint8Array) {
  const dir = process.env.VARSTORE_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.bin`), bytes);
  writeFileSync(join(dir, `${name}.txt`), `${listing(parseVarStore(bytes)).join('\n')}\n`);
}

describe('load options', () => {
  it('reads the attributes, the description and the device path', () => {
    const w = parseLoadOption(TSPI_ENTRIES[0x0b]);
    expect(w).toMatchObject({ attributes: 1, active: true, hidden: false, app: false, description: 'Windows Boot Manager', kind: 'emmc',
      file: '\\EFI\\Microsoft\\Boot\\bootmgfw.efi', optionalDataBytes: 0 });
    expect(w.nodes.map((n) => `${n.type}/${n.subType}`)).toEqual(['1/4', '3/29', '1/5', '4/1', '4/4']);
    expect(isWindowsEntry(w)).toBe(true);
    // The short form bcdboot writes: a partition and a file, no controller.
    const short = parseLoadOption(TSPI_ENTRIES[0x0a]);
    expect(short).toMatchObject({ kind: 'disk', optionalDataBytes: 12 });
    expect(isWindowsEntry(short)).toBe(true);
    const setup = parseLoadOption(TSPI_ENTRIES[0]);
    expect(setup).toMatchObject({ description: 'UiApp', active: true, hidden: true, app: true, kind: 'firmware', file: null });
    expect(parseLoadOption(TSPI_ENTRIES[6])).toMatchObject({ active: false, kind: 'network' });
  });

  it('names the device of each entry', () => {
    const kinds = Object.fromEntries(Object.entries(TSPI_ENTRIES).map(([n, d]) => [n, parseLoadOption(d).kind]));
    expect(kinds).toEqual({ 0: 'firmware', 1: 'firmware', 2: 'emmc', 3: 'sd', 4: 'usb', 5: 'network', 6: 'network', 7: 'nvme', 8: 'firmware',
      9: 'sd', 10: 'disk', 11: 'emmc', 12: 'disk' });
    expect(deviceKind([])).toBe('other');
  });

  it('joins file path nodes, and tells Windows by its loader whatever the case or slashes', () => {
    const two = parseLoadOption(loadOption(1, 'x', [dp.hd(1, 1, 1), dp.file('\\EFI\\Microsoft'), dp.file('Boot\\BOOTMGFW.EFI')]));
    expect(two.file).toBe('\\EFI\\Microsoft\\Boot\\BOOTMGFW.EFI');
    expect(isWindowsEntry(two)).toBe(true);
    expect(isWindowsEntry(parseLoadOption(loadOption(1, 'x', [dp.file('EFI/Microsoft/Boot/bootmgfw.efi')])))).toBe(true);
    expect(isWindowsEntry(parseLoadOption(loadOption(1, 'x', [dp.file('\\EFI\\Microsoft\\Boot\\bootmgr.efi')])))).toBe(false);
    expect(isWindowsEntry(parseLoadOption(loadOption(1, 'x', [dp.file('\\EFI\\NotMicrosoft\\Boot\\bootmgfw.efi')])))).toBe(false);
    expect(isWindowsEntry(null)).toBe(false);
  });

  it('refuses a load option that does not hold together', () => {
    expect(() => parseLoadOption(Uint8Array.of(1, 0, 0))).toThrow(LoadOptionError);
    // The description never ends.
    expect(() => parseLoadOption(Uint8Array.of(1, 0, 0, 0, 4, 0, 0x41, 0, 0x42, 0))).toThrow(/description/);
    // The path list is longer than the variable.
    const o = loadOption(1, 'A', [dp.file('\\x')]);
    o[4] = 0xff;
    expect(() => parseLoadOption(o)).toThrow(/runs past/);
    // A node of length 2, and a list without its end node.
    expect(() => devicePathNodes(Uint8Array.of(4, 4, 2, 0, 0x7f, 0xff, 4, 0), 0, 8)).toThrow(/length 2/);
    expect(() => devicePathNodes(Uint8Array.from(dp.file('\\x')), 0, dp.file('\\x').length)).toThrow(/no end node/);
    // A zeroed entry, as the sanitised fixtures have them: inactive, no description, no path.
    expect(parseLoadOption(new Uint8Array(40))).toMatchObject({ active: false, description: '', nodes: [], kind: 'other' });
  });
});

describe('the boot order on a real store', () => {
  const tspi = withBootEntries(fixture('tspi3m'), TSPI_ENTRIES);

  it('lists BootOrder\'s entries in its order', () => {
    const r = readBootOrder(parseVarStore(tspi));
    expect(r.order).toEqual([9, 10, 6, 7, 5, 11, 12, 0, 1, 2, 3, 4, 8]);
    expect(r.locked).toBe(null);
    expect(r.entries.map((e) => e.name)).toEqual(['Boot0009', 'Boot000A', 'Boot0006', 'Boot0007', 'Boot0005', 'Boot000B', 'Boot000C',
      'Boot0000', 'Boot0001', 'Boot0002', 'Boot0003', 'Boot0004', 'Boot0008']);
    expect(r.entries.every((e) => !e.missing && e.option && !e.problem)).toBe(true);
    expect(bootName(0xabc)).toBe('Boot0ABC');
    // The sanitised store as it is: entries without data read as inactive, nothing breaks.
    const raw = readBootOrder(parseVarStore(fixture('tspi3m')));
    expect(raw.entries.length).toBe(13);
    expect(raw.entries.every((e) => e.option && !e.option.active)).toBe(true);
  });

  it('puts the Windows entries first and keeps the rest in their order', () => {
    const r = readBootOrder(parseVarStore(tspi));
    expect(windowsFirst(r.entries).map((e) => e.number)).toEqual([10, 11, 9, 6, 7, 5, 12, 0, 1, 2, 3, 4, 8]);
    expect(moveEntry([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveEntry([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
  });

  it('rewrites only BootOrder, as SetVariable would: the old record deleted, the new one appended', () => {
    const s = parseVarStore(tspi);
    const old = findVariable(s, 'BootOrder', GUID.globalVariable).cur!;
    const order = windowsFirst(readBootOrder(s).entries).map((e) => e.number);
    const p = planSettings(tspi, { kind: 'edit', edits: {}, bootOrder: order }, opts, true);
    expect(p.variables).toEqual(['BootOrder']);
    expect(p.reclaimed).toBe(false);
    const after = parseVarStore(p.bytes!);
    expect(bootOrderOf(p.bytes!)).toEqual(order);
    const now = findVariable(after, 'BootOrder', GUID.globalVariable).cur!;
    expect(now).toMatchObject({ offset: s.endAt, attributes: 7, stateByte: 0x3f });
    expect(hex(now.data)).toBe('0a000b000900060007000500' + '0c00000001000200030004000800');
    expect(after.records.find((x) => x.offset === old.offset)!.stateByte).toBe(0x3c);
    // Every other byte as it was: the old record's State, then the new record after the last one.
    const diff = [...p.bytes!.keys()].filter((i) => p.bytes![i] !== tspi[i]);
    expect(diff[0]).toBe(old.offset + 2);
    expect(diff.slice(1).every((i) => i >= s.endAt && i < now.next)).toBe(true);
    // Every Boot#### and every other variable reads back as before.
    const before = listing(s).filter((l) => !l.startsWith('BootOrder '));
    expect(listing(after).filter((l) => !l.startsWith('BootOrder '))).toEqual(before);
    keep('bootorder-tspi3m', p.bytes!);
  });

  it('writes the boot order together with setting changes, in one store', () => {
    const p = planSettings(tspi, { kind: 'edit', edits: { AcpiFanControl: 2 }, bootOrder: [10, 9, 6, 7, 5, 11, 12, 0, 1, 2, 3, 4, 8] }, opts, true);
    expect(p.variables).toEqual(['AcpiFanControl', 'BootOrder']);
    expect(bootOrderOf(p.bytes!)).toEqual([10, 9, 6, 7, 5, 11, 12, 0, 1, 2, 3, 4, 8]);
    keep('bootorder-and-fan-tspi3m', p.bytes!);
    // The same order: nothing to write.
    expect(planSettings(tspi, { kind: 'edit', edits: {}, bootOrder: readBootOrder(parseVarStore(tspi)).order! }, opts, true).bytes).toBe(null);
  });

  it('works on the ROCK 4D\'s store, with no settings list at all, and compacts it when full', () => {
    const r4 = withBootEntries(fixture('rock4d'), ROCK4D_ENTRIES);
    const p = planSettings(r4, { kind: 'edit', edits: {}, bootOrder: [3, 2, 1, 0] }, [], false);
    expect(bootOrderOf(p.bytes!)).toEqual([3, 2, 1, 0]);
    keep('bootorder-rock4d', p.bytes!);
    // A store with no room left: fill it with a variable, then the BootOrder write needs Reclaim().
    let full = r4;
    for (let i = 0; ; i++) {
      try { full = setVariables(full, [{ name: `Filler${i}`, guid: '11111111-2222-3333-4444-555555555555', attributes: 7, data: new Uint8Array(0x1f00) }], () => true).bytes; } catch { break; }
      if (parseVarStore(full).endAt > 0xf000) break;
    }
    // Then one that leaves 16 bytes, less than the new BootOrder record needs.
    const room = 0x10000 - parseVarStore(full).endAt;
    full = setVariables(full, [{ name: 'Last', guid: '11111111-2222-3333-4444-555555555555', attributes: 7, data: new Uint8Array(room - 60 - 10 - 16) }], () => true).bytes;
    expect(0x10000 - parseVarStore(full).endAt).toBeLessThan(60 + 20 + 8);
    const q = planSettings(full, { kind: 'edit', edits: {}, bootOrder: [1, 0, 2, 3] }, [], false);
    expect(q.reclaimed).toBe(true);
    expect(bootOrderOf(q.bytes!)).toEqual([1, 0, 2, 3]);
    expect(listing(parseVarStore(q.bytes!)).filter((l) => !l.startsWith('BootOrder ')).sort())
      .toEqual(listing(parseVarStore(full)).filter((l) => !l.startsWith('BootOrder ')).sort());
    keep('bootorder-reclaimed-rock4d', q.bytes!);
  });

  it('refuses an order that adds, drops or repeats an entry, and a store without BootOrder', () => {
    const s = parseVarStore(tspi);
    expect(() => bootOrderChange(s, [9, 10])).toThrow(BootOrderError);
    expect(() => bootOrderChange(s, [9, 10, 6, 7, 5, 11, 12, 0, 1, 2, 3, 4, 4])).toThrow(/exactly the entries/);
    expect(() => bootOrderChange(s, [9, 10, 6, 7, 5, 11, 12, 0, 1, 2, 3, 4, 13])).toThrow(/never added or removed/);
    expect(() => bootOrderChange(s, [9, 10, 6, 7, 5, 11, 12, 0, 1, 2, 3, 4, 1.5])).toThrow(/not a boot entry number/);
    expect(() => planSettings(freshVarStore(), { kind: 'edit', edits: {}, bootOrder: [0] }, opts, true)).toThrow(BootOrderError);
    expect(() => planSettings(new Uint8Array(0x30000).fill(0xff), { kind: 'edit', edits: {}, bootOrder: [0] }, opts, true)).toThrow(/no boot order/);
    // A Boot#### is never written through a settings write, even with a boot order asked for.
    expect(() => planSettings(tspi, { kind: 'edit', edits: { Boot0001: 1 } as Record<string, number>, bootOrder: [9] }, opts, true)).toThrow();
    // BootOrder with attributes other than NV+BS+RT is shown, not written.
    const odd = setVariables(tspi, [{ name: 'BootOrder', guid: GUID.globalVariable, attributes: 7, data: null }], () => true).bytes;
    const odd2 = setVariables(odd, [{ name: 'BootOrder', guid: GUID.globalVariable, attributes: 3, data: Uint8Array.of(9, 0, 10, 0) }], () => true).bytes;
    expect(readBootOrder(parseVarStore(odd2)).locked).toMatch(/attributes 0x3/);
    expect(() => bootOrderChange(parseVarStore(odd2), [10, 9])).toThrow(/not changed here/);
  });

  it('shows a listed entry that is not there as missing, and keeps it in the order', () => {
    const gone = setVariables(tspi, [{ name: 'Boot000C', guid: GUID.globalVariable, attributes: 7, data: null }], () => true).bytes;
    const r = readBootOrder(parseVarStore(gone));
    expect(r.entries.find((e) => e.number === 12)).toMatchObject({ missing: true, option: null });
    const order = moveEntry(r.order!, 6, 0);
    const p = planSettings(gone, { kind: 'edit', edits: {}, bootOrder: order }, opts, true);
    expect(bootOrderOf(p.bytes!)).toEqual(order);
  });
});
