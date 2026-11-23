// An edk2-rk3576 eMMC image, as its release ships it (<Board>-emmc-edk2-<tag>.img,
// 32 MiB): GPT in the first sectors, the SPL/loader from sector 64 and, at
// sector 16384, a FIT (flattened device tree, magic d00dfeed) whose images
// follow it: ATF, the SPL DTB, edk2 (BL33) and nvdata, the UEFI variable
// store. The FIT's configuration description names the board's device tree
// ("rk3576-lckfb-tspi-3m"), and the edk2 image carries the build stamp as
// UTF-16 ("rk3576-TaishanPi3M-0.4.1" or "rk3576-TaishanPi3M-eb7e389").
// Read the same way from a file and from the board over MaskROM (all of it
// lies below 32 MiB, where the loader's reads are trusted).

import type { BoardId } from './boards';

export const SECTOR = 512;
export const FIT_LBA = 16384;
export const IMAGE_BYTES = 32 * 1024 * 1024;
/** The firmware write starts here; sectors 0..63 hold the partition table, which belongs to the installed system. */
export const FIRST_LBA = 64;
const FDT_MAGIC = 0xd00dfeed;

/** What edk2-rk3576 builds call each board, in the FIT and in the build stamp. */
export const EDK2_BOARDS: Partial<Record<BoardId, { dt: string; stamp: string }>> = {
  tspi3m: { dt: 'rk3576-lckfb-tspi-3m', stamp: 'TaishanPi3M' },
  cm5io: { dt: 'rk3576-armsom-cm5-io', stamp: 'CM5IO' },
};

export interface FitImage { offset: number; size: number }

export interface Fit {
  totalsize: number;
  description: string;
  /** The default configuration's description: the board's device tree name. */
  config: string;
  images: Record<string, FitImage>;
}

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** The FIT header at the start of `b` (a few KiB), or a sentence saying why it is not one. */
export function parseFit(b: Uint8Array): Fit | string {
  if (b.length < 40 || be32(b, 0) !== FDT_MAGIC) return 'There is no FIT (d00dfeed) at sector 16384.';
  const total = be32(b, 4);
  const offStruct = be32(b, 8);
  const offStrings = be32(b, 12);
  if (total > b.length || offStruct >= total || offStrings >= total) return 'The FIT header is larger than expected or damaged.';
  const str = (o: number) => { let e = o; while (e < total && b[e]) e++; return new TextDecoder().decode(b.subarray(o, e)); };
  const path: string[] = [];
  const images: Record<string, Partial<FitImage>> = {};
  let description = '';
  let defaultConf = '';
  const confDesc: Record<string, string> = {};
  for (let p = offStruct; p + 4 <= total;) {
    const tok = be32(b, p); p += 4;
    if (tok === 1) { const n = str(p); path.push(n); p = (p + n.length + 1 + 3) & ~3; }
    else if (tok === 2) path.pop();
    else if (tok === 3) {
      const len = be32(b, p);
      const name = str(offStrings + be32(b, p + 4));
      p += 8;
      const val = b.subarray(p, p + len);
      const text = () => new TextDecoder().decode(val).replace(/\0+$/, '');
      const where = path.join('/');
      if (where === '' && name === 'description') description = text();
      if (where === '/configurations' && name === 'default') defaultConf = text();
      const conf = /^\/configurations\/([^/]+)$/.exec(where);
      if (conf && name === 'description') confDesc[conf[1]] = text();
      const img = /^\/images\/([^/]+)$/.exec(where);
      if (img && len === 4 && (name === 'data-offset' || name === 'data-size')) {
        images[img[1]] ??= {};
        images[img[1]][name === 'data-offset' ? 'offset' : 'size'] = be32(val, 0);
      }
      p = (p + len + 3) & ~3;
    } else if (tok === 4) continue;
    else break;
  }
  const done: Record<string, FitImage> = {};
  for (const [k, v] of Object.entries(images)) if (v.offset !== undefined && v.size !== undefined) done[k] = v as FitImage;
  return { totalsize: total, description, config: confDesc[defaultConf] ?? '', images: done };
}

