import { describe, expect, it } from 'vitest';
import { readArmbianImage, resizeLeavesTableAlone, minArmbianBytes, HybridError, SLOT_LBA, ATTR_LEGACY_BOOTABLE } from '../src/woa/armbian-hybrid';
import { SECTOR } from '../src/woa/gpt';
import { bytesSource } from '../src/woa/pieces';
import { fakeArmbian } from './armbian-fixture';

describe('Armbian image next to Windows', () => {
  it('finds the root partition and the U-Boot FIT', () => {
    const p = readArmbianImage(bytesSource(fakeArmbian()));
    expect(p.root.size).toBe(8192 * SECTOR);
    expect(p.uuid).toBe('bc108f2a-5a29-46ab-93ad-307780d7f4d9');
    expect(p.label).toBe('armbi_root');
    // Header (aligned) plus the last image's end, in whole sectors.
    expect(p.fit.size % SECTOR).toBe(0);
    expect(p.fit.size).toBeGreaterThanOrEqual(1140000);
    expect(p.fit.size).toBeLessThan(1140000 + 4096);
    expect(new DataView(p.fit.read(0, 4).buffer).getUint32(0)).toBe(0xd00dfeed);
  });

  it('refuses images it cannot put beside Windows', () => {
    expect(() => readArmbianImage(bytesSource(fakeArmbian({ parts: 2 })))).toThrow(/2 partitions/);
    expect(() => readArmbianImage(bytesSource(fakeArmbian({ magic: false })))).toThrow(/not ext4/);
    expect(() => readArmbianImage(bytesSource(fakeArmbian({ clean: false })))).toThrow(/cleanly/);
    expect(() => readArmbianImage(bytesSource(fakeArmbian({ fit: false })))).toThrow(HybridError);
    expect(() => readArmbianImage(bytesSource(new Uint8Array(4096)))).toThrow(HybridError);
  });

  it('keeps Armbian\'s resize away from the partition table when the partition ends at the end of the eMMC', () => {
    const disk = 121110528; // TaishanPi 3M
    expect(resizeLeavesTableAlone(disk - 34 - 2048, disk)).toBe(true);
    expect(resizeLeavesTableAlone(Math.floor(disk * 0.98), disk)).toBe(false);
  });

  it('asks for room beyond the root file system', () => {
    expect(minArmbianBytes(2e9, false)).toBe(4 * 1024 ** 3);
    expect(minArmbianBytes(6.2e9, true)).toBe(10 * 1024 ** 3);
    expect(minArmbianBytes(12e9, true)).toBe(13 * 1024 ** 3);
  });

  it('exports the slot and the bootable attribute the firmware and U-Boot expect', () => {
    expect(SLOT_LBA).toBe(0x10000);
    expect(ATTR_LEGACY_BOOTABLE).toBe(4n);
  });
});
