// Which drives may be offered as SD/USB targets.
//
// Input is drivelist's view of the machine (etcher-sdk uses the same
// module). A drive is offered only when nothing suggests it holds the running
// system. The rule errs on the side of hiding: a hidden drive costs the user a
// moment, an offered system disk can cost them their computer.
//
// On Linux, lsblk and sysfs add what drivelist leaves out (linuxDiskFacts):
// which disks are built in (a board's eMMC, SD card slot, NVMe drive), and
// every mount on a disk, also through LUKS or LVM. A built-in disk is
// offered only when the user turns on "Show internal disks", and never
// while anything on it is mounted (other than where the desktop mounts
// media by itself, /media/<user>/...) or in use. A disk with /, /boot,
// /usr, swap and the like is never offered, built in or not. Elsewhere
// drivelist's system disk flag decides, as before.

export interface DriveInfo {
  device: string;
  raw?: string;
  description: string;
  size: number | null;
  mountpoints: { path: string; label?: string | null }[];
  isReadOnly: boolean;
  isSystem: boolean;
  isVirtual: boolean | null;
  isRemovable: boolean | null;
  isCard: boolean | null;
  isUSB: boolean | null;
  busType?: string;
  /**
   * Linux only, from lsblk and sysfs (linuxDiskFacts): set for a built-in
   * disk, one that is neither on USB nor removable nor hot-pluggable, with
   * what it is. drivelist calls every such disk a system disk.
   */
  internal?: InternalKind | null;
  /** Linux only: every mount point on the disk, also of devices on its partitions (LUKS, LVM), '[SWAP]' for swap. */
  allMounts?: string[];
  /** Linux only: what else uses the disk without a mount point (a device-mapper, RAID or LVM device on it). */
  busy?: string | null;
}

/** A built-in disk: the eMMC, the SD card slot or an NVMe drive of a board, or any other fixed disk. */
export type InternalKind = 'emmc' | 'sd' | 'nvme' | 'disk';

export const INTERNAL_WORDS: Record<InternalKind, string> = {
  emmc: 'eMMC', sd: 'SD card slot', nvme: 'NVMe drive', disk: 'internal disk',
};

export interface Target {
  device: string;
  description: string;
  size: number;
  mountpoints: string[];
  kind: 'sd' | 'usb' | 'disk';
  /** A built-in disk, offered only when internal disks are shown (Linux). */
  internal: InternalKind | null;
  /** Set when the drive is offered but is not a good choice. */
  warning: string | null;
  /** Set when the drive is listed but cannot be chosen (too small). */
  disabled: string | null;
}

export interface ClassifyOptions {
  minSize?: number;
  platform?: string;
  /** Offer built-in disks that hold nothing in use (the "Show internal disks" switch; Linux only). */
  internal?: boolean;
}

export interface HiddenDrive {
  device: string;
  description: string;
  reason: string;
}

/** Mount points that only a system disk has. */
const SYSTEM_MOUNTS = [
  /^\/$/, /^\/boot(\/|$)/, /^\/usr(\/|$)/, /^\/var(\/|$)/, /^\/home(\/|$)/, /^\/etc(\/|$)/,
  /^\/opt(\/|$)/, /^\/srv(\/|$)/, /^\/nix(\/|$)/, /^\[SWAP\]$/i,
  /^\/System(\/|$)/, /^\/private(\/|$)/, /^\/Library(\/|$)/, /^\/Applications(\/|$)/,
  /^[A-Za-z]:\\?$/, // a Windows drive letter: see below
];

/** Where a Linux desktop mounts removable media for the user (udisks). */
const DESKTOP_MOUNT = /^\/(media|run\/media)\/[^/]+\/./;

/** Above this size a drive is offered with a warning: few SD cards or sticks are this large. */
export const LARGE_DRIVE = 128 * 1024 ** 3;

function systemMount(path: string, platform: string): boolean {
  if (/^[A-Za-z]:\\?$/.test(path)) {
    // Removable media get drive letters too; only the Windows drive counts.
    return platform === 'win32' && /^C:\\?$/i.test(path);
  }
  return SYSTEM_MOUNTS.some((re) => re.test(path));
}

