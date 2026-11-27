import { describe, expect, it } from 'vitest';
import { classifyDrives, isOfferedTarget, pickerRows, sizeWords, type DriveInfo } from '../src/shared/targets';

const GiB = 1024 ** 3;

function drive(p: Partial<DriveInfo>): DriveInfo {
  return {
    device: '/dev/sdx', description: 'Drive', size: 32 * GiB, mountpoints: [],
    isReadOnly: false, isSystem: false, isVirtual: false, isRemovable: true, isCard: false, isUSB: true,
    ...p,
  };
}

describe('classifyDrives', () => {
  it('never offers a system disk', () => {
    const r = classifyDrives([drive({ device: '/dev/sda', isSystem: true, isRemovable: false, isUSB: false })]);
    expect(r.targets).toEqual([]);
    expect(r.hidden[0].reason).toBe('system disk');
  });

  it('never offers a disk that holds a system mount, even if drivelist says it is not a system disk', () => {
    for (const m of ['/', '/boot', '/boot/efi', '/home', '/usr', '/var/lib', '[SWAP]', '/System/Volumes/Data']) {
      const r = classifyDrives([drive({ mountpoints: [{ path: '/media/sd' }, { path: m }] })]);
      expect(r.targets, m).toEqual([]);
    }
  });

  it('treats C:\\ as a system mount on Windows only', () => {
    expect(classifyDrives([drive({ device: '\\\\.\\PhysicalDrive1', mountpoints: [{ path: 'C:\\' }] })], { platform: 'win32' }).targets).toEqual([]);
    expect(classifyDrives([drive({ device: '\\\\.\\PhysicalDrive2', mountpoints: [{ path: 'E:\\' }] })], { platform: 'win32' }).targets).toHaveLength(1);
  });

  it('hides read-only, virtual and size-less drives', () => {
    const r = classifyDrives([
      drive({ device: '/dev/sdb', isReadOnly: true }),
      drive({ device: '/dev/sdc', isVirtual: true }),
      drive({ device: '/dev/sdd', size: null }),
      drive({ device: '/dev/sde', size: 0 }),
    ]);
    expect(r.targets).toEqual([]);
    expect(r.hidden.map((h) => h.reason)).toEqual(['read-only', 'virtual disk', 'size unknown', 'size unknown']);
  });

  it('hides loop, RAM, device-mapper and optical devices on Linux', () => {
    const r = classifyDrives(['/dev/loop0', '/dev/ram0', '/dev/zram0', '/dev/dm-0', '/dev/md0', '/dev/nbd0', '/dev/sr0']
      .map((device) => drive({ device })));
    expect(r.targets).toEqual([]);
  });

  it('offers SD cards and USB drives, and marks the kind', () => {
    const r = classifyDrives([
      drive({ device: '/dev/mmcblk0', isCard: true, isUSB: false }),
      drive({ device: '/dev/sdb' }),
    ]);
    expect(r.targets.map((t) => [t.device, t.kind, t.warning])).toEqual([
      ['/dev/mmcblk0', 'sd', null],
      ['/dev/sdb', 'usb', null],
    ]);
  });

  it('warns about fixed and very large drives', () => {
    const r = classifyDrives([
      drive({ device: '/dev/sdb', isRemovable: false, isUSB: false }),
      drive({ device: '/dev/sdc', size: 512 * GiB }),
    ]);
    expect(r.targets[0].warning).toMatch(/not removable/);
    expect(r.targets[1].warning).toMatch(/larger than most/);
  });

  it('lists drives too small for the image as disabled', () => {
    const r = classifyDrives([drive({ size: 1 * GiB })], { minSize: 2 * GiB });
    expect(r.targets[0].disabled).toBe('Too small for this image');
    expect(isOfferedTarget('/dev/sdx', [drive({ size: 1 * GiB })], { minSize: 2 * GiB })).toBe(false);
  });

  it('isOfferedTarget agrees with classifyDrives', () => {
    const drives = [drive({ device: '/dev/sda', isSystem: true }), drive({ device: '/dev/sdb' })];
    expect(isOfferedTarget('/dev/sda', drives)).toBe(false);
    expect(isOfferedTarget('/dev/sdb', drives)).toBe(true);
    expect(isOfferedTarget('/dev/sdz', drives)).toBe(false);
  });
});

describe('drive pickers', () => {
  // Seen on a CM5-IO 2026-11-28: a 4 GB card was left out of the Armbian SD list, which then said no card was there.
  it('keep a drive that is too small, marked, so an empty picker means no drive at all', () => {
    const { targets } = classifyDrives([drive({ device: '/dev/sdy', size: 3965190144, isCard: true, isUSB: false }), drive({ device: '/dev/sdz', size: 64e9 })], { minSize: 4e9 });
    expect(targets.map((t) => t.device)).toEqual(['/dev/sdy', '/dev/sdz']);
    const rows = pickerRows(targets, 6.5e9);
    expect(rows.map((r) => [r.target.device, r.small])).toEqual([['/dev/sdy', true], ['/dev/sdz', false]]);
    // Marked by the list's own floor too, and by what this write needs above it.
    expect(pickerRows(targets, 1e9).map((r) => r.small)).toEqual([true, false]);
    expect(pickerRows(targets, 100e9).map((r) => r.small)).toEqual([true, true]);
    expect(pickerRows([], 1e9)).toEqual([]);
  });

  it('says the sizes so that they differ', () => {
    expect(sizeWords(3965190144, 6.5e9)).toEqual({ size: '3.7 GiB', need: '6.1 GiB' });
    expect(sizeWords(3965190144, 4e9)).toEqual({ size: '3.69 GiB', need: '3.73 GiB' });
  });
});
