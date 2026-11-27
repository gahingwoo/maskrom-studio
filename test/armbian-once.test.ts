// The firmware check before Armbian goes next to Windows on an SD card
// (armbian-once.ts): the SPL on the ROCK 4D's SPI NOR flash, or on the
// CM5-IO's eMMC, must carry "ArmbianOnce/1".
import { describe, expect, it } from 'vitest';
import { ARMBIAN_ONCE_SPL_TAG, checkArmbianOnce, emmcStorageProblem, findTag, splSectors } from '../src/woa/armbian-once';
import { hybridOnSd, woaBoard, WOA_BOARDS } from '../src/woa/boards';
import { spiImage } from './edk2-fixture';

const rock4d = woaBoard('rock4d')!;
const cm5io = woaBoard('cm5io')!;
const reader = (img: Uint8Array, asked: Array<[number, number]> = []) => async (lba: number, sectors: number) => {
  asked.push([lba, sectors]);
  return img.slice(lba * 512, (lba + sectors) * 512);
};

describe('Armbian once on an SPI NOR board', () => {
  it('says which boards put Armbian where', () => {
    expect(Object.fromEntries(WOA_BOARDS.map((b) => [b.id, b.hybrid]))).toEqual({ tspi3m: 'one-emmc', cm5io: 'windows-and-sd', rock4d: 'nvme-and-sd' });
    expect(WOA_BOARDS.filter((b) => hybridOnSd(b.hybrid)).map((b) => b.id)).toEqual(['cm5io', 'rock4d']);
    expect(hybridOnSd(null)).toBe(false);
    // One disk for both: the TaishanPi 3M's eMMC, the CM5-IO's NVMe drive; the ROCK 4D has no eMMC slot.
    expect(Object.fromEntries(WOA_BOARDS.map((b) => [b.id, b.oneDisk]))).toEqual({ tspi3m: 'emmc', cm5io: 'nvme', rock4d: null });
    expect(WOA_BOARDS.every((b) => b.oneDisk !== 'nvme' || (b.windowsTargets.includes('nvme') && b.firmwareStorage === 'emmc' && !!b.emmc))).toBe(true);
  });
  it('the CM5-IO keeps its firmware on the eMMC and installs Windows to the eMMC or NVMe beside the card', () => {
    expect(cm5io.firmwareStorage).toBe('emmc');
    expect(cm5io.windowsTargets).toEqual(expect.arrayContaining(['emmc', 'nvme']));
  });
  it('reads the SPL from sector 64 up to the firmware FIT', () => {
    expect(splSectors(rock4d)).toEqual({ lba: 64, sectors: 768 - 64 });
    // On an eMMC board: the first MiB from sector 64, as the firmware searches it (ArmbianOnceSplTakesRequests).
    expect(splSectors(cm5io)).toEqual({ lba: 64, sectors: 2048 });
    expect(splSectors(woaBoard('tspi3m')!)).toEqual({ lba: 64, sectors: 2048 });
  });
  it('finds the tag anywhere in the bytes, and only the whole tag', () => {
    const t = new TextEncoder();
    expect(findTag(t.encode(`xxArmbianOnce/0 ArmbianOnce${ARMBIAN_ONCE_SPL_TAG}!`))).toBe(27);
    expect(findTag(t.encode('ArmbianOnce/'))).toBe(-1);
    expect(findTag(new Uint8Array(0))).toBe(-1);
  });
  it('passes the new SPL and names where the tag is', async () => {
    const asked: Array<[number, number]> = [];
    const img = spiImage({ spl: 'U-Boot SPL 2026.10-edk2-rk3576\0ArmbianOnce/1\0' });
    const r = await checkArmbianOnce(rock4d, reader(img, asked));
    expect(r).toEqual({ ok: true, offset: 0x3807c + 31 });
    expect(asked).toEqual([[64, 704]]);
  });
  it('refuses the SPL every ROCK 4D release has (U-Boot 2026.04, no one-shot), and an unreadable flash', async () => {
    const r = await checkArmbianOnce(rock4d, reader(spiImage({ spl: 'U-Boot SPL 2026.04-ge3405917a180' })));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^The firmware on this Radxa ROCK 4D cannot start Armbian from the SD card: its SPL \(SPI NOR flash, sectors 64 to 767\) has no "ArmbianOnce\/1".*Nothing was written\.$/);
    // A tag past the SPL (in the firmware FIT) does not count.
    const late = spiImage();
    late.set(new TextEncoder().encode(ARMBIAN_ONCE_SPL_TAG), 768 * 512 + 100);
    expect((await checkArmbianOnce(rock4d, reader(late))).ok).toBe(false);
    expect(await checkArmbianOnce(rock4d, async () => null)).toEqual({ ok: false, reason: 'The SPL could not be read from the Radxa ROCK 4D\'s SPI NOR flash. Nothing was written.' });
  });
});

