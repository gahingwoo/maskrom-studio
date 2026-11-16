// Built-in disks on a Roxora board (eMMC, SD card slot, NVMe), from lsblk
// as drivelist and linuxDiskFacts read it. Each machine is one lsblk --json
// tree: drivelist's parser makes the drive list from it, as on a real
// system, and linuxDiskFacts the facts drivelist leaves out.
import { describe, expect, it } from 'vitest';
import { parse } from 'drivelist/js/lsblk/json';
import {
  classifyDrives, isOfferedTarget, linuxDiskFacts, withLinuxFacts, type DriveInfo, type LsblkNode,
} from '../src/shared/targets';

const GB = 1000 ** 3;

interface Node extends LsblkNode {
  size?: number;
  ro?: boolean;
  label?: string | null;
  partlabel?: string | null;
  model?: string | null;
  vendor?: string | null;
  subsystems?: string;
  kname?: string;
  children?: Node[];
}

const part = (name: string, mountpoint: string | null = null, more: Partial<Node> = {}): Node => ({
  name, kname: name, type: 'part', size: 8 * GB, rm: false, hotplug: false, ro: false, tran: null,
  fstype: 'ext4', mountpoint, label: null, partlabel: null, model: null, vendor: null, ...more,
});
const sd = (name: string, children: Node[]): Node => ({
  name, kname: name, type: 'disk', size: 64 * GB, rm: false, hotplug: false, ro: false, tran: null,
  fstype: null, mountpoint: null, label: null, partlabel: null, model: 'SD64G', vendor: null,
  subsystems: 'block:mmc:mmc_host:platform', children,
});
const emmc = (children: Node[]): Node => ({
  ...sd('/dev/mmcblk0', children), size: 58 * GB, model: 'A3A561',
});
// The eMMC boot partitions: lsblk lists them as disks, read-only.
const emmcBoot = (n: 0 | 1): Node => ({
  ...sd(`/dev/mmcblk0boot${n}`, []), size: 4 * 1024 ** 2, ro: true, model: null, children: undefined,
});
const nvme = (children: Node[]): Node => ({
  name: '/dev/nvme0n1', kname: '/dev/nvme0n1', type: 'disk', size: 500 * GB, rm: false, hotplug: false, ro: false,
  tran: 'nvme', fstype: null, mountpoint: null, label: null, partlabel: null, model: 'Samsung SSD 980 500GB', vendor: null,
  subsystems: 'block:nvme:pci:platform', children,
});
const usb = (children: Node[]): Node => ({
  name: '/dev/sda', kname: '/dev/sda', type: 'disk', size: 32 * GB, rm: true, hotplug: true, ro: false, tran: 'usb',
  fstype: null, mountpoint: null, label: null, partlabel: null, model: 'Ultra', vendor: 'SanDisk',
  subsystems: 'block:scsi:usb:platform', children,
});

/** A machine: what classifyDrives sees, from one lsblk tree and the MMC card types. */
function machine(nodes: Node[], mmcTypes: Record<string, string>): DriveInfo[] {
  const tree = { blockdevices: nodes };
  const drives = parse(JSON.stringify(tree)) as unknown as DriveInfo[];
  return withLinuxFacts(drives, linuxDiskFacts(tree, mmcTypes));
}

const MMC = { '/dev/mmcblk0': 'MMC\n', '/dev/mmcblk1': 'SD\n' };
const offered = (drives: DriveInfo[], internal: boolean) =>
  classifyDrives(drives, { platform: 'linux', internal }).targets.map((t) => [t.device, t.internal, t.kind]);
const reasons = (drives: DriveInfo[], internal: boolean) =>
  Object.fromEntries(classifyDrives(drives, { platform: 'linux', internal }).hidden.map((h) => [h.device, h.reason]));

