// Downloading a release file into the cache, checked against the catalog.
// One file, or an image a release carries in parts (roxora-os/build
// docs/release-contract.md, "Images in parts"): the parts are downloaded in
// order and appended to one file, which is the image. No Electron here, so
// the tests run it against a local server.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CatalogImage } from '../shared/catalog';

export type Progress = (p: { stage: 'download' | 'check' | 'decompress'; bytes: number; total: number }) => void;

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** A release file the catalog describes: the .img.xz (whole or in parts), or the SPI image. */
export type ReleaseFile = Pick<CatalogImage, 'file' | 'url' | 'size' | 'sha256' | 'sample'> & Partial<Pick<CatalogImage, 'parts'>>;

async function sha256File(path: string, total: number, progress: Progress): Promise<string> {
  const h = createHash('sha256');
  let done = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    h.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    progress({ stage: 'check', bytes: done, total });
  }
  return h.digest('hex');
}

/**
 * A release file in the cache, downloaded if needed, always checked against
 * the catalog's sha256 before it is used.
 *
 * An image in parts is downloaded part after part into one `<file>.part`
 * file, with the progress counted over the whole image. Each part is checked
 * against its own size and SHA-256 as it ends, so a bad part stops the
 * download there, and the joined file against the image's. A failure or a
 * cancel removes what was downloaded, as for a file that is one download.
 */
export async function downloadReleaseFile(img: ReleaseFile, cacheDir: string, progress: Progress,
  signal: AbortSignal | undefined, fetchFn: FetchFn): Promise<string> {
  if (img.sample) throw new Error('Sample entries cannot be downloaded or written.');
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, img.file);
  if (existsSync(dest) && statSync(dest).size === img.size) {
    if (await sha256File(dest, img.size, progress) === img.sha256) return dest;
    rmSync(dest, { force: true });
  }
  const sources = img.parts && img.parts.length > 0
    ? img.parts.map((p, i) => ({ url: p.url, size: p.size, sha256: p.sha256, name: `part ${i + 1} of ${img.parts!.length}` }))
    : [{ url: img.url, size: img.size, sha256: img.sha256, name: '' }];
  const part = `${dest}.part`;
  const whole = createHash('sha256');
  let done = 0;
  try {
    for (const [i, src] of sources.entries()) {
      const r = await fetchFn(src.url, { signal });
      if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}${src.name ? ` for ${src.name}` : ''}`);
      const h = createHash('sha256');
      let got = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          h.update(chunk);
          whole.update(chunk);
          got += chunk.length;
          done += chunk.length;
          progress({ stage: 'download', bytes: done, total: img.size });
          cb(null, chunk);
        },
      });
      // The first source starts the file; the others are appended to it.
      await pipeline(Readable.fromWeb(r.body as never), count, createWriteStream(part, { flags: i === 0 ? 'w' : 'a' }), { signal });
      if (sources.length > 1) {
        const sum = h.digest('hex');
        if (got !== src.size || sum !== src.sha256) {
          throw new Error(`The download of ${src.name} does not match the release (sha256 ${sum}, expected ${src.sha256}).`);
        }
      }
    }
    const sum = whole.digest('hex');
    if (done !== img.size || sum !== img.sha256) {
      throw new Error(`The download does not match the release (sha256 ${sum}, expected ${img.sha256}).`);
    }
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, dest);
  return dest;
}
