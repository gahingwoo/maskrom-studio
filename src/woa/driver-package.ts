// The RK3576 Windows driver package (woa-rk3576 tools/rk3576-drivers): every
// Windows driver for the boards in one zip, rk3576-drivers-arm64*.zip on the
// woa-rk3576 release, with a manifest that says which driver goes onto which
// board. The app downloads it with the WinPE image (checked against the
// release's SHA-256 like every other asset), takes the chosen board's
// default list out of it, checks each file against the package's own
// SHA256SUMS.txt, and stages the drivers as rk3576-drivers/<dir>/... for
// DISM. Optional entries (untested on that board) are never installed here.
//
// A release without the package (0.1.1 and older) installs the drivers the
// WinPE image carries instead (woa-drivers and woa-audio), as before.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BoardId } from './boards';
import { familyOfBuild } from '../shared/windows-version';

/** The package's asset name on a woa-rk3576 release. */
export const DRIVERS_ASSET = /^rk3576-drivers-arm64.*\.zip$/;
/** Where the board's drivers go on the staging volume (and in the PC build's folder). */
export const DRIVERS_STAGE_DIR = 'rk3576-drivers';
/** The drivers every Windows on these boards boots with: a package without them is refused. */
export const REQUIRED_DRIVERS = ['dwcsdhc', 'dwcmshc'] as const;

export interface PackageDriver {
  dir: string;
  what: string;
  from: string;
  default: string[];
  optional: string[];
  /** Which Windows it is for (woa-rk3576 drivers.tsv's os column): every one, Windows 10 only (below 22000) or Windows 11 only. */
  os: 'all' | 'win10' | 'win11';
  infs: string[];
}

export interface DriverManifest {
  format: number;
  version: string;
  boards: string[];
  sources: Record<string, string>;
  drivers: PackageDriver[];
}

const SAFE_DIR = /^[A-Za-z0-9._-]+$/;

export function parseManifest(text: string): DriverManifest {
  let m: unknown;
  try { m = JSON.parse(text); } catch { throw new Error('The driver package\'s manifest.json is not JSON.'); }
  const o = m as Partial<DriverManifest>;
  if (!o || o.format !== 1) throw new Error('The driver package has a manifest format this version does not read. Update Maskrom Studio.');
  if (typeof o.version !== 'string' || !Array.isArray(o.drivers)) throw new Error('The driver package\'s manifest.json has no version or no driver list.');
  const strs = (x: unknown) => Array.isArray(x) && x.every((y) => typeof y === 'string');
  const seen = new Set<string>();
  for (const d of o.drivers) {
    if (!d || typeof d.dir !== 'string' || !SAFE_DIR.test(d.dir) || d.dir === '.' || d.dir === '..' || !strs(d.default) || !strs(d.optional)) {
      throw new Error('The driver package\'s manifest.json has an entry this version cannot read.');
    }
    if (seen.has(d.dir)) throw new Error(`The driver package names ${d.dir} twice.`);
    seen.add(d.dir);
    if (typeof d.what !== 'string') d.what = d.dir;
    if (!strs(d.infs)) d.infs = [];
    // Packages before the os column are for every Windows (they were built and tested on Windows 11).
    if (d.os === undefined) d.os = 'all';
    if (d.os !== 'all' && d.os !== 'win10' && d.os !== 'win11') throw new Error(`The driver package says ${d.dir} is for "${String(d.os)}", which this version does not know. Update Maskrom Studio.`);
  }
  return { format: 1, version: o.version, boards: strs(o.boards) ? o.boards! : [], sources: o.sources && typeof o.sources === 'object' ? o.sources : {}, drivers: o.drivers };
}

/**
 * The drivers the package installs on this board by default, in the
 * manifest's order, for the Windows build (as the package's install.cmd
 * picks: Windows 10 below 22000). No build: the Windows 11 list.
 */
export function boardDrivers(m: DriverManifest, board: BoardId, build?: number): PackageDriver[] {
  const family = build ? familyOfBuild(build) : 'win11';
  return m.drivers.filter((d) => d.default.includes(board) && (d.os === 'all' || d.os === family));
}

export interface PackageSelection {
  version: string;
  drivers: PackageDriver[];
  files: Array<{ path: string; data: Uint8Array }>;
}

/**
 * The board's drivers out of the unzipped package, as staging files under
 * rk3576-drivers/. Throws (and nothing is written) when the package lacks the
 * manifest, the board, a required driver or a listed driver's files, or when a
 * file does not match the package's SHA256SUMS.txt.
 */
export function selectPackage(entries: Array<{ path: string; data: Uint8Array }>, board: BoardId, build?: number): PackageSelection {
  const man = entries.find((e) => /(^|\/)rk3576-drivers\/manifest\.json$/.test(e.path));
  if (!man) throw new Error('The driver package has no rk3576-drivers/manifest.json.');
  const root = man.path.slice(0, man.path.length - 'manifest.json'.length);
  const m = parseManifest(new TextDecoder().decode(man.data));
  if (m.boards.length && !m.boards.includes(board)) throw new Error(`The driver package ${m.version} has no drivers for this board (${board}). Update Maskrom Studio.`);
  const picked = boardDrivers(m, board, build);
  for (const r of REQUIRED_DRIVERS) {
    if (!picked.some((d) => d.dir === r)) throw new Error(`The driver package ${m.version} has no ${r} for this board${build ? ` and Windows build ${build}` : ''}. Nothing was written.`);
  }
  const sumsEntry = entries.find((e) => e.path === `${root}SHA256SUMS.txt`);
  const sums = new Map<string, string>();
  if (sumsEntry) {
    for (const line of new TextDecoder().decode(sumsEntry.data).split(/\r?\n/)) {
      const x = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim());
      if (x) sums.set(x[2], x[1].toLowerCase());
    }
  }
  const files: PackageSelection['files'] = [];
  for (const d of picked) {
    const prefix = `${root}drivers/${d.dir}/`;
    const mine = entries.filter((e) => e.path.startsWith(prefix) && e.data.length > 0);
    if (!mine.some((e) => /\.inf$/i.test(e.path))) throw new Error(`The driver package ${m.version} has no .inf for ${d.dir}. Nothing was written.`);
    for (const e of mine) {
      const rest = e.path.slice(prefix.length);
      if (rest.split('/').some((p) => p === '' || p === '..' || /[\\:*?"<>|]/.test(p))) throw new Error(`The driver package has a file name that cannot be staged: ${e.path}`);
      const inner = e.path.slice(root.length);
      if (sumsEntry) {
        const want = sums.get(inner);
        if (!want) throw new Error(`The driver package's SHA256SUMS.txt does not list ${inner}. Nothing was written.`);
        if (bytesToHex(sha256(e.data)) !== want) throw new Error(`${inner} in the driver package does not match its SHA-256. Nothing was written.`);
      }
      files.push({ path: `${DRIVERS_STAGE_DIR}/${d.dir}/${rest}`, data: e.data });
    }
  }
  return { version: m.version, drivers: picked, files };
}

/**
 * What the setup page lists for a board beyond the drivers every board gets
 * (message keys, drivers.kind.*). The package's manifest decides what is
 * installed; this only words it, and the tests hold the two together.
 */
export const BOARD_EXTRA_KINDS: Record<BoardId, string[]> = {
  tspi3m: ['drivers.kind.touch', 'drivers.kind.bluetooth'],
  cm5io: ['drivers.kind.pwrkey'],
  rock4d: ['drivers.kind.pwrkey', 'drivers.kind.eeprom'],
};