describe('a board running from its SD card, with eMMC and NVMe', () => {
  const drives = machine([
    sd('/dev/mmcblk1', [part('/dev/mmcblk1p1', '/boot', { fstype: 'vfat' }), part('/dev/mmcblk1p2', '/')]),
    emmc([part('/dev/mmcblk0p1'), part('/dev/mmcblk0p2')]),
    emmcBoot(0), emmcBoot(1),
    nvme([part('/dev/nvme0n1p1')]),
  ], MMC);

  it('offers no built-in disk until internal disks are shown, and says why', () => {
    expect(offered(drives, false)).toEqual([]);
    expect(reasons(drives, false)).toEqual({
      '/dev/mmcblk1': 'system disk: holds /boot',
      '/dev/mmcblk0': 'eMMC; built-in disks are shown with "Show internal disks"',
      '/dev/mmcblk0boot0': 'read-only',
      '/dev/mmcblk0boot1': 'read-only',
      '/dev/nvme0n1': 'NVMe drive; built-in disks are shown with "Show internal disks"',
    });
  });
  it('then offers the eMMC and the NVMe drive, never the SD card the system runs from', () => {
    expect(offered(drives, true)).toEqual([['/dev/mmcblk0', 'emmc', 'disk'], ['/dev/nvme0n1', 'nvme', 'disk']]);
    expect(reasons(drives, true)['/dev/mmcblk1']).toBe('system disk: holds /boot');
    const emmcTarget = classifyDrives(drives, { platform: 'linux', internal: true }).targets[0];
    expect(emmcTarget.warning).toMatch(/^Built-in eMMC/);
    expect(emmcTarget.size).toBe(58 * GB);
  });
  it('lets the writer write a built-in disk only when the app asked for it', () => {
    expect(isOfferedTarget('/dev/mmcblk0', drives, { platform: 'linux' })).toBe(false);
    expect(isOfferedTarget('/dev/mmcblk0', drives, { platform: 'linux', internal: true })).toBe(true);
    expect(isOfferedTarget('/dev/mmcblk1', drives, { platform: 'linux', internal: true })).toBe(false);
  });
});

describe('a board running from its eMMC, with a card in the SD slot', () => {
  it('offers the card in the slot with internal disks shown, also when the desktop mounted it', () => {
    for (const mount of [null, '/media/roxora/rootfs']) {
      const drives = machine([
        emmc([part('/dev/mmcblk0p1', '/boot'), part('/dev/mmcblk0p2', '/'), part('/dev/mmcblk0p3', '[SWAP]', { fstype: 'swap' })]),
        sd('/dev/mmcblk1', [part('/dev/mmcblk1p1', mount)]),
      ], MMC);
      expect(offered(drives, false), String(mount)).toEqual([]);
      expect(offered(drives, true), String(mount)).toEqual([['/dev/mmcblk1', 'sd', 'sd']]);
      expect(reasons(drives, true)['/dev/mmcblk0']).toBe('system disk: holds /boot');
    }
  });
  it('does not offer a card mounted anywhere else', () => {
    const drives = machine([
      emmc([part('/dev/mmcblk0p1', '/')]),
      sd('/dev/mmcblk1', [part('/dev/mmcblk1p1', '/mnt/data')]),
    ], MMC);
    expect(offered(drives, true)).toEqual([]);
    expect(reasons(drives, true)['/dev/mmcblk1']).toBe('SD card slot, in use: mounted at /mnt/data');
  });
});