/** Where an image of the FIT lies on the eMMC (FIT data follows the header, 4-byte aligned). */
export function fitImageLba(fit: Fit, name: string): { lba: number; sectors: number; byte: number } | null {
  const i = fit.images[name];
  if (!i) return null;
  const byte = FIT_LBA * SECTOR + ((fit.totalsize + 3) & ~3) + i.offset;
  return { lba: byte / SECTOR, sectors: Math.ceil(i.size / SECTOR), byte };
}

/** The build stamp "rk3576-<Board>-<version>" stored as UTF-16 in the edk2 image, or null. */
export function findStamp(b: Uint8Array): { board: string; version: string } | null {
  const want = [0x72, 0, 0x6b, 0, 0x33, 0, 0x35, 0, 0x37, 0, 0x36, 0, 0x2d, 0]; // "rk3576-" in UTF-16LE
  outer: for (let i = 0; i + want.length < b.length; i++) {
    for (let j = 0; j < want.length; j++) if (b[i + j] !== want[j]) continue outer;
    let s = '';
    for (let o = i; o + 1 < b.length && b[o + 1] === 0 && b[o] >= 0x20 && b[o] < 0x7f && s.length < 80; o += 2) s += String.fromCharCode(b[o]);
    const m = /^rk3576-([A-Za-z0-9]+)-([\w.+-]+)$/.exec(s);
    if (m && /[0-9]/.test(m[2])) return { board: m[1], version: m[2] };
  }
  return null;
}

export interface FirmwareInfo {
  /** "0.4.1" or a commit; null when the stamp was not found. */
  version: string | null;
  /** The board the image is for, when the FIT or the stamp names one of ours. */
  board: BoardId | null;
  /** What names it: the FIT configuration and the stamp's board. */
  dt: string;
  stampBoard: string | null;
  nvdata: { lba: number; sectors: number };
  edk2: { lba: number; sectors: number };
}

/** The board both names agree on (or the one that is there); null when they disagree or name none of ours. */
function boardOf(dt: string, stamp: string | null): BoardId | null {
  const byDt = Object.entries(EDK2_BOARDS).find(([, b]) => b!.dt === dt)?.[0] as BoardId | undefined;
  const byStamp = stamp ? Object.entries(EDK2_BOARDS).find(([, b]) => b!.stamp === stamp)?.[0] as BoardId | undefined : undefined;
  if (byDt && byStamp && byDt !== byStamp) return null;
  return byDt ?? byStamp ?? null;
}

/**
 * Read an edk2-rk3576 eMMC firmware through `read(byteOffset, length)`:
 * a file, or the board's eMMC over MaskROM. A sentence when it is not one.
 */
export async function readFirmware(read: (offset: number, length: number) => Promise<Uint8Array | null> | Uint8Array | null): Promise<FirmwareInfo | string> {
  const head = await read(FIT_LBA * SECTOR, 8192);
  if (!head) return 'The FIT at sector 16384 could not be read.';
  const fit = parseFit(head);
  if (typeof fit === 'string') return fit;
  const nv = fitImageLba(fit, 'nvdata');
  const edk2 = fitImageLba(fit, 'edk2');
  if (!edk2) return 'The FIT has no edk2 image.';
  if (!nv) return 'The FIT has no nvdata (UEFI settings) image.';
  if (nv.byte % SECTOR || (nv.lba + nv.sectors) * SECTOR > IMAGE_BYTES || (edk2.lba + edk2.sectors) * SECTOR > IMAGE_BYTES) {
    return 'The FIT places its images outside the first 32 MiB.';
  }
  const body = await read(edk2.lba * SECTOR, edk2.sectors * SECTOR);
  const stamp = body ? findStamp(body) : null;
  return {
    version: stamp?.version ?? null, board: boardOf(fit.config, stamp?.board ?? null), dt: fit.config, stampBoard: stamp?.board ?? null,
    nvdata: { lba: nv.lba, sectors: nv.sectors }, edk2: { lba: edk2.lba, sectors: edk2.sectors },
  };
}

/** An nvdata slot holds a firmware volume: "_FVH" at byte 0x28. */
export function isVariableStore(b: Uint8Array): boolean {
  return b.length > 0x2c && b[0x28] === 0x5f && b[0x29] === 0x46 && b[0x2a] === 0x56 && b[0x2b] === 0x48;
}

/** An empty slot as the release ships it: all 0xFF (the firmware builds the store on first start). */
export function isEmptySlot(b: Uint8Array): boolean {
  return b.every((x) => x === 0xff);
}
