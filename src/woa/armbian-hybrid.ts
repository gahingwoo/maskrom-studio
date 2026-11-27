// Armbian next to Windows on one eMMC, started by the firmware's one-shot
// boot option "Armbian (U-Boot)" (edk2-rk3576 docs/ARMBIAN-CHAINLOAD.md).
// Pure: reads Armbian's own disk image (as Armbian publishes it, decompressed)
// and says what goes where. See docs/dev/hybrid-and-presets.md.
//
// From Armbian's image two things are used, nothing else:
//   - its one root partition (ext4), copied byte for byte into a partition at
//     the end of the eMMC. Its file system UUID stays: /etc/fstab and
//     rootdev= in /boot/armbianEnv.txt name it, so nothing inside changes.
//   - its U-Boot FIT (at sector 16384 of the image, inside the
//     u-boot-rockchip.bin Armbian writes from sector 64), copied into the
//     firmware's slot at eMMC sector 0x10000. The firmware lists "Armbian
//     (U-Boot)" only when it finds a U-Boot there (or on an SD card, USB or
//     NVMe disk), and its SPL loads the slot once on request. A bad copy is
//     harmless: the SPL checks the FIT's hashes and falls back to the
//     firmware, and the firmware copies the FIT again from the root file
//     system (/usr/lib/linux-u-boot-*/u-boot-rockchip.bin) when it differs.
//
// Armbian's own resize (armbian-resize-filesystem) grows the root partition
// with fdisk keystrokes meant for MBR when the partition is the last one and
// ends before 99% of the disk. Ours ends within the last MiB of the eMMC, so
// its arithmetic always says "shrink" and leaves the table alone; it then
// runs resize2fs, which grows the file system to the partition we made.

import { parsePrimaryGpt, SECTOR, TYPE_RK_FIRMWARE, type GptPartition } from './gpt';
import { ESP_MIB, GiB, MIN_WINDOWS_CHOSEN, MiB, MSR_MIB } from './windows-layout';
import { parseFit } from './edk2-image';
import { sliceSource, type ByteSource } from './pieces';

/** Linux root (arm64), as Armbian marks it, and the generic Linux file system type. */
export const TYPE_LINUX_ROOT_ARM64 = 'b921b045-1df0-41c3-af44-4c6f280d3fae';
export const TYPE_LINUX_FS = '0fc63daf-8483-4772-8e79-3d69d8477de4';
/** GPT attribute bit 2, "legacy BIOS bootable": U-Boot's bootflow scans such a partition first. */
export const ATTR_LEGACY_BOOTABLE = 4n;
/** Where Armbian's image keeps its U-Boot FIT, and the firmware's slot for a copy of it. */
export const ARMBIAN_FIT_LBA = 16384;
export const SLOT_LBA = 0x10000;
export const SLOT_SECTORS = 0x8000;
/** The smallest Armbian partition beside Windows: room for the first start and some packages. */
export const MIN_ARMBIAN_BYTES = 4 * 1024 ** 3;
/** A desktop needs more: the image plus about 4 GiB, as minimumDiskBytes for a whole disk. */
export const MIN_ARMBIAN_DESKTOP_BYTES = 10 * 1024 ** 3;

export class HybridError extends Error {}

