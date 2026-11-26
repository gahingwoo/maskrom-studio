// The firmware's settings list (FEATURES.json "settings", made from a real
// edk2-rk3576 build: test/fixtures/edk2-features.json) applied to a real
// TaishanPi 3M store (uefi-vars.test.ts says where it comes from), and the
// settings put into firmware writes (settings-board.ts, upgrade-plan.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { changesFor, evalCondition, planSettings, resetChanges, sameFirmware, settingOptions, settingRows, SettingsError, type SettingOption } from '../src/woa/uefi-settings';
import { findVariable, freshVarStore, isErasedArea, NV_REGION_BYTES, parseVarStore, VarStoreError } from '../src/woa/uefi-vars';
import { readBoardArea, withFlashSettings } from '../src/woa/settings-board';
import { planUpgrade } from '../src/woa/upgrade-plan';
import { bytesSource } from '../src/woa/pieces';
import { firmwareTargets, woaBoard } from '../src/woa/boards';
import { SECTOR } from '../src/woa/edk2-image';
import { edk2Image, spiImage } from './edk2-fixture';

const features = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'edk2-features.json'), 'utf8'));
const store = (name: string): Uint8Array => new Uint8Array(gunzipSync(readFileSync(join(__dirname, 'fixtures', `nvdata-${name}.bin.gz`))));
const head = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'tspi3m-emmc-head.bin')));
/** Byte equality without vitest's element-by-element diff (these are up to 16 MiB). */
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const RK = '8b4f2e3d-ac5e-4f9b-c2d6-3e7e9f1b4d8c';
const opts = (b = 'TaishanPi3M') => settingOptions(features.boards[b].settings) as SettingOption[];
const value = (area: Uint8Array, name: string, guid = RK) => findVariable(parseVarStore(area), name, guid).cur?.data;

describe('the settings list', () => {
  it('reads the 50 options of each board, and says why when there is none', () => {
    for (const b of ['TaishanPi3M', 'CM5IO', 'ROCK4D']) expect(opts(b).length).toBe(50);
    const fan = opts().find((o) => o.id === 'AcpiFanControl')!;
    expect(fan).toMatchObject({ type: 'oneof', offset: 0, width: 1, default: 0, variable: { name: 'AcpiFanControl', guid: RK, attributes: 7, size: 1 } });
    expect(fan.values.map((v) => v.value)).toEqual([0, 2, 1, 3, 4]);
    expect(fan.boardSupport).toEqual({ variable: 'AcpiFanControlSupported', value: 1 });
    expect(settingOptions(undefined)).toMatch(/0\.4\.1 and older/);
    expect(settingOptions({ schema: 2, options: [] })).toMatch(/schema 2; this app reads schema 1/);
  });

  it('evaluates the menu conditions, unknown where a value is not known', () => {
    const v = (vals: Record<string, number>) => (n: string, o: number) => vals[`${n}@${o}`] ?? null;
    expect(evalCondition('((ConfigTableMode@0 & 1) == 0)', v({ 'ConfigTableMode@0': 2 }))).toBe(true);
    expect(evalCondition('((ConfigTableMode@0 & 1) == 0)', v({ 'ConfigTableMode@0': 3 }))).toBe(false);
    expect(evalCondition('A@0 == 0 and B@0 == 0', v({ 'A@0': 0 }))).toBe(null);
    expect(evalCondition('A@0 == 0 and B@0 == 0', v({ 'A@0': 1 }))).toBe(false);
    expect(evalCondition('A@0 == 0 or B@0 == 0', v({ 'B@0': 0 }))).toBe(true);
    expect(evalCondition('((DisplayConnectorsMask@0 & (32 | 64)) == 0)', v({ 'DisplayConnectorsMask@0': 64 }))).toBe(false);
    expect(evalCondition('DisplayModePreset@0 != 2147483649', v({ 'DisplayModePreset@0': 2147483649 }))).toBe(false);
    expect(evalCondition('not (1 == 0)', v({}))).toBe(true);
    expect(evalCondition('expression not decoded', v({}))).toBe(null);
  });
});

