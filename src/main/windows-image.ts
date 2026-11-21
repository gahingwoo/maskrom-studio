// The Windows image the user chose: an ISO, an install.wim or an
// install.esd. Read in place (src/woa/udf.ts finds install.wim inside an
// ISO), checked before the board is involved: editions, ARM64, build at most
// 25999. No Electron here, so the tests use it directly.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileSource } from '../helper/board-write';
import type { ByteSource } from '../woa/pieces';
import { UdfVolume, extentSource, type Extent } from '../woa/udf';
import { installable, readWimInfo, refuseReason, whyNotWholeImage, type WimImage } from '../woa/wim';

export interface Edition {
  index: number;
  name: string;
  build: number | null;
  spBuild: number | null;
  arch: number | null;
  /** Why it cannot be installed on RK3576, or null. */
  refuse: string | null;
  totalBytes: number;
}

export interface WindowsImage {
  path: string;
  fileName: string;
  container: 'iso' | 'wim' | 'esd';
  /** The name the image gets on the staging volume. */
  imageName: 'install.wim' | 'install.esd';
  imageSize: number;
  /** Where install.wim/esd is inside the ISO; null for a .wim or .esd file. */
  extents: Extent[] | null;
  fileSize: number;
  editions: Edition[];
}

export function inspectWindowsImage(path: string): WindowsImage {
  const file = fileSource(path);
  try {
    let container: WindowsImage['container'];
    let extents: Extent[] | null = null;
    let imageName: WindowsImage['imageName'] = 'install.wim';
    let src: ByteSource = file;
    const magic = new TextDecoder('latin1').decode(file.read(0, Math.min(8, file.size)));
    if (magic === 'MSWIM\0\0\0') {
      container = /\.esd$/i.test(path) ? 'esd' : 'wim';
      imageName = container === 'esd' ? 'install.esd' : 'install.wim';
    } else {
      const udf = new UdfVolume(file);
      const f = udf.find('sources/install.wim') ?? udf.find('sources/install.esd');
      if (!f) {
        if (udf.find('sources/install.swm')) throw new Error('This ISO has a split install image (install.swm). Use an ISO with one install.wim or install.esd.');
        throw new Error('This ISO has no sources\\install.wim or sources\\install.esd. Is it a Windows installation ISO?');
      }
      container = 'iso';
      imageName = /\.esd$/i.test(f.path) ? 'install.esd' : 'install.wim';
      extents = f.extents;
      src = extentSource(file, f);
    }
    const info = readWimInfo(src);
    const whole = whyNotWholeImage(info);
    if (whole) throw new Error(whole);
    const editions = installable(info).map((i: WimImage) => ({
      index: i.index, name: i.displayName || i.name, build: i.build, spBuild: i.spBuild, arch: i.arch,
      refuse: refuseReason(i), totalBytes: i.totalBytes,
    }));
    if (editions.length === 0) throw new Error('The image lists no Windows editions to install.');
    return { path, fileName: basename(path), container, imageName, imageSize: src.size, extents, fileSize: file.size, editions };
  } finally {
    file.close();
  }
}

/** SHA-256 of the image's own bytes (inside the ISO, where it is in one). */
export async function hashWindowsImage(img: WindowsImage, onBytes: (done: number) => void, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  let done = 0;
  const ranges = img.extents ?? [{ offset: 0, length: img.fileSize }];
  for (const r of ranges) {
    if (r.length === 0) continue;
    for await (const c of createReadStream(img.path, { start: r.offset, end: r.offset + r.length - 1, highWaterMark: 4 << 20, signal })) {
      h.update(c as Buffer);
      done += (c as Buffer).length;
      onBytes(done);
    }
  }
  if (done !== img.imageSize) throw new Error('The image file changed while it was read.');
  return h.digest('hex');
}
