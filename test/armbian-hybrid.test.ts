import { describe, expect, it } from 'vitest';
import { readArmbianImage, resizeLeavesTableAlone, minArmbianBytes, HybridError, SLOT_LBA, ATTR_LEGACY_BOOTABLE, slotProblem, defaultArmbianBytes } from '../src/woa/armbian-hybrid';
import { buildGpt, SECTOR, TYPE_BASIC_DATA, TYPE_RK_FIRMWARE } from '../src/woa/gpt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('writes the slot only where the firmware would use it: no partition but "firmware" over sectors 0x10000..0x17FFF', () => {
    const disk = 31272730624 / 512; // CM5-IO
    const gpt = (parts: Parameters<typeof buildGpt>[0]['parts']) => buildGpt({ diskSectors: disk, diskGuid: 'd8d5f487-1251-4ec2-a557-f7e7889ee81e', keep: null, parts }).primary;
    // The eMMC image edk2-rk3576 ships: "firmware" 64..131071, "data" after it.
    expect(slotProblem(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'tspi3m-emmc-head.bin'))))).toBeNull();
    expect(slotProblem(gpt([
      { type: TYPE_RK_FIRMWARE, guid: '04fdd13a-19aa-4245-8b66-c02fafb5e121', firstLba: 64, lastLba: 131071, name: 'firmware' },
      { type: TYPE_BASIC_DATA, guid: '04fdd13a-19aa-4245-8b66-c02fafb5e122', firstLba: 131072, lastLba: disk - 34, name: 'data' },
    ]))).toBeNull();
    // The plain firmware image: no partition table at all.
    expect(slotProblem(new Uint8Array(34 * SECTOR))).toBeNull();
    // A Linux install on the eMMC from 16 MiB covers the slot.
    expect(slotProblem(gpt([{ type: TYPE_BASIC_DATA, guid: '04fdd13a-19aa-4245-8b66-c02fafb5e123', firstLba: 32768, lastLba: disk - 34, name: 'rootfs' }])))
      .toMatch(/^The eMMC partition "rootfs" \(sectors 32768 to \d+\) covers the firmware's slot for Armbian's U-Boot \(sectors 65536 to 98303\)\. Nothing was written\.$/);
    // So does an MBR partition; the protective entry of a GPT does not.
    const mbr = new Uint8Array(34 * SECTOR);
    const dv = new DataView(mbr.buffer);
    mbr[446 + 4] = 0x83; dv.setUint32(446 + 8, 98303, true); dv.setUint32(446 + 12, 1000, true);
    mbr[510] = 0x55; mbr[511] = 0xaa;
    expect(slotProblem(mbr)).toMatch(/^Partition 1 of the eMMC \(MBR, sectors 98303 to 99302\)/);
    dv.setUint32(446 + 8, 98304, true);
    expect(slotProblem(mbr)).toBeNull();
    // A damaged table cannot be judged.
    const bad = gpt([]);
    bad[SECTOR + 16] ^= 1;
    expect(slotProblem(bad)).toMatch(/cannot be read \(The partition table header is damaged/);
  });

  it('starts Armbian at half of an NVMe drive, leaving Windows at least 32 GB', () => {
    const GiB = 1024 ** 3;
    const free = (bytes: number) => (Math.floor(bytes / 512) - 34 - 2048) * 512;
    expect(defaultArmbianBytes(free(256e9), 4 * GiB)).toBe(119 * GiB);
    expect(defaultArmbianBytes(free(64e9), 4 * GiB)).toBe(27 * GiB);
    // Windows keeps its 32 GB before a desktop image gets its floor.
    expect(defaultArmbianBytes(free(48e9), 13 * GiB)).toBeNull();
    expect(defaultArmbianBytes(free(40e9), 4 * GiB)).toBe(4 * GiB);
    expect(defaultArmbianBytes(free(30e9), 4 * GiB)).toBeNull();
  });
});