export function classifyDrives(drives: DriveInfo[], opts: ClassifyOptions = {}):
  { targets: Target[]; hidden: HiddenDrive[] } {
  const platform = opts.platform ?? 'linux';
  const targets: Target[] = [];
  const hidden: HiddenDrive[] = [];
  for (const d of drives) {
    const hide = (reason: string) => hidden.push({ device: d.device, description: d.description, reason });
    const mounts = d.mountpoints.map((m) => m.path);
    // Every mount on the disk, also on devices stacked on its partitions.
    const allMounts = [...new Set([...mounts, ...(d.allMounts ?? [])])];
    // The reason names / when the disk has it, else the first system mount.
    const sys = allMounts.includes('/') ? '/' : allMounts.find((m) => systemMount(m, platform));
    // Only Linux knows built-in disks apart (linuxDiskFacts); elsewhere a
    // disk the OS calls a system disk stays hidden.
    const internal = platform === 'linux' ? d.internal ?? null : null;
    if (sys) { hide(`system disk: holds ${sys}`); continue; }
    if (d.isSystem && !internal) { hide('system disk'); continue; }
    if (d.isReadOnly) { hide('read-only'); continue; }
    if (d.isVirtual) { hide('virtual disk'); continue; }
    if (!d.size || d.size <= 0) { hide('size unknown'); continue; }
    if (platform === 'linux' && /^\/dev\/(loop|ram|zram|dm-|md|nbd|sr)/.test(d.device)) {
      hide('not a physical drive'); continue;
    }
    if (internal) {
      // A built-in disk is never offered while anything on it is in use,
      // and only when asked for.
      // What the desktop mounts by itself (a card in the SD slot) is
      // unmounted before the write, as on a USB drive; any other mount
      // means the disk is in use.
      const words = INTERNAL_WORDS[internal];
      const used = allMounts.filter((m) => !DESKTOP_MOUNT.test(m));
      if (used.length > 0) { hide(`${words}, in use: mounted at ${used.join(', ')}`); continue; }
      if (d.busy) { hide(`${words}, in use by ${d.busy}`); continue; }
      if (!opts.internal) { hide(`${words}; built-in disks are shown with "Show internal disks"`); continue; }
    }
    const kind: Target['kind'] = internal === 'sd' || d.isCard ? 'sd' : d.isUSB ? 'usb' : 'disk';
    let warning: string | null = null;
    if (internal) warning = `Built-in ${INTERNAL_WORDS[internal]} of this computer. Make sure it is not a disk you use.`;
    else if (!d.isRemovable && !d.isUSB && !d.isCard) warning = 'This drive is not removable. Make sure it is not a disk you use.';
    else if (d.size > LARGE_DRIVE) warning = 'This drive is larger than most SD cards and USB sticks. Make sure it is the one you mean.';
    const disabled = opts.minSize && d.size < opts.minSize ? 'Too small for this image' : null;
    targets.push({ device: d.device, description: d.description, size: d.size, mountpoints: mounts, kind, internal, warning, disabled });
  }
  // Removable drives first, then built-in disks; each by device name.
  targets.sort((a, b) => Number(!!a.internal) - Number(!!b.internal) || a.device.localeCompare(b.device));
  return { targets, hidden };
}

/** lsblk --json, as linuxDiskFacts reads it (LINUX_LSBLK_ARGS). */
export interface LsblkNode {
  name: string;
  type?: string | null;
  rm?: boolean | string | number | null;
  hotplug?: boolean | string | number | null;
  tran?: string | null;
  fstype?: string | null;
  mountpoint?: string | null;
  mountpoints?: (string | null)[] | null;
  children?: LsblkNode[];
}

/** The lsblk call for linuxDiskFacts. */
// MOUNTPOINTS, not MOUNTPOINT: MOUNTPOINT shows one of the places a device
// is mounted (a btrfs root with subvolumes at / and /home may show only
// /home), and for a built-in disk the mount list is all that keeps the disk
// the system runs from hidden. MOUNTPOINTS (util-linux 2.37 and later;
// Ubuntu 24.04 has 2.39) lists them all, [null] when there is none. An
// older lsblk refuses the column, readLinuxDiskFacts then has no facts, and
// every built-in disk stays hidden as a system disk.
export const LINUX_LSBLK_ARGS = ['--json', '--bytes', '--paths', '--output', 'NAME,TYPE,RM,HOTPLUG,TRAN,FSTYPE,MOUNTPOINTS'];

