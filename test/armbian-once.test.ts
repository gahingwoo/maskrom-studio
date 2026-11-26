// The ROCK 4D's firmware check before Armbian goes next to Windows
// (armbian-once.ts): the SPL on the SPI NOR flash must carry "ArmbianOnce/1".
import { describe, expect, it } from 'vitest';
import { ARMBIAN_ONCE_SPL_TAG, checkArmbianOnce, findTag, splSectors } from '../src/woa/armbian-once';
import { woaBoard, WOA_BOARDS } from '../src/woa/boards';
import { spiImage } from './edk2-fixture';

const rock4d = woaBoard('rock4d')!;
const reader = (img: Uint8Array, asked: Array<[number, number]> = []) => async (lba: number, sectors: number) => {
  asked.push([lba, sectors]);
  return img.slice(lba * 512, (lba + sectors) * 512);
};

describe('Armbian once on an SPI NOR board', () => {
  it('says which boards put Armbian where', () => {
    expect(Object.fromEntries(WOA_BOARDS.map((b) => [b.id, b.hybrid]))).toEqual({ tspi3m: 'one-emmc', cm5io: null, rock4d: 'nvme-and-sd' });
  });
  it('reads the SPL from sector 64 up to the firmware FIT', () => {
    expect(splSectors(rock4d)).toEqual({ lba: 64, sectors: 768 - 64 });
    expect(splSectors(woaBoard('tspi3m')!)).toBeNull();
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
