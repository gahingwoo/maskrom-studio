// Saving an image as a plain .img file instead of writing it to a drive,
// for Ventoy and similar boot-from-file devices and for virtual machines.
// No administrator rights: the app itself writes the file, where the user
// chose to put it. No Electron here, so the tests can load it.
//
// The image is decompressed into a temporary file next to the chosen
// name, hashed on the way, and renamed to that name only once its size and
// SHA-256 match the release (or, for a custom image, once it is complete). A
// cancelled, failed or mismatching save leaves nothing under the chosen
// name, and a file that was there before stays as it was.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { formatBytes } from '../shared/format';
import { openImage, type ImageSource } from './image-source';

/** Bytes free for this user in the file system that holds `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export interface SaveOptions {
  /** The image to save: .img.xz, .img.gz, .img.bz2 or a plain image. */
  source: string;
  /** Where it goes, as chosen in the save dialog. */
  dest: string;
  /** Size and SHA-256 the decompressed image must have (the release's extract_size and extract_sha256); null for a custom image. */
  expected: { size: number; sha256: string } | null;
  /** For a custom image: its decompressed size when known, else 0. */
  sizeHint?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** Stand-ins for tests. */
  open?: (path: string) => Promise<ImageSource>;
  freeSpace?: (dir: string) => Promise<number>;
}

/** Save the decompressed image under `dest`. Throws, with words for the user, when nothing was saved. */
export async function saveImage(o: SaveOptions): Promise<{ path: string; size: number; sha256: string }> {
  const dest = resolve(o.dest);
  const dir = dirname(dest);
  if (dest === resolve(o.source)) {
    throw new Error('The image cannot be saved over the file it is read from. Choose another name. Nothing was saved.');
  }
  // A gzip or bzip2 custom image does not tell its size before it is read:
  // then a full disk shows as ENOSPC below.
  const need = o.expected?.size ?? o.sizeHint ?? 0;
  if (need > 0) {
    // Where the system cannot tell, the save goes ahead and a full disk stops it.
    const free = await (o.freeSpace ?? freeBytes)(dir).catch(() => Infinity);
    if (free < need) {
      throw new Error(`There is not enough free space in ${dir}: the image needs ${formatBytes(need)}, `
        + `${formatBytes(free)} is free. Nothing was saved.`);
    }
  }
  const tmp = join(dir, `.${basename(dest)}.${randomBytes(4).toString('hex')}.part`);
  const src = await (o.open ?? openImage)(o.source);
  const h = createHash('sha256');
  let size = 0;
  const count = new Transform({
    highWaterMark: 4 << 20,
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      size += chunk.length;
      // A total of 0: the size is not known before the end (gzip, bzip2).
      o.onProgress?.(size, need && Math.max(need, size));
      cb(null, chunk);
    },
  });
  try {
    // wx: the temporary name is new; never write into a file that is there.
    await pipeline(src.stream, count, createWriteStream(tmp, { flags: 'wx' }), { signal: o.signal });
    const sha256 = h.digest('hex');
    if (size === 0) throw new Error('The image is empty. Nothing was saved.');
    if (o.expected && (size !== o.expected.size || sha256 !== o.expected.sha256)) {
      throw new Error(`The decompressed image does not match the release: ${size} bytes, SHA-256 ${sha256}; `
        + `the release has ${o.expected.size} bytes, ${o.expected.sha256}. Nothing was saved.`);
    }
    await rename(tmp, dest);
    return { path: dest, size, sha256 };
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new Error(`The disk that holds ${dir} is full. Nothing was saved.`);
    }
    throw e;
  } finally {
    await src.close();
  }
}