export interface ArmbianParts {
  /** The root partition's bytes in the image. */
  root: ByteSource;
  /** Armbian's U-Boot FIT, whole sectors. */
  fit: ByteSource;
  /** The ext4 file system's UUID, as Linux prints it. */
  uuid: string;
  label: string;
}

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function uuidText(b: Uint8Array): string {
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The FIT's length: the header, 4-byte aligned, then its images' data (data-offset is from the header's end). */
export function fitLength(head: Uint8Array): number | string {
  const fit = parseFit(head);
  if (typeof fit === 'string') return 'Armbian\'s image has no U-Boot FIT at sector 16384.';
  const names = Object.keys(fit.images);
  if (!names.some((n) => /u-?boot/i.test(n)) || !names.some((n) => /atf|bl31/i.test(n))) {
    return 'The FIT at sector 16384 of Armbian\'s image is not a U-Boot FIT (no U-Boot and BL31 images in it).';
  }
  const base = (fit.totalsize + 3) & ~3;
  return Math.max(base, ...Object.values(fit.images).map((i) => base + i.offset + i.size));
}

/** Armbian's root partition and U-Boot FIT from its disk image, or why the image cannot be used. */
export function readArmbianImage(image: ByteSource): ArmbianParts {
  if (image.size < 34 * SECTOR || image.size % SECTOR) throw new HybridError('The Armbian image is not a disk image.');
  let parts: GptPartition[];
  try {
    parts = parsePrimaryGpt(image.read(0, 34 * SECTOR)).partitions;
  } catch (e) {
    throw new HybridError(`The Armbian image has no GPT partition table it can be read by: ${(e as Error).message}`);
  }
  if (parts.length !== 1) {
    throw new HybridError(`The Armbian image has ${parts.length} partitions; only images with one root partition (no separate boot partition) can go next to Windows.`);
  }
  const p = parts[0];
  if (p.type !== TYPE_LINUX_ROOT_ARM64 && p.type !== TYPE_LINUX_FS) throw new HybridError('The Armbian image\'s partition is not a Linux root partition.');
  const offset = p.firstLba * SECTOR;
  const bytes = (p.lastLba - p.firstLba + 1) * SECTOR;
  if (offset + bytes > image.size) throw new HybridError('The Armbian image is shorter than its partition table says.');
  if (p.firstLba <= ARMBIAN_FIT_LBA) throw new HybridError('The Armbian image\'s root partition starts before its U-Boot.');
  const sb = image.read(offset + 1024, 1024);
  if (le16(sb, 0x38) !== 0xef53) throw new HybridError('The Armbian image\'s root partition is not ext4.');
  if ((le16(sb, 0x3a) & 1) !== 1) throw new HybridError('The Armbian image\'s file system was not cleanly unmounted.');
  const label = new TextDecoder().decode(sb.subarray(0x78, 0x88)).replace(/\0+$/, '');

  const head = image.read(ARMBIAN_FIT_LBA * SECTOR, Math.min(64 * 1024, offset - ARMBIAN_FIT_LBA * SECTOR));
  if (be32(head, 0) !== 0xd00dfeed) throw new HybridError('Armbian\'s image has no U-Boot FIT at sector 16384. It is not an image for a Rockchip board with mainline U-Boot.');
  const len = fitLength(head);
  if (typeof len === 'string') throw new HybridError(len);
  const fitSectors = Math.ceil(len / SECTOR);
  if (fitSectors > SLOT_SECTORS) throw new HybridError('Armbian\'s U-Boot FIT is larger than the firmware\'s slot (16 MiB).');
  if (ARMBIAN_FIT_LBA + fitSectors > p.firstLba) throw new HybridError('Armbian\'s U-Boot FIT runs into its root partition.');
  return {
    root: sliceSource(image, offset, bytes),
    fit: sliceSource(image, ARMBIAN_FIT_LBA * SECTOR, fitSectors * SECTOR),
    uuid: uuidText(sb.subarray(0x68, 0x78)),
    label,
  };
}

/** The smallest partition Armbian gets beside Windows: its root partition, or the floor for its kind, whichever is larger. */
export function minArmbianBytes(rootBytes: number, desktop: boolean): number {
  const floor = desktop ? MIN_ARMBIAN_DESKTOP_BYTES : MIN_ARMBIAN_BYTES;
  return Math.max(floor, Math.ceil((rootBytes + 1024 ** 3) / 1024 ** 3) * 1024 ** 3);
}

/** Armbian's resize leaves a partition alone when it ends past 99% of the disk, aligned as it aligns (armbian-resize-filesystem). */
export function resizeLeavesTableAlone(partLastLba: number, diskSectors: number): boolean {
  const align = (16 * 1024 * 1024) / SECTOR;
  let last = Math.floor((diskSectors * 99) / 100);
  last = last - (last % align) - 1;
  return last < partLastLba;
}

/**
 * Why the firmware's slot (eMMC sectors 0x10000..0x17FFF) cannot take
 * Armbian's U-Boot, from the eMMC's sectors 0..33, or null. The firmware
 * refuses the slot when a partition other than "firmware" overlaps it
 * (ArmbianOnceSlotIsFree in edk2-rk3576 ArmbianOnceLib.c); so does this.
 * No partition table (the plain firmware image) leaves it free.
 */
export function slotProblem(head: Uint8Array): string | null {
  const range = `sectors ${SLOT_LBA} to ${SLOT_LBA + SLOT_SECTORS - 1}`;
  const overlaps = (first: number, last: number) => first < SLOT_LBA + SLOT_SECTORS && last >= SLOT_LBA;
  let parts: GptPartition[];
  try {
    parts = parsePrimaryGpt(head).partitions;
  } catch (e) {
    if (!/no GUID partition table/.test((e as Error).message)) {
      return `The eMMC's partition table cannot be read (${(e as Error).message}), so the firmware's slot for Armbian's U-Boot (${range}) cannot be checked. Nothing was written.`;
    }
    // An MBR: its four entries, as the firmware reads them; the protective entry (0xEE) of a GPT does not count.
    for (let i = 0; i < 4; i++) {
      const e = head.subarray(446 + i * 16, 462 + i * 16);
      const type = e[4];
      const first = e[8] | (e[9] << 8) | (e[10] << 16) | (e[11] << 24);
      const count = (e[12] | (e[13] << 8) | (e[14] << 16) | (e[15] << 24)) >>> 0;
      if (type === 0 || type === 0xee || count === 0) continue;
      if (overlaps(first >>> 0, (first >>> 0) + count - 1)) {
        return `Partition ${i + 1} of the eMMC (MBR, sectors ${first >>> 0} to ${(first >>> 0) + count - 1}) covers the firmware's slot for Armbian's U-Boot (${range}). Nothing was written.`;
      }
    }
    return null;
  }
  const p = parts.find((x) => x.type !== TYPE_RK_FIRMWARE && overlaps(x.firstLba, x.lastLba));
  return p ? `The eMMC partition "${p.name || p.index}" (sectors ${p.firstLba} to ${p.lastLba}) covers the firmware's slot for Armbian's U-Boot (${range}). Nothing was written.` : null;
}

/**
 * The size Armbian's partition starts at on a disk with `freeBytes` after the
 * firmware (whole GiB): half the disk, at least `minBytes`, and never so much
 * that Windows gets less than MIN_WINDOWS_CHOSEN. Null when both do not fit.
 */
export function defaultArmbianBytes(freeBytes: number, minBytes: number): number | null {
  const max = Math.floor((freeBytes - (ESP_MIB + MSR_MIB + 2) * MiB - MIN_WINDOWS_CHOSEN) / GiB) * GiB;
  if (max < minBytes) return null;
  const half = Math.floor(freeBytes / 2 / GiB) * GiB;
  return Math.min(max, Math.max(Math.ceil(minBytes / GiB) * GiB, half));
}
