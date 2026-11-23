// How the disk is shared out after a staged Windows install: Windows can take
// all of it (the default, as before), or a chosen size, with the rest left
// unallocated, made a data partition (NTFS or exFAT), and/or kept free at
// the end for a Linux install later. Pure: the page shows the result before
// anything is written, and stage-layout.ts turns it into woa-stage.ini.
//
// The order on the disk, after the firmware partition on the eMMC (sectors
// 64..131071) or from 1 MiB on an SD card or NVMe drive:
//   ESP (260 MiB, FAT32), MSR (16 MiB), Windows (NTFS), [data], [free]
// The ESP and MSR are what Windows Setup itself creates on a GPT disk.

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
/** ESP and MSR, before the Windows partition. */
export const ESP_MIB = 260;
export const MSR_MIB = 16;
/** The smallest Windows partition that can be chosen: 23H2 with updates, a page file and some room. */
export const MIN_WINDOWS_CHOSEN = 32 * GiB;
/** The smallest data partition worth making. */
export const MIN_DATA = 1 * GiB;
/** diskpart aligns partitions to 1 MiB; this much is held back so a size never overshoots the free space. */
const SLACK_MIB = 2;

export type RestUse = 'unallocated' | 'ntfs' | 'exfat';

export interface LayoutChoice {
  /** Bytes for the Windows (NTFS) partition; null: all the space there is. */
  windowsBytes: number | null;
  /** What the space after Windows becomes (less the Linux reserve). */
  rest: RestUse;
  /** Volume label of the data partition. */
  dataLabel: string;
  /** Bytes left unallocated at the end for a later Linux install. */
  linuxReserveBytes: number;
}

export const WHOLE_DISK: LayoutChoice = { windowsBytes: null, rest: 'unallocated', dataLabel: 'Data', linuxReserveBytes: 0 };

export interface Layout {
  /** Space from the first Windows sector to the last usable one. */
  freeBytes: number;
  windowsBytes: number;
  data: { fs: 'ntfs' | 'exfat'; label: string; bytes: number } | null;
  /** Unallocated at the end: what is left plus the Linux reserve. */
  unallocatedBytes: number;
  linuxReserveBytes: number;
}

/** A label both NTFS and exFAT take, and the install script can pass to diskpart. */
export function labelProblem(label: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,11}$/.test(label)) return 'The label is 1 to 11 letters, digits, - or _.';
  return null;
}

/** The layout this choice gives on a disk with `freeBytes` after the firmware, or why it cannot be. */
export function planLayout(freeBytes: number, c: LayoutChoice): Layout | { problem: string } {
  const fixed = (ESP_MIB + MSR_MIB) * MiB;
  const ntfsMax = Math.floor((freeBytes - fixed) / MiB - SLACK_MIB) * MiB;
  if (c.windowsBytes === null) {
    if (c.linuxReserveBytes > 0 || c.rest !== 'unallocated') return { problem: 'Choose a Windows size to leave room for anything else.' };
    return { freeBytes, windowsBytes: ntfsMax, data: null, unallocatedBytes: 0, linuxReserveBytes: 0 };
  }
  const gb = (n: number) => `${(n / GiB).toFixed(1)} GB`;
  if (c.windowsBytes < MIN_WINDOWS_CHOSEN) return { problem: `Windows needs at least ${gb(MIN_WINDOWS_CHOSEN)}.` };
  if (c.windowsBytes % MiB !== 0) return { problem: 'The Windows size must be a whole number of MiB.' };
  if (c.windowsBytes > ntfsMax) return { problem: `The disk has room for at most ${gb(ntfsMax)} of Windows.` };
  if (c.linuxReserveBytes < 0 || c.linuxReserveBytes % MiB !== 0) return { problem: 'The space kept for Linux must be a whole number of MiB.' };
  const after = ntfsMax - c.windowsBytes;
  if (c.linuxReserveBytes > after) return { problem: `Only ${gb(after)} are left after Windows to keep for Linux.` };
  let data: Layout['data'] = null;
  if (c.rest !== 'unallocated') {
    const why = labelProblem(c.dataLabel);
    if (why) return { problem: why };
    const bytes = after - c.linuxReserveBytes;
    if (bytes < MIN_DATA) return { problem: `The data partition would be ${gb(bytes)}; it needs at least ${gb(MIN_DATA)}.` };
    data = { fs: c.rest, label: c.dataLabel, bytes };
  }
  return { freeBytes, windowsBytes: c.windowsBytes, data, unallocatedBytes: after - (data?.bytes ?? 0), linuxReserveBytes: c.linuxReserveBytes };
}

/**
 * What woa-stage.cmd needs: the Windows partition is created in the gap
 * before the staging partitions (`gapBytes` from the first Windows sector),
 * then extended over them once they are deleted.
 */
export function layoutIni(gapBytes: number, l: Layout, whole: boolean): Record<string, string | number> {
  const gapNtfsMib = Math.floor(gapBytes / MiB) - ESP_MIB - MSR_MIB - SLACK_MIB;
  const winMib = l.windowsBytes / MiB;
  let create = 0; // all of the gap
  let extend: string | number = 'all';
  if (!whole) {
    // An exact size either way, so the data partition after it fits to the MiB.
    if (winMib <= gapNtfsMib) { create = winMib; extend = 'none'; }
    else { create = gapNtfsMib; extend = winMib - gapNtfsMib; }
  }
  return {
    windows_create_mb: create,
    windows_extend_mb: extend,
    data_fs: l.data?.fs ?? 'none',
    data_label: l.data?.label ?? 'none',
    // One MiB under, against rounding in diskpart.
    data_mb: l.data ? Math.floor(l.data.bytes / MiB) - 1 : 0,
  };
}

/** The eMMC sizes seen on the boards (CLAUDE.md, boards.ts): the page's preview before the board answers. */
export const NOMINAL_EMMC_BYTES: Record<string, number> = { tspi3m: 62008590336, cm5io: 31272730624 };

/** Space for Windows and the rest on a disk: after the firmware partition on the eMMC (sector 131072), from 1 MiB elsewhere, up to the backup GPT. */
export function freeBytesOf(diskBytes: number, emmc: boolean): number {
  const first = emmc ? 131072 : 2048;
  return (Math.floor(diskBytes / 512) - 34 - first) * 512;
}