export interface LinuxDiskFacts {
  internal: InternalKind | null;
  allMounts: string[];
  busy: string | null;
}

const flag = (v: LsblkNode['rm']) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * What drivelist does not tell on Linux, per disk: is it built in (and
 * what: eMMC or SD card slot by the MMC card type in sysfs, NVMe by name),
 * every mount on it and on what is stacked on its partitions, and what
 * else uses it. `mmcTypes`: /sys/block/<mmcblkN>/device/type ("MMC" or
 * "SD") by device path.
 */
export function linuxDiskFacts(lsblk: { blockdevices?: LsblkNode[] }, mmcTypes: Record<string, string> = {}):
  Record<string, LinuxDiskFacts> {
  const out: Record<string, LinuxDiskFacts> = {};
  for (const disk of lsblk.blockdevices ?? []) {
    if (disk.type !== 'disk') continue;
    const mounts = new Set<string>();
    let busy: string | null = null;
    let hotplug = flag(disk.hotplug);
    const walk = (n: LsblkNode, depth: number) => {
      // lsblk shows swap in use as the mount point [SWAP].
      for (const m of [n.mountpoint, ...(n.mountpoints ?? [])]) if (m) mounts.add(m);
      if (depth > 0 && flag(n.hotplug)) hotplug = true;
      // A partition is part of the disk; anything else stacked on it is a user.
      if (depth > 0 && n.type && n.type !== 'part' && !busy) busy = `${n.name} (${n.type})`;
      // ZFS mounts its datasets without lsblk showing them: a pool member counts as in use.
      if (n.fstype === 'zfs_member' && !busy) busy = `${n.name} (ZFS pool)`;
      for (const c of n.children ?? []) walk(c, depth + 1);
    };
    walk(disk, 0);
    const name = disk.name;
    const usb = (disk.tran ?? '').toLowerCase() === 'usb';
    let internal: InternalKind | null = null;
    if (!usb && !flag(disk.rm) && !hotplug) {
      const mmc = /^\/dev\/mmcblk\d+$/.test(name) ? (mmcTypes[name] ?? '').trim().toUpperCase() : null;
      internal = /^\/dev\/nvme\d+n\d+$/.test(name) ? 'nvme' : mmc === 'MMC' ? 'emmc' : mmc === 'SD' ? 'sd' : 'disk';
    }
    out[name] = { internal, allMounts: [...mounts], busy };
  }
  return out;
}

/** drivelist's drives with the Linux facts added. A drive lsblk did not list keeps drivelist's view. */
export function withLinuxFacts(drives: DriveInfo[], facts: Record<string, LinuxDiskFacts>): DriveInfo[] {
  return drives.map((d) => (facts[d.device] ? { ...d, ...facts[d.device] } : d));
}

/** Is this device one classifyDrives() would offer? Used again just before writing. */
export function isOfferedTarget(device: string, drives: DriveInfo[], opts: ClassifyOptions = {}): boolean {
  const { targets } = classifyDrives(drives, opts);
  return targets.some((t) => t.device === device && !t.disabled);
}

/**
 * A drive picker's rows: every drive listed, each marked too small when it is
 * smaller than `need` (or the list itself said so). Too small drives are shown
 * greyed out with the sizes, never dropped: an empty picker means no drive.
 */
export function pickerRows(targets: Target[], need: number): Array<{ target: Target; small: boolean }> {
  return targets.map((t) => ({ target: t, small: t.size < need || !!t.disabled }));
}

/** "3.7 GiB" and "6.0 GiB" for a drive and what it needs, as the picker's labels say sizes; one more digit when they would read the same. */
export function sizeWords(size: number, need: number): { size: string; need: string } {
  const at = (n: number, d: number) => `${(n / 1024 ** 3).toFixed(d)} GiB`;
  const digits = at(size, 1) === at(need, 1) ? 2 : 1;
  return { size: at(size, digits), need: at(need, digits) };
}
