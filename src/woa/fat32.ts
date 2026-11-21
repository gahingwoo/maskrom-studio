// Just enough FAT32 to reuse the WinPE release image unchanged but for one
// file: find a file by its path, replace its contents in the clusters it
// already has, and tell which parts of the volume are in use so the free
// space is not sent over USB.
//
// The volume is woa-rk3576's WINPE partition (mkfs.vfat -F 32, 4 KiB
// clusters, written once in CI). Long file names are matched through their
// 8.3 alias as well as the long name, case-insensitively, as Windows does.

import type { ByteSource } from './pieces';

export interface Fat32 {
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterBytes: number;
  reservedSectors: number;
  numFats: number;
  fatSectors: number;
  rootCluster: number;
  totalSectors: number;
  /** Byte offset of cluster 2 in the volume. */
  dataStart: number;
  clusterCount: number;
}

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function parseFat32(src: ByteSource): Fat32 {
  const bs = src.read(0, 512);
  if (bs[510] !== 0x55 || bs[511] !== 0xaa) throw new Error('not a FAT file system (no boot signature)');
  const bytesPerSector = le16(bs, 11);
  const sectorsPerCluster = bs[13];
  const reservedSectors = le16(bs, 14);
  const numFats = bs[16];
  const rootEntries = le16(bs, 17);
  const fatSectors = le32(bs, 36);
  const totalSectors = le16(bs, 19) || le32(bs, 32);
  if (bytesPerSector !== 512 || !sectorsPerCluster || rootEntries !== 0 || le16(bs, 22) !== 0 || !fatSectors) {
    throw new Error('not a FAT32 file system with 512-byte sectors');
  }
  const dataStart = (reservedSectors + numFats * fatSectors) * bytesPerSector;
  const clusterCount = Math.floor((totalSectors * bytesPerSector - dataStart) / (sectorsPerCluster * bytesPerSector));
  return {
    bytesPerSector, sectorsPerCluster, clusterBytes: sectorsPerCluster * bytesPerSector, reservedSectors, numFats,
    fatSectors, rootCluster: le32(bs, 44), totalSectors, dataStart, clusterCount,
  };
}

export class FatVolume {
  readonly fs: Fat32;
  private fat: Uint32Array;

  constructor(private src: ByteSource) {
    this.fs = parseFat32(src);
    const raw = src.read(this.fs.reservedSectors * 512, (this.fs.clusterCount + 2) * 4);
    this.fat = new Uint32Array(this.fs.clusterCount + 2);
    for (let i = 0; i < this.fat.length; i++) this.fat[i] = le32(raw, i * 4) & 0x0fffffff;
  }

  clusterOffset(c: number): number {
    return this.fs.dataStart + (c - 2) * this.fs.clusterBytes;
  }

  chain(first: number): number[] {
    const out: number[] = [];
    let c = first;
    while (c >= 2 && c < 0x0ffffff8) {
      if (c >= this.fat.length || out.length > this.fat.length) throw new Error('broken cluster chain');
      out.push(c);
      c = this.fat[c];
    }
    return out;
  }

  private readChain(first: number): Uint8Array {
    const cs = this.chain(first);
    const out = new Uint8Array(cs.length * this.fs.clusterBytes);
    cs.forEach((c, i) => out.set(this.src.read(this.clusterOffset(c), this.fs.clusterBytes), i * this.fs.clusterBytes));
    return out;
  }

  /** The directory entries of a directory: names (long and short) and where each 32-byte entry is in the volume. */
  private list(first: number): Array<{ long: string; short: string; attr: number; cluster: number; size: number; entryOffset: number }> {
    const cs = this.chain(first);
    const per = this.fs.clusterBytes / 32;
    const data = this.readChain(first);
    const out: Array<{ long: string; short: string; attr: number; cluster: number; size: number; entryOffset: number }> = [];
    let lfn: string[] = [];
    for (let i = 0; i < data.length / 32; i++) {
      const e = data.subarray(i * 32, i * 32 + 32);
      if (e[0] === 0) break;
      if (e[0] === 0xe5) { lfn = []; continue; }
      const attr = e[11];
      if (attr === 0x0f) {
        let part = '';
        for (const o of [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]) {
          const ch = le16(e, o);
          if (ch === 0 || ch === 0xffff) break;
          part += String.fromCharCode(ch);
        }
        const seq = e[0] & 0x1f;
        lfn[seq - 1] = part;
        continue;
      }
      const base = new TextDecoder('latin1').decode(e.subarray(0, 8)).trimEnd();
      const ext = new TextDecoder('latin1').decode(e.subarray(8, 11)).trimEnd();
      const short = ext ? `${base}.${ext}` : base;
      const long = lfn.length ? lfn.join('') : short;
      lfn = [];
      if (attr & 0x08) continue; // volume label
      const cluster = (le16(e, 20) << 16) | le16(e, 26);
      const entryOffset = this.clusterOffset(cs[Math.floor(i / per)]) + (i % per) * 32;
      out.push({ long, short, attr, cluster, size: le32(e, 28), entryOffset });
    }
    return out;
  }

