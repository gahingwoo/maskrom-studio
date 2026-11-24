// How the disk is shared after a staged Windows install (windows-layout.ts).
import { describe, expect, it } from 'vitest';
import { ESP_MIB, freeBytesOf, GiB, layoutIni, MiB, MSR_MIB, planLayout, WHOLE_DISK } from '../src/woa/windows-layout';
import { woaBoard } from '../src/woa/boards';
import { INSTALL } from '../src/woa/stage-scripts';

const tspi = freeBytesOf(woaBoard('tspi3m')!.emmc!.bytes, true);
const cm5 = freeBytesOf(woaBoard('cm5io')!.emmc!.bytes, true);

describe('the disk layout', () => {
  it('starts after the firmware partition on the eMMC and at 1 MiB elsewhere', () => {
    expect(freeBytesOf(62008590336, true)).toBe((Math.floor(62008590336 / 512) - 34 - 131072) * 512);
    expect(freeBytesOf(64e9, false)).toBe((Math.floor(64e9 / 512) - 34 - 2048) * 512);
  });
  it('gives Windows everything by default', () => {
    const l = planLayout(tspi, WHOLE_DISK);
    if ('problem' in l) throw new Error(l.problem);
    expect(l.windowsBytes).toBeGreaterThan(tspi - (ESP_MIB + MSR_MIB + 3) * MiB);
    expect(l.data).toBeNull();
  });
  it('splits Windows, a data partition and space kept for Linux', () => {
    const l = planLayout(tspi, { windowsBytes: 32 * GiB, rest: 'ntfs', dataLabel: 'Data', linuxReserveBytes: 10 * GiB });
    if ('problem' in l) throw new Error(l.problem);
    expect(l.windowsBytes + l.data!.bytes + l.linuxReserveBytes + (ESP_MIB + MSR_MIB) * MiB).toBeLessThanOrEqual(tspi);
    expect(l.unallocatedBytes).toBe(10 * GiB);
    expect(l.data!.bytes).toBeGreaterThan(10 * GiB);
  });
  it('refuses less than 32 GB for Windows, more than fits, a bad label, too much kept for Linux', () => {
    expect(planLayout(tspi, { windowsBytes: 31 * GiB, rest: 'unallocated', dataLabel: 'x', linuxReserveBytes: 0 })).toMatchObject({ problem: expect.stringMatching(/at least 32\.0 GB/) });
    expect(planLayout(tspi, { windowsBytes: 60 * GiB, rest: 'unallocated', dataLabel: 'x', linuxReserveBytes: 0 })).toMatchObject({ problem: expect.stringMatching(/at most/) });
    expect(planLayout(tspi, { windowsBytes: 32 * GiB, rest: 'exfat', dataLabel: 'My Data', linuxReserveBytes: 0 })).toMatchObject({ problem: expect.stringMatching(/label/) });
    expect(planLayout(tspi, { windowsBytes: 50 * GiB, rest: 'unallocated', dataLabel: 'x', linuxReserveBytes: 20 * GiB })).toMatchObject({ problem: expect.stringMatching(/left after Windows/) });
    expect(planLayout(tspi, { ...WHOLE_DISK, linuxReserveBytes: GiB })).toMatchObject({ problem: expect.stringMatching(/Choose a Windows size/) });
  });
  it('leaves the CM5-IO only the whole disk', () => {
    expect(planLayout(cm5, { windowsBytes: 32 * GiB, rest: 'unallocated', dataLabel: 'x', linuxReserveBytes: 0 })).toMatchObject({ problem: expect.stringMatching(/at most/) });
  });
  it('tells the script to make Windows at its size, or to grow it over the staging space', () => {
    const l = planLayout(tspi, { windowsBytes: 50 * GiB, rest: 'ntfs', dataLabel: 'Data', linuxReserveBytes: 0 });
    if ('problem' in l) throw new Error(l.problem);
    // A 40 GiB gap before the staging partitions: 40 GiB less ESP, MSR and 2 MiB, then extended by the rest.
    const gap = 40 * GiB;
    const ini = layoutIni(gap, l, false);
    expect(ini).toMatchObject({ windows_create_mb: 40960 - ESP_MIB - MSR_MIB - 2, data_fs: 'ntfs', data_label: 'Data' });
    expect(Number(ini.windows_create_mb) + Number(ini.windows_extend_mb)).toBe(50 * 1024);
    expect(layoutIni(60 * GiB, l, false)).toMatchObject({ windows_create_mb: 50 * 1024, windows_extend_mb: 'none' });
  });
  it('is what the install script reads', () => {
    expect(INSTALL).toMatch(/create partition primary!WSIZE!/);
    expect(INSTALL).toMatch(/extend size=%W_windows_extend_mb%/);
    expect(INSTALL).toMatch(/create partition primary size=%W_data_mb%/);
    expect(INSTALL).toMatch(/format quick fs=%W_data_fs% label=%W_data_label%/);
  });
});
