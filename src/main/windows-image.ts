// The Windows image the user chose: an ISO, an install.wim or an
// install.esd. Read in place (src/woa/udf.ts finds install.wim inside an
// ISO), checked before the board is involved: editions, ARM64 (the XML's
// ARCH, and in an ISO its EFI boot file names too), and a build that is one
// of the releases in shared/windows-version.ts (Windows 10 19041 to 19045,
// Windows 11 22000, 22621, 22631). No Electron here, so the tests use it
// directly.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileSource } from '../helper/board-write';
import type { ByteSource } from '../woa/pieces';
import { windowsVersion, type WindowsVersion } from '../shared/windows-version';
import { UdfVolume, extentSource, type Extent } from '../woa/udf';
import { archName, bootFilesFrom, bootFilesProblem, checkEdition, installable, readWimInfo, releaseName, whyNotWholeImage, type BootFiles, type EditionCheck, type WimImage } from '../woa/wim';

export interface Edition {
  index: number;
  name: string;
  build: number | null;
  spBuild: number | null;
  arch: number | null;
  archName: string;
  /** "Windows 11 23H2", or null for a preview build. */
  release: string | null;
  /** The release, when it is one this app installs (shared/windows-version.ts); null when refused. */
  version: WindowsVersion | null;
  languages: string[];
  /** Why it cannot be installed on RK3576, or null. */
  refuse: string | null;
  check: EditionCheck;
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
  /** The names found in an ISO's efi\boot folder; null for a .wim or .esd file, or an ISO without one. */
  boot: BootFiles | null;
  /** Why the image as a whole is refused (an x64 ISO), or null. Every edition is then refused too. */
  refuse: string | null;
  editions: Edition[];
}

export function inspectWindowsImage(path: string): WindowsImage {
  const file = fileSource(path);
  try {
    let container: WindowsImage['container'];
    let extents: Extent[] | null = null;
    let imageName: WindowsImage['imageName'] = 'install.wim';
    let src: ByteSource = file;
    let boot: BootFiles | null = null;
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
      const names = udf.names('efi/boot');
      boot = names ? bootFilesFrom(names) : null;
      src = extentSource(file, f);
    }
    const info = readWimInfo(src);
    const whole = whyNotWholeImage(info);
    if (whole) throw new Error(whole);
    const found = installable(info);
    if (found.length === 0) throw new Error('The image lists no Windows editions to install.');
    const refuse = bootFilesProblem(boot, found);
    const editions = found.map((i: WimImage): Edition => {
      const check = checkEdition(i);
      return {
        index: i.index, name: i.displayName || i.name, build: i.build, spBuild: i.spBuild, arch: i.arch,
        archName: archName(i.arch), release: releaseName(i.build), version: check.level === 'ok' ? windowsVersion(i.build) : null, languages: i.languages,
        refuse: refuse ?? (check.level === 'refuse' ? check.text : null),
        check, totalBytes: i.totalBytes,
      };
    });
    return { path, fileName: basename(path), container, imageName, imageSize: src.size, extents, fileSize: file.size, boot, refuse, editions };
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

