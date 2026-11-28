// The Windows releases Maskrom Studio installs, by the build number in the
// image's XML (wim.ts), and what each one has that the RK3576 drivers need.
// One table, read by the image check (wim.ts checkEdition), the pages (which
// version, which notes, which targets), the main process (refuses a target
// the version cannot use) and the staging files (woa-stage.ini says the
// family, the driver package's list is picked by it).
//
// Facts behind the table:
// - KMDF: 1.31 is in Windows 10 2004 and the releases built on it (19041 to
//   19045 are one code base with enablement packages); 1.33 is in Windows 11
//   21H2 and later (Microsoft, KMDF version history).
// - WiFiCx: Windows 11 21H2 and later (1.0 on 21H2, 22H2 and 23H2); Windows
//   10 has none, so a WiFiCx Wi-Fi driver cannot run there.
// - Builds above 22631 are refused: 24H2 (26100) and later need the ARMv8.1
//   atomic instructions, which the RK3576's Cortex-A72 and Cortex-A53 lack;
//   the builds between are previews.

import type { WindowsTarget } from '../woa/boards';

export type WindowsFamily = 'win10' | 'win11';

export interface WindowsVersion {
  build: number;
  family: WindowsFamily;
  /** As Microsoft names it: "22H2", "2004". */
  release: string;
  /** "Windows 10 22H2". */
  name: string;
  /** The KMDF the release has; a driver built for a newer one does not load. */
  kmdf: '1.31' | '1.33';
  /** The WiFiCx it has, or null (Windows 10). */
  wificx: string | null;
  /** tested: run on these boards with the current drivers; less: accepted, run less. */
  tested: 'tested' | 'less';
}

const v = (build: number, family: WindowsFamily, release: string, tested: WindowsVersion['tested']): WindowsVersion => ({
  build, family, release, name: `Windows ${family === 'win10' ? 10 : 11} ${release}`,
  kmdf: family === 'win10' ? '1.31' : '1.33', wificx: family === 'win10' ? null : '1.0', tested,
});

/** Every build this app installs, oldest first. */
export const WINDOWS_VERSIONS: WindowsVersion[] = [
  v(19041, 'win10', '2004', 'tested'),
  v(19042, 'win10', '20H2', 'tested'),
  v(19043, 'win10', '21H1', 'tested'),
  v(19044, 'win10', '21H2', 'tested'),
  v(19045, 'win10', '22H2', 'tested'),
  v(22000, 'win11', '21H2', 'less'),
  v(22621, 'win11', '22H2', 'tested'),
  v(22631, 'win11', '23H2', 'tested'),
];

export const OLDEST_BUILD = 19041;
export const NEWEST_BUILD = 22631;

/** The release a build is, or null when this app does not install it. */
export function windowsVersion(build: number | null | undefined): WindowsVersion | null {
  return WINDOWS_VERSIONS.find((x) => x.build === build) ?? null;
}

/** "Windows 10 22H2 (19045)". */
export function versionLabel(x: WindowsVersion): string {
  return `${x.name} (${x.build})`;
}

/** Which driver list a build takes: Windows 10 below 22000, as the driver package's install.cmd decides. */
export function familyOfBuild(build: number): WindowsFamily {
  return build < 22000 ? 'win10' : 'win11';
}

/**
 * Drivers the Windows 10 builds do not have yet (woa-rk3576 branches
 * win10-nvme, win10-wifi). Microsoft's stornvme faults on this SoC under
 * Windows 10, so an NVMe drive cannot hold Windows 10 until ours is in the
 * driver package. Set an entry to true when its driver is released.
 */
export const WIN10_DRIVERS = { nvme: false, wifi: false };

/**
 * Why this Windows cannot go onto this target, as a message key, or null.
 * Only Windows 10 on an NVMe drive, until its NVMe driver is released.
 */
export function targetProblem(x: WindowsVersion | null, target: WindowsTarget): 'ver.nvme.blocked' | null {
  if (x?.family === 'win10' && target === 'nvme' && !WIN10_DRIVERS.nvme) return 'ver.nvme.blocked';
  return null;
}

/**
 * What to say about this version on a board with these targets (message
 * keys, in order): the drivers Windows 10 still waits for, and that 21H2
 * has run less on these boards than 22H2 and 23H2.
 */
export function versionNotes(x: WindowsVersion | null, targets: WindowsTarget[]): string[] {
  if (!x) return [];
  const out: string[] = [];
  if (x.family === 'win10') {
    if (targets.includes('nvme') && !WIN10_DRIVERS.nvme) out.push('ver.note.nvme');
    if (!WIN10_DRIVERS.wifi) out.push('ver.note.wifi');
  }
  if (x.tested === 'less') out.push('ver.note.less');
  return out;
}

/**
 * The version as woa-stage.ini and host-build.ini carry it, for the scripts
 * on the board and in WinPE: windows_family (win10 or win11), windows_name
 * ("Windows 10 22H2"), windows_kmdf, windows_wificx ("none" on Windows 10).
 * A build this table does not know (never staged: the image check refuses
 * it) still gets its family from the build number.
 */
export function versionIni(build: number): Record<string, string> {
  const x = windowsVersion(build);
  const family = x?.family ?? familyOfBuild(build);
  return {
    windows_family: family,
    windows_name: x?.name ?? `build ${build}`,
    windows_kmdf: x?.kmdf ?? (family === 'win10' ? '1.31' : '1.33'),
    windows_wificx: x ? (x.wificx ?? 'none') : family === 'win10' ? 'none' : '1.0',
  };
}
