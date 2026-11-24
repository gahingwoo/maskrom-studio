// The two restores' downloads and files, on the PC side: Armbian's current
// image for a board (found through Armbian's redirector, checked against its
// .sha and its OpenPGP signature), and a factory update.img the user chose
// (read and its MD5 checked). No Electron here; main.ts passes net.fetch.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileSource } from '../helper/board-write';
import { readPublicKey, readSignature, signatureVerifier } from '../shared/openpgp';
import { ARMBIAN_INDEX, ARMBIAN_RESTORE, ARMBIAN_SIGNING_KEY, armbianRedirect, isDesktop, minimumDiskBytes, OFFER_ID, parseArmbianFileName, parseArmbianIndex, parseShaLine, xzUncompressedSize, type ArmbianBranch, type ArmbianOffer } from '../woa/armbian-restore';
import type { BoardId } from '../woa/boards';
import { readUpdateImage, type UpdateImage } from '../woa/rkfw';

export type FetchFn = (url: string, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface ArmbianImage {
  board: BoardId;
  /** The offer: "Resolute_vendor_gnome". */
  id: string;
  branch: ArmbianBranch;
  file: string;
  /** Where the redirector sent the download (GitHub or a mirror). */
  url: string;
  size: number;
  sha256: string;
  /** The armored detached signature, checked after the download. */
  asc: string;
  version: string;
  kernel: string;
  distro: string;
  variant: string;
  /** When Armbian signed it (the signature's creation time). */
  signed: string | null;
  desktop: boolean;
  /** The decompressed image, from the .xz index at the end of the file; null when the server would not say. */
  imageBytes: number | null;
  /** The smallest disk it is written to (minimumDiskBytes); null with imageBytes. */
  minBytes: number | null;
}

async function text(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<string> {
  const r = await fetchFn(url, { signal });
  if (!r.ok) throw new Error(`Armbian answered HTTP ${r.status} for ${url}.`);
  return r.text();
}

/** What Armbian publishes for the board, from its image index (armbian-restore.ts). */
export async function listArmbian(board: BoardId, fetchFn: FetchFn, signal?: AbortSignal): Promise<ArmbianOffer[]> {
  const b = ARMBIAN_RESTORE[board];
  if (!b) throw new Error('Armbian has no image for this board.');
  const r = await fetchFn(ARMBIAN_INDEX, { signal });
  if (!r.ok) throw new Error(`Armbian answered HTTP ${r.status} for ${ARMBIAN_INDEX}.`);
  const offers = parseArmbianIndex(await r.json(), b.slug);
  if (offers.length === 0) throw new Error(`Armbian's image index lists no image for ${b.slug}.`);
  return offers;
}

/** The size of the decompressed image, read from the last 64 KiB of the .img.xz (one ranged request); null if that does not work. */
async function imageBytesOf(fetchFn: FetchFn, url: string, size: number, signal?: AbortSignal): Promise<number | null> {
  try {
    const from = Math.max(0, size - 65536);
    const r = await fetchFn(url, { signal, headers: { Range: `bytes=${from}-${size - 1}` } });
    if (r.status !== 206) return null;
    const tail = new Uint8Array(await r.arrayBuffer());
    return tail.length === size - from ? xzUncompressedSize(tail) : null;
  } catch {
    return null;
  }
}

/** One image of the board (an offer's id), from Armbian's redirector. Nothing is downloaded but its .sha, .asc and the end of the file. */
export async function findArmbian(board: BoardId, id: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<ArmbianImage> {
  const b = ARMBIAN_RESTORE[board];
  if (!b) throw new Error('Armbian has no image for this board.');
  if (!OFFER_ID.test(id)) throw new Error(`Not an Armbian image name: ${id}`);
  const [distro, branch, variant] = id.split('_');
  const redirect = armbianRedirect(b, id);
  const sha = parseShaLine(await text(fetchFn, `${redirect}.sha`, signal));
  if (!sha) throw new Error('Armbian\'s .sha file for the image could not be read.');
  const name = parseArmbianFileName(sha.file);
  if (!name) throw new Error(`Armbian's current image has a name this app does not know how to read: ${sha.file}`);
  if (name.board.toLowerCase() !== b.slug || name.branch !== branch || name.distro !== distro.toLowerCase()
    || (name.variant !== variant && name.variant !== `${variant}_desktop`)) {
    throw new Error(`Armbian's redirector answered with ${sha.file}, which is not the ${id} image for ${b.slug}.`);
  }
  const asc = await text(fetchFn, `${redirect}.asc`, signal);
  const sig = readSignature(asc);
  const head = await fetchFn(redirect, { method: 'HEAD', signal });
  if (!head.ok) throw new Error(`Armbian answered HTTP ${head.status} for ${redirect}.`);
  const size = Number(head.headers.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) throw new Error('The download server did not say how large the image is.');
  const url = head.url || redirect;
  if (!url.startsWith('https://')) throw new Error(`Armbian's redirector sent the download to ${url}, which is not HTTPS.`);
  // The mirror's own path does not matter: the file must match the .sha and the signature.
  const desktop = isDesktop(variant);
  const imageBytes = await imageBytesOf(fetchFn, url, size, signal);
  return {
    board, id, branch, file: sha.file, url, size, sha256: sha.sha256, asc,
    version: name.version, kernel: name.kernel, distro: name.distro, variant,
    signed: sig.created ? sig.created.toISOString().slice(0, 10) : null,
    desktop, imageBytes, minBytes: imageBytes === null ? null : minimumDiskBytes(imageBytes, desktop),
  };
}

/** Check the downloaded .img.xz against Armbian's signature; a sentence when it does not match. */
export async function checkArmbianSignature(path: string, asc: string, onBytes?: (done: number) => void, signal?: AbortSignal): Promise<string | null> {
  const key = readPublicKey(Uint8Array.from(Buffer.from(ARMBIAN_SIGNING_KEY.packet, 'base64')));
  if (key.fingerprint !== ARMBIAN_SIGNING_KEY.fingerprint) throw new Error('The pinned Armbian key does not have its fingerprint.');
  const v = signatureVerifier(readSignature(asc), key);
  let done = 0;
  for await (const c of createReadStream(path, { highWaterMark: 4 << 20, signal })) {
    v.update(c as Buffer);
    done += (c as Buffer).length;
    onBytes?.(done);
  }
  const why = v.verify();
  return why ? `The image's OpenPGP signature does not check out: ${why}` : null;
}

export interface FactoryImage {
  path: string;
  fileName: string;
  size: number;
  info: UpdateImage;
}

export function inspectFactory(path: string): FactoryImage {
  const f = fileSource(path);
  try {
    return { path, fileName: basename(path), size: f.size, info: readUpdateImage(f) };
  } finally {
    f.close();
  }
}

/** The MD5 the packer appended after the data: null when it matches (or there is none), else a sentence. */
export async function checkFactoryMd5(img: FactoryImage, onBytes?: (done: number, total: number) => void, signal?: AbortSignal): Promise<string | null> {
  if (!img.info.md5) return null;
  const h = createHash('md5');
  let done = 0;
  const total = img.info.dataEnd;
  for await (const c of createReadStream(img.path, { start: 0, end: total - 1, highWaterMark: 4 << 20, signal })) {
    h.update(c as Buffer);
    done += (c as Buffer).length;
    onBytes?.(done, total);
  }
  const sum = h.digest('hex');
  return sum === img.info.md5 ? null : `The update.img does not match the MD5 inside it (${sum}, expected ${img.info.md5}). The file is damaged or incomplete.`;
}
