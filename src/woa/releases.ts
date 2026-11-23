// The two releases the app installs from: edk2-rk3576 (the UEFI firmware,
// the images edk2-webflash bundles) and woa-rk3576 (the WinPE image with the
// drivers and deploy scripts). Each file is checked against the release's
// SHA256SUMS.txt, and against the SHA-256 digest GitHub publishes for the
// asset when there is one; the two must agree.

import type { BoardId } from './boards';
import { WOA_BOARDS } from './boards';

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
export interface GithubRelease { tag_name: string; name?: string; draft?: boolean; prerelease?: boolean; html_url?: string; assets: GithubAsset[] }

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
  return { tag: rel.tag_name, url: rel.html_url ?? null, images, sdcard, problems };
}

export interface WinpeRelease {
  tag: string;
  url: string | null;
  image: ReleaseAsset | null;
  problems: string[];
}

export function winpeRelease(rel: GithubRelease, sums: Map<string, string>): WinpeRelease {
  const name = rel.assets.map((a) => a.name).find((n) => /^woa-rk3576-winpe-.*\.img\.xz$/.test(n));
  if (!name) return { tag: rel.tag_name, url: rel.html_url ?? null, image: null, problems: [`${rel.tag_name} has no woa-rk3576-winpe-*.img.xz`] };
  const a = asset(rel, sums, name);
  return typeof a === 'string'
    ? { tag: rel.tag_name, url: rel.html_url ?? null, image: null, problems: [a] }
    : { tag: rel.tag_name, url: rel.html_url ?? null, image: a, problems: [] };
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** The latest release of `repo` and its SHA256SUMS.txt. */
export async function latestRelease(repo: string, fetchFn: Fetch): Promise<{ rel: GithubRelease; sums: Map<string, string> }> {
  const r = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for the ${repo} releases`);
  const rel = await r.json() as GithubRelease;
  const sumsAsset = rel.assets.find((a) => a.name === 'SHA256SUMS.txt');
  let sums = new Map<string, string>();
  if (sumsAsset) {
    const s = await fetchFn(sumsAsset.browser_download_url);
    if (!s.ok) throw new Error(`Downloading SHA256SUMS.txt of ${repo} ${rel.tag_name} failed: HTTP ${s.status}`);
    sums = parseSums(await s.text());
  }
  return { rel, sums };
}
