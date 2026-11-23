// The firmware upgrade's plan against made-up images and a pretend board:
// a 32 MiB image with a FIT at sector 16384 (written here as a flattened
// device tree), and the real eMMC head of a TaishanPi 3M for the partition
// table. Also the real released images when they are on this computer.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesSource } from '../src/woa/pieces';
import { findStamp, FIT_LBA, IMAGE_BYTES, isVariableStore, parseFit, readFirmware, SECTOR } from '../src/woa/edk2-image';
import { planUpgrade } from '../src/woa/upgrade-plan';
import { edk2Image as image, store } from './edk2-fixture';

const head = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'tspi3m-emmc-head.bin')));


/** The board's reads; `nvUnreadable`: the settings slot never reads (the retries are maskrom-regions.ts's). */
function board(emmc: Uint8Array, nvUnreadable = false) {
  return {
    capacity: 62008590336, head, manufacturer: 'SAMSUNG',
    read: async (lba: number, n: number) => (nvUnreadable && lba === 43648 ? null : emmc.slice(lba * SECTOR, (lba + n) * SECTOR)),
  };
}

describe('an edk2-rk3576 image', () => {
  it('finds the FIT, the settings slot and the build stamp', async () => {
    const img = image();
    expect(parseFit(img.subarray(FIT_LBA * SECTOR, FIT_LBA * SECTOR + 8192))).toMatchObject({ config: 'rk3576-lckfb-tspi-3m', images: { nvdata: { offset: 0xd4f000, size: 0x30000 } } });
    const info = await readFirmware((o, n) => img.subarray(o, o + n));
    expect(info).toMatchObject({ version: '0.4.2', board: 'tspi3m', nvdata: { lba: 43648, sectors: 384 }, edk2: { lba: 17024 } });
    expect(findStamp(new Uint8Array(100))).toBeNull();
    expect(isVariableStore(store())).toBe(true);
  });
  const real = ['/home/parallels/Desktop/tspi3m-backup/release-0.3.0-tspi3m.1/TaishanPi3M-emmc-edk2-0.3.0-tspi3m.1.img'];
  it.skipIf(!existsSync(real[0]))('reads a released image', async () => {
    const b = new Uint8Array(readFileSync(real[0]));
    expect(await readFirmware((o, n) => b.subarray(o, o + n))).toMatchObject({ version: '0.3.0-tspi3m.1-2-g754030b', board: 'tspi3m', nvdata: { lba: 43648, sectors: 384 } });
  });
});

describe('the upgrade plan', () => {
  const run = async (emmc: Uint8Array, next: Uint8Array, keep = true, nvUnreadable = false) => {
    const saved: Uint8Array[] = [];
    const r = await planUpgrade({
      boardId: 'tspi3m', image: bytesSource(next), probe: board(emmc, nvUnreadable), keepSettings: keep, log: () => {},
      saveBackup: async (d) => { saved.push(d); return { path: '/backups/tspi3m-nvdata.bin' }; },
    });
    return { r, saved };
  };

  it('writes from sector 64 with the board\'s settings in the empty slot, after saving them', async () => {
    const emmc = image({ version: '0.4.1', nvdata: store() });
    const next = image({ version: '0.4.2' });
    const { r, saved } = await run(emmc, next, true);
    if ('stop' in r) throw new Error(r.stop);
    expect(r.summary).toMatchObject({ installed: '0.4.1', next: '0.4.2', settings: 'kept', backup: '/backups/tspi3m-nvdata.bin', manufacturer: 'SAMSUNG', lba: 64, nvdataLba: 43648 });
    expect(saved[0]).toEqual(store());
    expect(r.regions).toHaveLength(1);
    const g = r.regions[0];
    expect(g.lba).toBe(64);
    expect(g.source.size).toBe(IMAGE_BYTES - 64 * SECTOR);
    // The slot carries the board's store, everything else is the new image.
    expect(g.source.read((43648 - 64) * SECTOR, 0x30000)).toEqual(store());
    expect(g.source.read(0, 4096)).toEqual(next.slice(64 * SECTOR, 64 * SECTOR + 4096));
    expect(g.source.read((43648 - 64) * SECTOR + 0x30000, 512)).toEqual(next.slice(43648 * SECTOR + 0x30000, 43648 * SECTOR + 0x30000 + 512));
  });
  it('writes the image as it is when the settings are reset', async () => {
    const { r, saved } = await run(image({ nvdata: store() }), image(), false);
    if ('stop' in r) throw new Error(r.stop);
    expect(r.summary.settings).toBe('reset');
    expect(saved).toHaveLength(0);
    expect(r.regions[0].source.read((43648 - 64) * SECTOR, 16)).toEqual(new Uint8Array(16).fill(0xff));
  });
  it('says so when the board has no settings saved', async () => {
    const { r } = await run(image(), image(), true);
    if ('stop' in r) throw new Error(r.stop);
    expect(r.summary.settings).toBe('none');
  });
  it('refuses another board\'s image, another layout, a slot that is not a store, an unreadable slot, no firmware layout', async () => {
    expect((await run(image(), image({ dt: 'rk3576-armsom-cm5-io' }))).r).toMatchObject({ stop: expect.stringMatching(/rk3576-armsom-cm5-io, not this board/) });
    expect((await run(image(), image({ stamp: 'CM5IO' }))).r).toMatchObject({ stop: expect.stringMatching(/not this board/) });
    expect((await run(image({ nvdata: store() }), image({ nvOffset: 0xd50000 }))).r).toMatchObject({ stop: expect.stringMatching(/sector 43648 on the board but at 43656/) });
    expect((await run(image({ nvdata: new Uint8Array(0x30000).fill(1) }), image())).r).toMatchObject({ stop: expect.stringMatching(/not a variable store/) });
    expect((await run(image(), image(), true, true)).r).toMatchObject({ stop: expect.stringMatching(/could not be read/) });
    const noFit = new Uint8Array(IMAGE_BYTES);
    expect((await run(noFit, image())).r).toMatchObject({ stop: expect.stringMatching(/does not hold edk2-rk3576 firmware/) });
    const r = await planUpgrade({ boardId: 'tspi3m', image: bytesSource(image()), probe: { ...board(image()), head: new Uint8Array(34 * 512) }, keepSettings: true, log: () => {}, saveBackup: async () => ({ path: 'x' }) });
    expect(r).toMatchObject({ stop: expect.stringMatching(/partition layout/) });
    expect((await run(image(), image().slice(0, 1 << 20))).r).toMatchObject({ stop: expect.stringMatching(/eMMC image is 33554432/) });
  });
});

