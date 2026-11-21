// Find a file in a Windows ISO and say where its bytes are, so that
// sources/install.wim is read straight out of the ISO while it is written to
// the board: no mounting (which differs on every system and sometimes needs
// administrator rights), no copy of a 5 GB file.
//
// Windows ISOs are UDF 1.02 with an ISO 9660 bridge; files over 4 GiB exist
// only in the UDF view, so UDF is what is read. This handles what oscdimg
// and the UUP converters write: one type 1 (physical) partition map, File
// Entries or Extended File Entries with short or long allocation
// descriptors. Anything else is refused with a sentence, never guessed at.

import type { ByteSource } from './pieces';

const BLOCK = 2048;

export interface Extent {
  /** Byte offset in the ISO. */
  offset: number;
  length: number;
}

export interface IsoFile {
  path: string;
  size: number;
  extents: Extent[];
}

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le64 = (b: Uint8Array, o: number) => le32(b, o) + le32(b, o + 4) * 2 ** 32;

function tagId(b: Uint8Array): number {
  return le16(b, 0);
}

function dstring(b: Uint8Array): string {
  if (b.length === 0) return '';
  const comp = b[0];
  if (comp === 8) return new TextDecoder('latin1').decode(b.subarray(1));
  if (comp === 16) {
    let s = '';
    for (let i = 1; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  throw new Error('a UDF name with an unknown compression');
}

export class UdfVolume {
  private partStart = 0;
  private blockSize = BLOCK;
  private root: { lbn: number } = { lbn: 0 };

  constructor(private src: ByteSource) {
    this.mount();
  }

  private block(lbn: number, n = 1): Uint8Array {
    return this.src.read(lbn * BLOCK, n * BLOCK);
  }

  private mount(): void {
    if (this.src.size < 257 * BLOCK) throw new Error('The file is too small to be an ISO.');
    const avdp = this.block(256);
    if (tagId(avdp) !== 2) throw new Error('The file is not a UDF disc image (no anchor at sector 256). Is it a Windows ISO?');
    const vdsLen = le32(avdp, 16);
    const vdsLoc = le32(avdp, 20);
    let partStart = -1;
    let partNumber = -1;
    let fsd: { lbn: number; part: number } | null = null;
    let mapPart = -1;
    for (let i = 0; i < Math.ceil(vdsLen / BLOCK); i++) {
      const d = this.block(vdsLoc + i);
      const id = tagId(d);
      if (id === 8) break;
      if (id === 5) {
        partNumber = le16(d, 22);
        partStart = le32(d, 188);
      } else if (id === 6) {
        this.blockSize = le32(d, 212);
        fsd = { lbn: le32(d, 248 + 4), part: le16(d, 248 + 8) };
        const nMaps = le32(d, 268);
        if (nMaps !== 1) throw new Error('This UDF image has several partition maps (UDF 2.5 metadata?), which this reader does not handle.');
        const map = d.subarray(440, 446);
        if (map[0] !== 1) throw new Error('This UDF image uses a virtual or metadata partition, which this reader does not handle.');
        mapPart = le16(map, 4);
      }
    }
    if (partStart < 0 || !fsd) throw new Error('The UDF image has no partition or no logical volume.');
    if (this.blockSize !== BLOCK) throw new Error(`The UDF image has ${this.blockSize}-byte blocks.`);
    if (mapPart !== partNumber) throw new Error('The UDF partition map does not name the partition.');
    this.partStart = partStart;
    const f = this.block(partStart + fsd.lbn);
    if (tagId(f) !== 256) throw new Error('The UDF file set descriptor is missing.');
    this.root = { lbn: le32(f, 400 + 4) };
  }

  /** Read a (extended) file entry: its size, whether it is a directory, and its extents. */
  private entry(lbn: number): { size: number; dir: boolean; extents: Extent[]; inline?: Uint8Array } {
    const fe = this.block(this.partStart + lbn);
    const id = tagId(fe);
    if (id !== 261 && id !== 266) throw new Error(`UDF: expected a file entry at block ${lbn}, found tag ${id}`);
    const fileType = fe[16 + 11];
    const flags = le16(fe, 16 + 18);
    const size = le64(fe, 56);
    const lEa = id === 261 ? le32(fe, 168) : le32(fe, 208);
    const lAd = id === 261 ? le32(fe, 172) : le32(fe, 212);
    const adStart = (id === 261 ? 176 : 216) + lEa;
    if (adStart + lAd > BLOCK) throw new Error('UDF: allocation descriptors continue past the file entry');
    const ads = fe.subarray(adStart, adStart + lAd);
    const kind = flags & 7;
    const extents: Extent[] = [];
    if (kind === 3) return { size, dir: fileType === 4, extents, inline: ads.slice(0, size) };
    const step = kind === 0 ? 8 : kind === 1 ? 16 : 0;
    if (!step) throw new Error('UDF: extended allocation descriptors are not handled');
    let left = size;
    for (let o = 0; o + step <= ads.length && left > 0; o += step) {
      const raw = le32(ads, o);
      const len = raw & 0x3fffffff;
      const type = raw >>> 30;
      if (len === 0) break;
      if (type === 3) throw new Error('UDF: the allocation descriptors continue in another block, which is not handled');
      const pos = le32(ads, o + 4);
      const n = Math.min(len, left);
      // Type 1 is allocated but not recorded: it reads as zeros. Windows ISOs have none.
      if (type !== 0) throw new Error('UDF: a file has an unrecorded extent');
      extents.push({ offset: (this.partStart + pos) * BLOCK, length: n });
      left -= n;
    }
    if (left !== 0) throw new Error('UDF: a file entry describes less data than its size');
    return { size, dir: fileType === 4, extents };
  }

  private readAll(e: { size: number; extents: Extent[]; inline?: Uint8Array }): Uint8Array {
    if (e.inline) return e.inline;
    const out = new Uint8Array(e.size);
    let at = 0;
    for (const x of e.extents) { out.set(this.src.read(x.offset, x.length), at); at += x.length; }
    return out;
  }

  private list(lbn: number): Array<{ name: string; dir: boolean; lbn: number }> {
    const d = this.entry(lbn);
    if (!d.dir) throw new Error('UDF: not a directory');
    const data = this.readAll(d);
    const out: Array<{ name: string; dir: boolean; lbn: number }> = [];
    let o = 0;
    while (o + 38 <= data.length) {
      if (tagId(data.subarray(o)) !== 257) break;
      const ch = data[o + 18];
      const lFi = data[o + 19];
      const icbLbn = le32(data, o + 20 + 4);
      const lIu = le16(data, o + 36);
      const nameStart = o + 38 + lIu;
      if (!(ch & 0x08) && !(ch & 0x04)) {
        out.push({ name: dstring(data.subarray(nameStart, nameStart + lFi)), dir: (ch & 0x02) !== 0, lbn: icbLbn });
      }
      o += (38 + lIu + lFi + 3) & ~3;
    }
    return out;
  }

  /** A file by path, case-insensitive ("sources/install.wim"), or null. */
  find(path: string): IsoFile | null {
    let lbn = this.root.lbn;
    const parts = path.split(/[\\/]/).filter(Boolean);
    for (const [i, name] of parts.entries()) {
      const hit = this.list(lbn).find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (!hit) return null;
      if (i < parts.length - 1) {
        if (!hit.dir) return null;
        lbn = hit.lbn;
      } else {
        if (hit.dir) return null;
        const e = this.entry(hit.lbn);
        if (e.inline) return null;
        return { path, size: e.size, extents: e.extents };
      }
    }
    return null;
  }
}

/** A source over the bytes of a file inside the ISO. */
export function extentSource(iso: ByteSource, f: IsoFile): ByteSource {
  const starts: number[] = [];
  let s = 0;
  for (const e of f.extents) { starts.push(s); s += e.length; }
  return {
    size: f.size,
    read(position, length) {
      const out = new Uint8Array(length);
      let done = 0;
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= position) i++;
      while (done < length) {
        const e = f.extents[i];
        const off = position + done - starts[i];
        const n = Math.min(length - done, e.length - off);
        out.set(iso.read(e.offset + off, n), done);
        done += n;
        i++;
      }
      return out;
    },
  };
}
