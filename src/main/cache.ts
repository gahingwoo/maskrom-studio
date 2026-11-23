// What the app keeps that can be thrown away, and throwing it away: the
// downloaded images (firmware, WinPE, Armbian, OpenSSH: <data>/images) and
// the MaskROM loader pieces (<data>/loaders). The copies of boards' UEFI
// settings (<data>/nvdata-backups) are listed apart and deleted only when
// asked for by name. No Electron here; main.ts passes the data folder.

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface CachePart { dir: string; bytes: number; files: number; names: string[] }
export interface CacheInfo { images: CachePart; loaders: CachePart; nvdata: CachePart }

function measure(dir: string): CachePart {
  const out: CachePart = { dir, bytes: 0, files: 0, names: [] };
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else { out.bytes += st.size; out.files++; }
    }
  };
  walk(dir);
  out.names = readdirSync(dir).sort();
  return out;
}

export function cacheInfo(dataDir: string): CacheInfo {
  return {
    images: measure(join(dataDir, 'images')),
    loaders: measure(join(dataDir, 'loaders')),
    nvdata: measure(join(dataDir, 'nvdata-backups')),
  };
}

export type ClearResult = { ok: true; freed: number; kept: CacheInfo } | { ok: false; reason: string };

/**
 * Delete the downloads and the loader pieces; the UEFI settings copies only
 * with `nvdata`. Refused while a job runs: it may be reading or writing them.
 */
export function clearCache(dataDir: string, o: { nvdata: boolean; busy: boolean }): ClearResult {
  if (o.busy) return { ok: false, reason: 'A write is running. Clear the cache when it has finished.' };
  const before = cacheInfo(dataDir);
  const parts = [before.images, before.loaders, ...(o.nvdata ? [before.nvdata] : [])];
  for (const p of parts) rmSync(p.dir, { recursive: true, force: true });
  const kept = cacheInfo(dataDir);
  const freed = parts.reduce((s, p) => s + p.bytes, 0) - (kept.images.bytes + kept.loaders.bytes + (o.nvdata ? kept.nvdata.bytes : 0));
  return { ok: true, freed, kept };
}
