// The two releases the app installs from: edk2-rk3576 (the UEFI firmware,
// the images edk2-webflash bundles) and woa-rk3576 (the WinPE image with the
// drivers and deploy scripts). Each file is checked against the release's
// SHA256SUMS.txt, and against the SHA-256 digest GitHub publishes for the
// asset when there is one; the two must agree.

import type { BoardId } from './boards';
import { WOA_BOARDS } from './boards';
import { pickRelease, type Channel } from '../shared/channel';
import { DRIVERS_ASSET } from './driver-package';
import { builtinFeatures, checkedFeatures, FEATURES_ASSET, type ReleaseFeatures } from './firmware-features';

export const FIRMWARE_REPO = 'gahingwoo/edk2-rk3576';
export const WINPE_REPO = 'gahingwoo/woa-rk3576';

export interface ReleaseAsset {
  file: string;
  url: string;
  size: number;
  sha256: string;
  sample: false;
}

export interface GithubAsset { name: string; size: number; browser_download_url: string; digest?: string | null }
export interface GithubRelease { tag_name: string; name?: string; body?: string | null; draft?: boolean; prerelease?: boolean; html_url?: string; target_commitish?: string; assets: GithubAsset[] }

export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim());
    if (m) out.set(m[2].trim().replace(/^\.\//, ''), m[1].toLowerCase());
  }
  return out;
}

function asset(rel: GithubRelease, sums: Map<string, string>, name: string): ReleaseAsset | string {
  const a = rel.assets.find((x) => x.name === name);
  if (!a) return `${rel.tag_name} has no ${name}`;
  const sum = sums.get(name);
  const digest = a.digest?.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null;
  if (!sum && !digest) return `${rel.tag_name} gives no SHA-256 for ${name}`;
  if (sum && digest && sum !== digest) return `${rel.tag_name}: SHA256SUMS.txt and GitHub disagree about ${name}`;
  return { file: name, url: a.browser_download_url, size: a.size, sha256: (sum ?? digest)!, sample: false };
}

export interface FirmwareRelease {
  tag: string;
  url: string | null;
  images: Partial<Record<BoardId, ReleaseAsset>>;
  /** The SD card variant (<Board>-sdcard-edk2-<tag>.img), for the boards whose release has one. */
  sdcard: Partial<Record<BoardId, ReleaseAsset>>;
  /** What each board's image supports: the release's FEATURES.json (loadFirmwareFeatures), else the built-in table. */
  features: ReleaseFeatures;
  problems: string[];
}

export function firmwareRelease(rel: GithubRelease, sums: Map<string, string>): FirmwareRelease {
  const images: FirmwareRelease['images'] = {};
  const problems: string[] = [];
  for (const b of WOA_BOARDS) {
    const name = rel.assets.map((a) => a.name).find((n) => n.startsWith(b.firmwareAsset) && n.endsWith('.img'));
    if (!name) { problems.push(`${rel.tag_name} has no ${b.firmwareAsset}*.img`); continue; }
    const a = asset(rel, sums, name);
    if (typeof a === 'string') problems.push(a); else images[b.id] = a;
  }
  const sdcard: FirmwareRelease['sdcard'] = {};
  for (const b of WOA_BOARDS) {
    const prefix = b.firmwareAsset.replace('-emmc-edk2-', '-sdcard-edk2-');
    if (prefix === b.firmwareAsset) continue;
    const name = rel.assets.map((x) => x.name).find((n) => n.startsWith(prefix) && n.endsWith('.img'));
    if (!name) continue;
    const a = asset(rel, sums, name);
    if (typeof a === 'string') problems.push(a); else sdcard[b.id] = a;
  }
  return { tag: rel.tag_name, url: rel.html_url ?? null, images, sdcard, features: builtinFeatures(rel.tag_name), problems };
}

/**
 * Read the release's FEATURES.json into fw.features, checked like the images
 * (SHA256SUMS.txt and GitHub's digest). Optional: a release without one keeps
 * the built-in table; one that cannot be read or checked keeps it too and
 * adds a problem.
 */