describe('a board running from NVMe, its root on LUKS', () => {
  // drivelist sees only the partitions' own mount points: /boot/efi, not
  // the / of the encrypted volume on the second partition.
  const drives = machine([
    nvme([
      part('/dev/nvme0n1p1', '/boot/efi', { fstype: 'vfat' }),
      part('/dev/nvme0n1p2', null, { fstype: 'crypto_LUKS', children: [
        { name: '/dev/mapper/root', type: 'crypt', fstype: 'ext4', mountpoint: '/', rm: false, hotplug: false },
      ] as Node[] }),
    ]),
    emmc([part('/dev/mmcblk0p1')]),
  ], MMC);
  it('never offers the NVMe drive, and offers the eMMC with internal disks shown', () => {
    expect(offered(drives, true)).toEqual([['/dev/mmcblk0', 'emmc', 'disk']]);
    expect(reasons(drives, true)['/dev/nvme0n1']).toMatch(/^system disk: holds \/boot\/efi/);
  });
  it('sees the / inside the encrypted volume', () => {
    const facts = linuxDiskFacts({ blockdevices: [nvme([part('/dev/nvme0n1p1', null, { children: [
      { name: '/dev/mapper/root', type: 'crypt', mountpoint: '/' },
    ] as Node[] })])] });
    expect(facts['/dev/nvme0n1'].allMounts).toEqual(['/']);
    const d = machine([nvme([part('/dev/nvme0n1p1', null, { children: [{ name: '/dev/mapper/root', type: 'crypt', mountpoint: '/' }] as Node[] })])], {});
    expect(reasons(d, true)['/dev/nvme0n1']).toBe('system disk: holds /');
  });
});

describe('a USB drive', () => {
  const drives = machine([
    sd('/dev/mmcblk1', [part('/dev/mmcblk1p1', '/')]),
    usb([part('/dev/sda1', '/media/roxora/STICK', { fstype: 'vfat' })]),
  ], MMC);
  it('is offered as before, internal disks shown or not', () => {
    expect(offered(drives, false)).toEqual([['/dev/sda', null, 'usb']]);
    expect(offered(drives, true)).toEqual([['/dev/sda', null, 'usb']]);
  });
  it('is never offered while it holds the system', () => {
    const d = machine([usb([part('/dev/sda1', '/boot'), part('/dev/sda2', '/')])], {});
    expect(offered(d, true)).toEqual([]);
  });
});

describe('when the facts are missing or say the disk is in use', () => {
  it('keeps a built-in disk hidden as a system disk without lsblk facts', () => {
    const tree = { blockdevices: [emmc([part('/dev/mmcblk0p1')])] };
    const drives = parse(JSON.stringify(tree)) as unknown as DriveInfo[];
    expect(classifyDrives(drives, { platform: 'linux', internal: true }).hidden[0].reason).toBe('system disk');
  });
  it('hides a built-in disk used by LVM, RAID or ZFS without a mount', () => {
    for (const child of [
      { name: '/dev/mapper/vg-data', type: 'lvm', mountpoint: null },
      { name: '/dev/md0', type: 'raid1', mountpoint: null },
    ] as Node[]) {
      const d = machine([nvme([part('/dev/nvme0n1p1', null, { fstype: 'LVM2_member', children: [child] })])], {});
      expect(reasons(d, true)['/dev/nvme0n1']).toBe(`NVMe drive, in use by ${child.name} (${child.type})`);
    }
    const z = machine([nvme([part('/dev/nvme0n1p1', null, { fstype: 'zfs_member' })])], {});
    expect(reasons(z, true)['/dev/nvme0n1']).toBe('NVMe drive, in use by /dev/nvme0n1p1 (ZFS pool)');
  });
  it('does not show internal disks on other systems', () => {
    const tree = { blockdevices: [emmc([part('/dev/mmcblk0p1')])] };
    const drives = machine(tree.blockdevices, MMC);
    expect(classifyDrives(drives, { platform: 'win32', internal: true }).targets).toEqual([]);
    expect(classifyDrives(drives, { platform: 'darwin', internal: true }).targets).toEqual([]);
  });
  it('calls an MMC disk of unknown type an internal disk', () => {
    expect(linuxDiskFacts({ blockdevices: [emmc([])] })['/dev/mmcblk0'].internal).toBe('disk');
    expect(linuxDiskFacts({ blockdevices: [usb([])] })['/dev/sda'].internal).toBeNull();
  });
});