describe('the board\'s settings', () => {
  const board = { store: parseVarStore(store('tspi3m')), sameFirmware: true };

  it('shows the value on the board next to the default, and locks what must not be changed here', () => {
    const rows = settingRows(opts(), board);
    const row = (id: string) => rows.find((r) => r.option.id === id)!;
    expect(row('ConfigTableMode')).toMatchObject({ current: 3, effective: 3, locked: null });
    expect(row('DisplayBrightness')).toMatchObject({ current: 60, locked: null });
    // Not on the board yet, but one byte the list describes in full: it can be created.
    expect(row('UsbcDp')).toMatchObject({ current: null, effective: 0, locked: null });
    // This build has no power key support (PcdAcpiPwrKeySupported FALSE).
    expect(row('AcpiPwrKey').locked).toEqual({ code: 'unsupported' });
    expect(row('FdtOverrideBasePath@0').locked).toEqual({ code: 'kind' });
    // A variable whose size on the board differs from the list's is another layout.
    const other = opts().map((o) => (o.id === 'ConfigTableMode' ? { ...o, variable: { ...o.variable, size: 8 }, width: 4 } : o));
    expect(settingRows(other, board).find((r) => r.option.id === 'ConfigTableMode')!.locked).toEqual({ code: 'layout', board: 4, release: 8 });
    // Not the firmware the list was made for: nothing is created.
    expect(settingRows(opts(), { ...board, sameFirmware: false }).find((r) => r.option.id === 'UsbcDp')!.locked).toEqual({ code: 'missing' });
    // DisplayModeCustom: the list does not describe bytes 0..3 and 48..55, so it is never built from scratch.
    expect(settingRows(opts(), { store: null, sameFirmware: true }).find((r) => r.option.id === 'DisplayModeCustom@4')!.locked).toEqual({ code: 'missing' });
    // The ACPI options are hidden in the menu while the tables are Device Tree only.
    expect(settingRows(opts(), board, { ConfigTableMode: 2 }).find((r) => r.option.id === 'AcpiFanControl')!.hidden).toBe(true);
    expect(row('AcpiFanControl').hidden).toBe(false);
  });

  it('turns edits into variable writes, a field at a time, and refuses values the option does not take', () => {
    const c = changesFor(opts(), board, { AcpiFanControl: 3, 'DisplayModeCustom@8': 1920, ConfigTableMode: 3 });
    expect(c.map((x) => x.name)).toEqual(['AcpiFanControl', 'DisplayModeCustom']);
    const before = findVariable(board.store, 'DisplayModeCustom', RK).cur!.data;
    const dm = c[1].data!;
    expect(new DataView(dm.buffer).getUint32(8, true)).toBe(1920);
    expect([...dm.subarray(0, 8), ...dm.subarray(12)]).toEqual([...before.subarray(0, 8), ...before.subarray(12)]);
    expect(() => changesFor(opts(), board, { AcpiFanControl: 9 })).toThrow(SettingsError);
    expect(() => changesFor(opts(), board, { DisplayBrightness: 65 })).toThrow(/not a step of 10/);
    expect(() => changesFor(opts(), board, { DisplayBrightness: 110 })).toThrow(/above 100/);
    expect(() => changesFor(opts(), board, { AcpiPwrKey: 1 })).toThrow(/cannot be changed here \(unsupported\)/);
    expect(() => changesFor(opts(), board, { Nonsense: 1 })).toThrow(/not one of this firmware's settings/);
  });

  it('plans an edit, a reset to defaults and a restore, and nothing when nothing changes', () => {
    const area = store('tspi3m');
    const e = planSettings(area, { kind: 'edit', edits: { AcpiFanControl: 4, UsbcDp: 1 } }, opts(), true);
    expect(e.variables).toEqual(['AcpiFanControl', 'UsbcDp']);
    expect(value(e.bytes!, 'AcpiFanControl')).toEqual(Uint8Array.of(4));
    expect(value(e.bytes!, 'UsbcDp')).toEqual(Uint8Array.of(1));
    // Boot entries and every other variable as they were.
    const others = (b: Uint8Array) => parseVarStore(b).live.filter((r) => r.name !== 'AcpiFanControl' && r.name !== 'UsbcDp').map((r) => [r.name, r.guid, [...r.data]]);
    expect(others(e.bytes!)).toEqual(others(area));
    expect(planSettings(area, { kind: 'edit', edits: { AcpiFanControl: 0 } }, opts(), true).bytes).toBeNull();

    const r = planSettings(e.bytes!, { kind: 'reset' }, opts(), true);
    const listed = new Set(opts().map((o) => o.variable.name));
    const live = parseVarStore(r.bytes!).live;
    expect(live.some((x) => listed.has(x.name))).toBe(false);
    expect(live.map((x) => x.name)).toContain('BootOrder');
    expect(resetChanges(opts(), parseVarStore(area)).every((c) => c.data === null)).toBe(true);

    const back = planSettings(r.bytes!, { kind: 'restore', area }, opts(), true);
    expect(sameBytes(back.bytes!, area)).toBe(true);
    expect(planSettings(area, { kind: 'restore', area }, opts(), true).bytes).toBeNull();
    expect(() => planSettings(area, { kind: 'restore', area: new Uint8Array(NV_REGION_BYTES) }, opts(), true)).toThrow(VarStoreError);
  });

  it('makes a new store with only the edited variables when the area is erased', () => {
    const p = planSettings(new Uint8Array(NV_REGION_BYTES).fill(0xff), { kind: 'edit', edits: { AcpiFanControl: 1 } }, opts(), true);
    expect(parseVarStore(p.bytes!).live.map((x) => x.name)).toEqual(['AcpiFanControl']);
    expect(p.bytes!.subarray(0, 0x64)).toEqual(freshVarStore().subarray(0, 0x64));
  });

  it('matches the firmware by its build stamp', () => {
    expect(sameFirmware('rk3576-TaishanPi3M-eaa3a34', features.boards.TaishanPi3M.firmwareVersion)).toBe(true);
    expect(sameFirmware('rk3576-TaishanPi3M-0.4.1', features.boards.TaishanPi3M.firmwareVersion)).toBe(false);
    expect(sameFirmware(null, 'x')).toBe(false);
  });
});

describe('on the board and in firmware writes', () => {
  const tspi = woaBoard('tspi3m')!;
  const rock = woaBoard('rock4d')!;
  const brief = (x: Awaited<ReturnType<typeof readBoardArea>>) => (typeof x === 'string' ? x : { lba: x.lba, stamp: x.stamp, problem: x.problem });
  const reader = (disk: Uint8Array) => async (lba: number, n: number) => disk.slice(lba * SECTOR, (lba + n) * SECTOR);

  it('reads the area and the stamp from the eMMC and from the SPI NOR flash', async () => {
    const e = await readBoardArea(tspi, reader(edk2Image({ nvdata: store('tspi3m'), version: 'eaa3a34' })));
    expect(brief(e)).toMatchObject({ lba: 43648, stamp: 'rk3576-TaishanPi3M-eaa3a34', problem: null });
    const s = await readBoardArea(rock, reader(spiImage({ settings: store('rock4d') })));
    expect(brief(s)).toMatchObject({ lba: 32256, stamp: 'rk3576-ROCK4D-0.4.2', problem: null });
    expect(brief(await readBoardArea(tspi, reader(edk2Image())))).toMatchObject({ problem: 'erased' });
    const broken = store('tspi3m'); broken[0x10000 + 16] ^= 1;
    expect(brief(await readBoardArea(tspi, reader(edk2Image({ nvdata: broken }))))).toMatchObject({ problem: expect.stringMatching(/FTW working block/) });
    expect(await readBoardArea(tspi, reader(new Uint8Array(32 << 20)))).toMatch(/does not hold edk2-rk3576 firmware/);
  });

  it('sets values in the erased slot of a whole image, or adds the board\'s edited area to a write that keeps it', async () => {
    const s = { options: opts('ROCK4D'), edits: { AcpiFanControl: 3 } };
    const img = spiImage();
    const whole = firmwareTargets(rock).find((t) => t.id === 'uefi')!;
    const w = await withFlashSettings(rock, whole, bytesSource(img), [{ lba: 0, source: bytesSource(img), label: 'x' }], undefined, s, () => {});
    if ('stop' in w) throw new Error(w.stop);
    expect(w.regions.length).toBe(1);
    expect(value(w.regions[0].source.read(32256 * SECTOR, NV_REGION_BYTES), 'AcpiFanControl')).toEqual(Uint8Array.of(3));
    expect(sameBytes(w.regions[0].source.read(0, 32256 * SECTOR), img.subarray(0, 32256 * SECTOR))).toBe(true);

    const keep = firmwareTargets(rock).find((t) => t.id === 'uefi-keep')!;
    const flash = spiImage({ settings: store('rock4d') });
    const k = await withFlashSettings(rock, keep, bytesSource(img), [{ lba: 0, source: bytesSource(img.slice(0, 32256 * SECTOR)), label: 'x' }], reader(flash), s, () => {});
    if ('stop' in k) throw new Error(k.stop);
    expect(k.regions.map((r) => [r.lba, r.source.size])).toEqual([[0, 32256 * SECTOR], [32256, NV_REGION_BYTES]]);
    const area = k.regions[1].source.read(0, NV_REGION_BYTES);
    expect(value(area, 'AcpiFanControl')).toEqual(Uint8Array.of(3));
    expect(parseVarStore(area).live.length).toBe(parseVarStore(store('rock4d')).live.length);

    const bad = await withFlashSettings(rock, keep, bytesSource(img), [{ lba: 0, source: bytesSource(img.slice(0, 32256 * SECTOR)), label: 'x' }], reader(flash), { ...s, edits: { AcpiFanControl: 7 } }, () => {});
    expect(bad).toMatchObject({ stop: expect.stringMatching(/not one of its values\. Nothing was written\./) });
  });

  it('sets values with an upgrade, in the kept settings or in the new image\'s slot', async () => {
    const disk = edk2Image({ nvdata: store('tspi3m'), version: '0.4.1' });
    disk.set(head, 0);
    const probe = { capacity: 62008590336, head, read: reader(disk) };
    const settings = { options: opts(), edits: { AcpiFanControl: 2 } };
    const image = bytesSource(edk2Image({ version: 'eaa3a34' }));
    for (const keepSettings of [true, false]) {
      const p = await planUpgrade({ boardId: 'tspi3m', image, probe, keepSettings, log: () => {}, saveBackup: async () => ({ path: '/tmp/x' }), settings });
      if ('stop' in p) throw new Error(p.stop);
      expect(p.summary.applied).toEqual(['AcpiFanControl']);
      const slot = p.regions[0].source.read((43648 - 64) * SECTOR, NV_REGION_BYTES);
      expect(isErasedArea(slot)).toBe(false);
      expect(value(slot, 'AcpiFanControl')).toEqual(Uint8Array.of(2));
      // Kept: every other variable of the board is there; reset: only the one set.
      expect(parseVarStore(slot).live.length).toBe(keepSettings ? parseVarStore(store('tspi3m')).live.length : 1);
    }
  });
});