export async function loadFirmwareFeatures(fw: FirmwareRelease, rel: GithubRelease, sums: Map<string, string>, fetchFn: Fetch): Promise<FirmwareRelease> {
  if (!rel.assets.some((a) => a.name === FEATURES_ASSET)) return fw;
  const a = asset(rel, sums, FEATURES_ASSET);
  if (typeof a === 'string') return { ...fw, problems: [...fw.problems, a] };
  try {
    const r = await fetchFn(a.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const boards = checkedFeatures(new Uint8Array(await r.arrayBuffer()), a.sha256);
    return { ...fw, features: { from: 'release', boards } };
  } catch (e) {
    return { ...fw, problems: [...fw.problems, `${rel.tag_name}: ${FEATURES_ASSET}: ${(e as Error).message}`] };
  }
}

export interface WinpeRelease {
  tag: string;
  url: string | null;
  image: ReleaseAsset | null;
  /** The RK3576 tools bundle (rk-monitor, NPU tools; woa-rk3576 tools/rk3576-tools), when the release has it. */
  tools?: ReleaseAsset | null;
  /** The RK3576 Windows driver package (driver-package.ts; woa-rk3576 tools/rk3576-drivers), when the release has it. */
  drivers?: ReleaseAsset | null;
  problems: string[];
}

/** The RK3576 tools bundle's asset name. */
export const TOOLS_ASSET = /^rk3576-tools-arm64.*\.zip$/;

export function winpeRelease(rel: GithubRelease, sums: Map<string, string>): WinpeRelease {
  const name = rel.assets.map((a) => a.name).find((n) => /^woa-rk3576-winpe-.*\.img\.xz$/.test(n));
  if (!name) return { tag: rel.tag_name, url: rel.html_url ?? null, image: null, problems: [`${rel.tag_name} has no woa-rk3576-winpe-*.img.xz`] };
  const a = asset(rel, sums, name);
  const toolsName = rel.assets.map((x) => x.name).find((n) => TOOLS_ASSET.test(n));
  const t = toolsName ? asset(rel, sums, toolsName) : null;
  const tools = t && typeof t !== 'string' ? t : null;
  const driversName = rel.assets.map((x) => x.name).find((n) => DRIVERS_ASSET.test(n));
  const dr = driversName ? asset(rel, sums, driversName) : null;
  const drivers = dr && typeof dr !== 'string' ? dr : null;
  const later = [t, dr].filter((x): x is string => typeof x === 'string');
  return typeof a === 'string'
    ? { tag: rel.tag_name, url: rel.html_url ?? null, image: null, tools, drivers, problems: [a, ...later] }
    : { tag: rel.tag_name, url: rel.html_url ?? null, image: a, tools, drivers, problems: later };
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** The latest release of `repo` and its SHA256SUMS.txt. */
/** The release of `repo` that `channel` means (channel.ts), with its SHA256SUMS. */
export async function tierRelease(repo: string, channel: Channel, fetchFn: Fetch): Promise<{ rel: GithubRelease; sums: Map<string, string> }> {
  const r = await fetchFn(`https://api.github.com/repos/${repo}/releases?per_page=50`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for the ${repo} releases`);
  const rel = pickRelease(await r.json() as GithubRelease[], channel);
  if (!rel) throw new Error(channel === 'ci' ? `${repo} has no CI build release (tag ci)` : `${repo} has no ${channel} release`);
  const sumsAsset = rel.assets.find((a) => a.name === 'SHA256SUMS.txt' || a.name === 'SHA256SUMS');
  let sums = new Map<string, string>();
  if (sumsAsset) {
    const s = await fetchFn(sumsAsset.browser_download_url);
    if (!s.ok) throw new Error(`Downloading ${sumsAsset.name} of ${repo} ${rel.tag_name} failed: HTTP ${s.status}`);
    sums = parseSums(await s.text());
  }
  return { rel, sums };
}