  /** A file or directory by path ("woa-debug/collect.cmd"), or null. */
  find(path: string): { cluster: number; size: number; isDir: boolean; entryOffset: number } | null {
    let dir = this.fs.rootCluster;
    const parts = path.split(/[\\/]/).filter(Boolean);
    let hit: ReturnType<FatVolume['list']>[number] | undefined;
    for (const [i, name] of parts.entries()) {
      const n = name.toLowerCase();
      hit = this.list(dir).find((e) => e.long.toLowerCase() === n || e.short.toLowerCase() === n);
      if (!hit) return null;
      if (i < parts.length - 1) {
        if (!(hit.attr & 0x10)) return null;
        dir = hit.cluster;
      }
    }
    if (!hit) return null;
    return { cluster: hit.cluster, size: hit.size, isDir: (hit.attr & 0x10) !== 0, entryOffset: hit.entryOffset };
  }

  /** Every file under a directory, as paths ("woa-drivers/dwcsdhc/dwcsdhc.cat"). */
  listFiles(dir: string): string[] {
    const d = this.find(dir);
    if (!d || !d.isDir) return [];
    const out: string[] = [];
    const walk = (cluster: number, prefix: string, depth: number) => {
      if (depth > 16) return;
      for (const e of this.list(cluster)) {
        if (e.short === '.' || e.short === '..') continue;
        if (e.attr & 0x10) walk(e.cluster, `${prefix}${e.long}/`, depth + 1);
        else out.push(`${prefix}${e.long}`);
      }
    };
    walk(d.cluster, `${dir.replace(/\/$/, '')}/`, 0);
    return out;
  }

  readFile(path: string): Uint8Array {
    const f = this.find(path);
    if (!f || f.isDir) throw new Error(`${path} is not a file on the volume`);
    return this.readChain(f.cluster).slice(0, f.size);
  }

  /**
   * Byte patches that give the file `path` the contents `data`, inside the
   * clusters it has now: its data (the rest of the last cluster zeroed) and
   * the size in its directory entry. Refuses contents that need more clusters.
   */
  replaceFile(path: string, data: Uint8Array): Array<{ offset: number; data: Uint8Array }> {
    const f = this.find(path);
    if (!f || f.isDir) throw new Error(`${path} is not a file on the volume`);
    const cs = this.chain(f.cluster);
    if (data.length > cs.length * this.fs.clusterBytes) {
      throw new Error(`${path} has room for ${cs.length * this.fs.clusterBytes} bytes, not ${data.length}`);
    }
    if (data.length === 0) throw new Error('an empty replacement would leave a cluster chain without a file');
    const patches: Array<{ offset: number; data: Uint8Array }> = [];
    cs.forEach((c, i) => {
      const chunk = new Uint8Array(this.fs.clusterBytes);
      chunk.set(data.subarray(i * this.fs.clusterBytes, (i + 1) * this.fs.clusterBytes));
      patches.push({ offset: this.clusterOffset(c), data: chunk });
    });
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, data.length, true);
    patches.push({ offset: f.entryOffset + 28, data: size });
    // Clusters the new contents do not need are freed, in every FAT, so the
    // chain matches the size (fsck.fat and chkdsk both check that).
    const need = Math.ceil(data.length / this.fs.clusterBytes);
    const entry = (c: number, v: number) => {
      for (let k = 0; k < this.fs.numFats; k++) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, v, true);
        patches.push({ offset: (this.fs.reservedSectors + k * this.fs.fatSectors) * 512 + c * 4, data: b });
      }
    };
    if (need < cs.length) {
      entry(cs[need - 1], 0x0fffffff);
      for (const c of cs.slice(need)) entry(c, 0);
      // The freed clusters keep their old contents; zeroed above, and no longer written.
      patches.splice(need, cs.length - need);
      // The free cluster count in FSInfo, where it is kept.
      const bs = this.src.read(0, 512);
      const infoSector = le16(bs, 48);
      if (infoSector > 0 && infoSector !== 0xffff) {
        const info = this.src.read(infoSector * 512, 512);
        const free = le32(info, 488);
        if (le32(info, 0) === 0x41615252 && free !== 0xffffffff) {
          const b = new Uint8Array(4);
          new DataView(b.buffer).setUint32(0, free + cs.length - need, true);
          patches.push({ offset: infoSector * 512 + 488, data: b });
        }
      }
    }
    return patches;
  }

  /**
   * The parts of the volume that hold something: the boot sectors and FATs,
   * and every run of allocated clusters, as [start, end) byte ranges. A
   * copy that writes only these reads back as the same file system.
   */
  usedRanges(): Array<[number, number]> {
    const out: Array<[number, number]> = [[0, this.fs.dataStart]];
    let runStart = -1;
    for (let c = 2; c < this.fat.length; c++) {
      const used = this.fat[c] !== 0;
      if (used && runStart < 0) runStart = c;
      if ((!used || c === this.fat.length - 1) && runStart >= 0) {
        const end = used ? c + 1 : c;
        out.push([this.clusterOffset(runStart), this.clusterOffset(end)]);
        runStart = -1;
      }
    }
    // Neighbouring ranges in one piece.
    const merged: Array<[number, number]> = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && last[1] === r[0]) last[1] = r[1]; else merged.push([r[0], r[1]]);
    }
    return merged;
  }
}