describe('Armbian once on the CM5-IO (SPL on the eMMC)', () => {
  // An eMMC image's first 2 MiB: the SPL from sector 64, the request sector 0x3FFF zero.
  const emmc = (spl: string | null, at = 64 * 512 + 0x2f0a0) => {
    const img = new Uint8Array(2 * 1024 * 1024).fill(0x11);
    if (spl) img.set(new TextEncoder().encode(spl), at);
    return img;
  };
  it('passes the 0.5.0 SPL (U-Boot v2026.10 with the one-shot) and reads only the eMMC SPL', async () => {
    const asked: Array<[number, number]> = [];
    const r = await checkArmbianOnce(cm5io, reader(emmc('U-Boot SPL 2026.10-edk2-rk3576\0ArmbianOnce/1\0'), asked));
    expect(r).toEqual({ ok: true, offset: 64 * 512 + 0x2f0a0 + 31 });
    expect(asked).toEqual([[64, 2048]]);
  });
  it('refuses an older SPL and says to write the firmware first', async () => {
    const r = await checkArmbianOnce(cm5io, reader(emmc('U-Boot SPL 2026.04-ge3405917a180')));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^The firmware on this ArmSoM CM5-IO cannot start Armbian from the SD card: its SPL \(eMMC, sectors 64 to 2111\) has no "ArmbianOnce\/1".*0\.5\.0 or later.*Write the UEFI firmware to the board first.*Nothing was written\.$/);
    // A tag past the first MiB (the firmware FIT, or Windows) does not count.
    expect((await checkArmbianOnce(cm5io, reader(emmc(ARMBIAN_ONCE_SPL_TAG, (64 + 2048) * 512 + 10)))).ok).toBe(false);
    expect(await checkArmbianOnce(cm5io, async () => null)).toEqual({ ok: false, reason: 'The SPL could not be read from the ArmSoM CM5-IO\'s eMMC. Nothing was written.' });
  });
  it('reads only a storage the size of the board\'s eMMC', () => {
    expect(emmcStorageProblem(cm5io, 31272730624)).toBeNull();
    expect(emmcStorageProblem(cm5io, null)).toMatch(/cannot be confirmed to be the eMMC/);
    expect(emmcStorageProblem(cm5io, 16 * 1024 * 1024)).toMatch(/^The loader selected a storage of 16777216 bytes, not the size of the ArmSoM CM5-IO's eMMC/);
    expect(emmcStorageProblem(rock4d, 16 * 1024 * 1024)).toBeNull();
  });
});

// A real image: ROCK4D_SPI_IMAGE=/path/to/ROCK4D-spi.img (the rock4d-parity CI build passes, release builds do not).
describe.skipIf(!process.env.ROCK4D_SPI_IMAGE)('a real ROCK 4D SPI NOR image', () => {
  it('is checked the same way', async () => {
    const { readFileSync } = await import('node:fs');
    const img = new Uint8Array(readFileSync(process.env.ROCK4D_SPI_IMAGE!));
    const r = await checkArmbianOnce(rock4d, reader(img));
    console.log(process.env.ROCK4D_SPI_IMAGE, r);
    expect(typeof r.ok).toBe('boolean');
  });
});