// The whole upgrade through the real rkdeveloptool WASM against the pretend board of fake-rockchip.ts.
import { pathToFileURL } from 'node:url';
import { FakeBoard } from './fake-rockchip';
import { syntheticLoader } from './synthetic-loader';
import { createRunner } from '../src/maskrom/runner';
import { writeRegions } from '../src/woa/maskrom-regions';

const WASM_DIR = new URL('../vendor/rkdeveloptool-wasm/', import.meta.url);
describe.skipIf(!existsSync(new URL('rkdeveloptool.wasm', WASM_DIR)))('the upgrade over MaskROM', () => {
  it('keeps sectors 0 to 63 and the settings, and compares everything it wrote', async () => {
    const fake = new FakeBoard({ storages: { 1: 64 * 1024 * 1024 }, defaultStorage: 1 });
    const disk = fake.storages.get(1)!;
    const old = image({ version: '0.4.1', nvdata: store() });
    disk.write(0, old);
    disk.write(0, head);
    Object.defineProperty(globalThis.navigator, 'usb', { value: fake.usb(), configurable: true });
    const mod = await import(pathToFileURL(new URL('rkdeveloptool.js', WASM_DIR).pathname).href);
    const runner = await createRunner(mod.default, { log: () => {}, wasmBinary: readFileSync(new URL('rkdeveloptool.wasm', WASM_DIR)) });
    const next = image({ version: '0.4.2' });
    let summary: unknown = null;
    const res = await writeRegions(runner, {
      loader: syntheticLoader(), readHead: true, spotCheck: false, resetAfter: true, reconnectTimeout: 5000, checkHeadBytes: IMAGE_BYTES,
      plan: (p) => planUpgrade({ boardId: 'tspi3m', image: bytesSource(next), probe: p, keepSettings: true, log: () => {}, saveBackup: async () => ({ path: '/b.bin' }) }),
      confirm: async (s) => { summary = s; return true; },
    }, { stage: () => {}, progress: () => {}, log: () => {}, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))), cancelled: () => false });
    expect(res).toMatchObject({ ok: true, checks: { headBytes: IMAGE_BYTES - 64 * SECTOR } });
    expect(summary).toMatchObject({ installed: '0.4.1', next: '0.4.2', settings: 'kept' });
    const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;
    expect(same(disk.read(0, 34 * SECTOR), head.slice(0, 34 * SECTOR))).toBe(true);
    expect(same(disk.read(34 * SECTOR, 30 * SECTOR), old.slice(34 * SECTOR, 64 * SECTOR))).toBe(true);
    expect(same(disk.read(43648 * SECTOR, 0x30000), store())).toBe(true);
    expect(same(disk.read(64 * SECTOR, 43584 * SECTOR), next.slice(64 * SECTOR, 43648 * SECTOR))).toBe(true);
    expect(fake.resets).toBe(1);
  }, 60000);
});
