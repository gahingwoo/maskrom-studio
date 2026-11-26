// The ROCK 4D's firmware on its SPI NOR flash: the image check, the two
// firmware choices (whole flash, keep the settings) and the copy taken first.
import { describe, expect, it } from 'vitest';
import { firmwareTargets, woaBoard } from '../src/woa/boards';
import { firmwareRegions } from '../src/woa/firmware-plan';
import { checkSpiImage } from '../src/woa/spi-image';
import { readSpiPreWriteBackup } from '../src/woa/pre-write-backup';
import { bytesSource } from '../src/woa/pieces';
import { edk2Image, spiImage, store } from './edk2-fixture';

const b = woaBoard('rock4d')!;
const MiB = 1024 * 1024;
const whole = firmwareTargets(b).find((t) => t.id === 'uefi')!;
const keep = firmwareTargets(b).find((t) => t.id === 'uefi-keep')!;
/** probe.read over a pretend flash. */
const reader = (flash: Uint8Array) => async (lba: number, sectors: number) => flash.slice(lba * 512, (lba + sectors) * 512);

describe('ROCK 4D SPI NOR firmware', () => {
  it('offers the whole flash and "keep the settings", which stops at sector 32256', () => {
    expect(firmwareTargets(b).map((t) => [t.id, t.lba, t.slice ?? null])).toEqual([
      ['uefi', 0, null], ['uefi-keep', 0, [0, 32256 * 512]],
    ]);
    expect(keep.file).toBe(whole.file);
    expect(b.spi).toEqual({ bytes: 16 * MiB, fitLba: 768, nvdataLba: 32256 });
  });

  it('accepts the ROCK 4D image and refuses others', async () => {
    expect(await checkSpiImage(bytesSource(spiImage()), b)).toMatchObject({ board: 'rock4d', version: '0.4.2', dt: 'rk3576-rock-4d' });
    expect(await checkSpiImage(bytesSource(edk2Image()), b)).toMatch(/33554432 bytes|is 33554432/);
    expect(await checkSpiImage(bytesSource(spiImage({ dt: 'rk3576-armsom-cm5-io', stamp: 'CM5IO' })), b)).toMatch(/not the Radxa ROCK 4D/);
    expect(await checkSpiImage(bytesSource(spiImage({ settings: store() })), b)).toMatch(/erased/);
    expect(await checkSpiImage(bytesSource(new Uint8Array(16 * MiB)), b)).toMatch(/no FIT/);
  });

  it('writes the whole flash only when the loader selected a 16 MiB storage', async () => {
    const image = bytesSource(spiImage());
    const r = await firmwareRegions(b, whole, image, { capacity: 16 * MiB, head: null });
    if ('stop' in r) throw new Error(r.stop);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0]).toMatchObject({ lba: 0 });
    expect(r.regions[0].source.size).toBe(16 * MiB);
    expect(r.summary.spi).toEqual({ next: '0.4.2', installed: null, settings: 'reset' });
    // A UFS module, or an eMMC board connected by mistake.
    expect(await firmwareRegions(b, whole, image, { capacity: 64e9, head: null })).toMatchObject({ stop: expect.stringMatching(/not the Radxa ROCK 4D's 16.0 MiB SPI NOR/) });
    expect(await firmwareRegions(b, whole, image, { capacity: null, head: null })).toMatchObject({ stop: expect.stringMatching(/cannot be confirmed/) });
  });

  it('keeps the settings: writes sectors 0..32255 and never the store', async () => {
    const flash = spiImage({ version: '0.4.1', settings: store() });
    const r = await firmwareRegions(b, keep, bytesSource(spiImage()), { capacity: 16 * MiB, head: null, read: reader(flash) });
    if ('stop' in r) throw new Error(r.stop);
    expect(r.regions[0].lba).toBe(0);
    expect(r.regions[0].source.size).toBe(32256 * 512);
    expect(r.summary.spi).toEqual({ next: '0.4.2', installed: 'rk3576-rock-4d', settings: 'kept' });
    // A board that never saved a setting: the erased area stays erased.
    const fresh = await firmwareRegions(b, keep, bytesSource(spiImage()), { capacity: 16 * MiB, head: null, read: reader(spiImage()) });
    expect(fresh).toMatchObject({ summary: { spi: { settings: 'none' } } });
  });

  it('refuses to keep settings that the new firmware could not read', async () => {
    const img = bytesSource(spiImage());
    const p = (flash: Uint8Array) => ({ capacity: 16 * MiB, head: null, read: reader(flash) });
    // Radxa's U-Boot SPI image, or an empty flash: no edk2-rk3576 FIT.
    expect(await firmwareRegions(b, keep, img, p(new Uint8Array(16 * MiB)))).toMatchObject({ stop: expect.stringMatching(/does not hold edk2-rk3576 firmware/) });
    const junk = spiImage({ settings: new Uint8Array(0x30000).fill(0x5a) });
    expect(await firmwareRegions(b, keep, img, p(junk))).toMatchObject({ stop: expect.stringMatching(/not a UEFI variable store/) });
    const other = spiImage({ dt: 'rk3576-armsom-cm5-io', settings: store() });
    expect(await firmwareRegions(b, keep, img, p(other))).toMatchObject({ stop: expect.stringMatching(/for rk3576-armsom-cm5-io/) });
    expect(await firmwareRegions(b, keep, img, { capacity: 16 * MiB, head: null })).toMatchObject({ stop: expect.stringMatching(/cannot be read/) });
  });

  it('copies the whole flash, and the settings on their own, before writing', async () => {
    const flash = spiImage({ settings: store() });
    const logs: string[] = [];
    const c = await readSpiPreWriteBackup(b, { capacity: 16 * MiB, head: null, read: reader(flash) }, (l) => logs.push(l), new Date(0));
    expect(c!.files.map((f) => [f.name, f.data.length])).toEqual([['spi-nor-before.bin', 16 * MiB], ['nvdata-spi-sector-32256-384.bin', 0x30000]]);
    expect(Buffer.compare(Buffer.from(c!.files[0].data), Buffer.from(flash))).toBe(0);
    expect(c!.settings).toBe('kept');
    expect(c!.notes.join('\n')).toMatch(/wl 0 spi-nor-before\.bin/);
    const empty = await readSpiPreWriteBackup(b, { capacity: 16 * MiB, head: null, read: reader(spiImage()) }, () => {});
    expect(empty!.files.map((f) => f.name)).toEqual(['spi-nor-before.bin']);
    expect(empty!.settings).toBe('empty');
    expect(await readSpiPreWriteBackup(b, { capacity: 16 * MiB, head: null, read: async () => null }, () => {})).toBeNull();
  });
});
