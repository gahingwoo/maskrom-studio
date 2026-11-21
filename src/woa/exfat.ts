// A new exFAT volume holding a few files, each in one contiguous run of
// clusters, described as pieces so that a multi-GB install.wim is read from
// where it is (an ISO, a .wim) while it is written and never copied here.
//
// exFAT because install.wim is often larger than FAT32's 4 GiB file limit,
// WinPE reads exFAT, and woa-rk3576's install procedure already puts
// install.wim on an exFAT partition. The UEFI firmware does not need to read
// this volume; it boots WinPE from the FAT32 one.
//
// Written from Microsoft's exFAT specification (the boot region and its
// checksum, the allocation bitmap, the up-case table, directory entry sets
// with their name hash and set checksum). The FAT chain is written for every
// allocation too (NoFatChain is never set), which every reader understands.
// test/exfat.test.ts checks the result with exfatprogs' fsck.exfat.

import { concatSource, type ByteSource, type Piece } from './pieces';

const SECTOR = 512;

export interface ExfatFile {
  /** A path with / between directories: "openssh/sshd.exe". */
  name: string;
  source: ByteSource;
}

interface DirNode { name: string; dirs: DirNode[]; files: number[]; first: number; clusters: number; path: string }

const setBytes = (name: string) => 32 * (2 + Math.ceil(name.length / 15));

export interface ExfatPlan {
  /** Pieces from the first sector of the volume to the end of the last file. */
  pieces: Piece[];
  /** Bytes the pieces cover (what is written). */
  writtenBytes: number;
  /** The volume's size in sectors (the partition's size). */
  volumeSectors: number;
  /** Where each file's data is, in bytes from the start of the volume. */
  files: Array<{ name: string; offset: number; size: number }>;
}

/** The up-case table: every UTF-16 code unit to its upper case, compressed as the specification allows. */
export function upcaseTable(): Uint8Array {
  const map: number[] = [];
  for (let c = 0; c < 0x10000; c++) {
    let u = c;
    if (c < 0xd800 || c > 0xdfff) {
      const s = String.fromCharCode(c).toUpperCase();
      if (s.length === 1) u = s.charCodeAt(0);
    }
    map.push(u);
  }
  // Runs of characters that map to themselves become 0xFFFF, length.
  const out: number[] = [];
  let i = 0;
  while (i < map.length) {
    if (map[i] === i) {
      let j = i;
      while (j < map.length && map[j] === j) j++;
      if (j - i > 2) { out.push(0xffff, j - i); i = j; continue; }
    }
    out.push(map[i]);
    i++;
  }
  const b = new Uint8Array(out.length * 2);
  out.forEach((v, k) => { b[k * 2] = v & 0xff; b[k * 2 + 1] = v >> 8; });
  return b;
}

export function tableChecksum(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = (((c & 1) ? 0x80000000 : 0) + (c >>> 1) + b[i]) >>> 0;
  return c;
}

function bootChecksum(region: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < 11 * SECTOR; i++) {
    if (i === 106 || i === 107 || i === 112) continue;
    c = (((c & 1) ? 0x80000000 : 0) + (c >>> 1) + region[i]) >>> 0;
  }
  return c;
}

function nameHash(name: string): number {
  let h = 0;
  for (const ch of name.toUpperCase()) {
    const c = ch.charCodeAt(0);
    for (const byte of [c & 0xff, c >> 8]) h = ((((h & 1) ? 0x8000 : 0) + (h >>> 1) + byte) & 0xffff);
  }
  return h;
}

function setChecksum(entries: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i === 2 || i === 3) continue;
    c = ((((c & 1) ? 0x8000 : 0) + (c >>> 1) + entries[i]) & 0xffff);
  }
  return c;
}

/** A DOS date-time as exFAT stores it. */
function timestamp(d: Date): number {
  return (((d.getUTCFullYear() - 1980) & 0x7f) << 25 | (d.getUTCMonth() + 1) << 21 | d.getUTCDate() << 16
    | d.getUTCHours() << 11 | d.getUTCMinutes() << 5 | (d.getUTCSeconds() >> 1)) >>> 0;
}

function fileEntrySet(name: string, firstCluster: number, size: number, when: Date, dir = false): Uint8Array {
  if (!/^[\x20-\x7e]+$/.test(name) || /[\\/:*?"<>|]/.test(name) || name.length > 255) throw new Error(`bad file name ${name}`);
  const nameEntries = Math.ceil(name.length / 15);
  const set = new Uint8Array(32 * (2 + nameEntries));
  const dv = new DataView(set.buffer);
  const ts = timestamp(when);
  set[0] = 0x85;
  set[1] = 1 + nameEntries;
  dv.setUint16(4, dir ? 0x10 : 0x20, true); // directory or archive
  dv.setUint32(8, ts, true);
  dv.setUint32(12, ts, true);
  dv.setUint32(16, ts, true);
  const s = 32;
  set[s] = 0xc0;
  set[s + 1] = 0x01; // allocation possible, FAT chain valid
  set[s + 3] = name.length;
  dv.setUint16(s + 4, nameHash(name), true);
  dv.setBigUint64(s + 8, BigInt(size), true);
  dv.setUint32(s + 20, firstCluster, true);
  dv.setBigUint64(s + 24, BigInt(size), true);
  for (let k = 0; k < nameEntries; k++) {
    const o = 64 + k * 32;
    set[o] = 0xc1;
    const part = name.slice(k * 15, k * 15 + 15);
    for (let j = 0; j < part.length; j++) dv.setUint16(o + 2 + j * 2, part.charCodeAt(j), true);
  }
  dv.setUint16(2, setChecksum(set), true);
  return set;
}

export interface ExfatOptions {
  files: ExfatFile[];
  label: string;
  /** The partition's first sector on the disk (the boot sector records it). */
  partitionOffset: number;
  serial: number;
  when?: Date;
  /** Free space to leave after the files, in bytes. */
  slack?: number;
  clusterShift?: number;
}

export function buildExfat(o: ExfatOptions): ExfatPlan {
  const clusterShift = o.clusterShift ?? 6; // 32 KiB
  const spc = 1 << clusterShift;
  const clusterBytes = spc * SECTOR;
  const when = o.when ?? new Date(Date.UTC(2026, 0, 1));
  const up = upcaseTable();
  const clustersFor = (bytes: number) => Math.max(1, Math.ceil(bytes / clusterBytes));
  const fileClusters = o.files.map((f) => {
    if (f.source.size === 0) throw new Error(`${f.name} is empty`);
    return clustersFor(f.source.size);
  });
  // The directory tree; each directory's entries decide its size.
  const root: DirNode = { name: '', dirs: [], files: [], first: 0, clusters: 0, path: '' };
  o.files.forEach((f, i) => {
    const parts = f.name.split('/').filter(Boolean);
    let d = root;
    for (const part of parts.slice(0, -1)) {
      let c = d.dirs.find((x) => x.name.toLowerCase() === part.toLowerCase());
      if (!c) { c = { name: part, dirs: [], files: [], first: 0, clusters: 0, path: `${d.path}${part}/` }; d.dirs.push(c); }
      d = c;
    }
    d.files.push(i);
  });
  const leaf = (i: number) => o.files[i].name.split('/').filter(Boolean).pop()!;
  const allDirs: DirNode[] = [];
  const walk = (d: DirNode) => { allDirs.push(d); d.dirs.forEach(walk); };
  walk(root);
  for (const d of allDirs) {
    const bytes = (d === root ? 96 : 0) + d.dirs.reduce((a, x) => a + setBytes(x.name), 0) + d.files.reduce((a, i) => a + setBytes(leaf(i)), 0);
    d.clusters = clustersFor(Math.max(bytes, 32));
  }
  const dirClusters = allDirs.reduce((a, d) => a + d.clusters, 0);
  const dataClusters = fileClusters.reduce((a, b) => a + b, 0) + dirClusters;
  const slackClusters = Math.ceil((o.slack ?? 16 << 20) / clusterBytes);

  // Sizes depend on the cluster count and the other way round; two rounds settle it.
  const fatOffset = 2048;
  let clusterCount = dataClusters + slackClusters + 64;
  let bitmapClusters = 0;
  let fatLength = 0;
  let heapOffset = 0;
  for (let round = 0; round < 3; round++) {
    bitmapClusters = clustersFor(Math.ceil(clusterCount / 8));
    // Room for the clusters the 1 MiB rounding of the volume adds (at most 32).
    fatLength = Math.ceil(((clusterCount + 2 + 64) * 4) / SECTOR);
    heapOffset = Math.ceil((fatOffset + fatLength) / 2048) * 2048;
    clusterCount = bitmapClusters + clustersFor(up.length) + dataClusters + slackClusters;
  }
  const volumeSectors = Math.ceil((heapOffset + clusterCount * spc) / 2048) * 2048;
  clusterCount = Math.floor((volumeSectors - heapOffset) / spc);
  bitmapClusters = clustersFor(Math.ceil(clusterCount / 8));
  if (Math.ceil(((clusterCount + 2) * 4) / SECTOR) > fatLength || heapOffset < fatOffset + fatLength) {
    throw new Error('exFAT layout did not settle');
  }

  // Cluster allocation, from cluster 2: bitmap, up-case table, root directory, files.
  let next = 2;
  const alloc = (n: number) => { const first = next; next += n; return first; };
  const bitmapFirst = alloc(bitmapClusters);
  const upFirst = alloc(clustersFor(up.length));
  for (const d of allDirs) d.first = alloc(d.clusters);
  const rootFirst = root.first;
  const fileFirst = fileClusters.map((n) => alloc(n));
  const used = next - 2;
  if (used > clusterCount) throw new Error('files do not fit the exFAT volume');

  const fat = new Uint8Array(fatLength * SECTOR);
  const fdv = new DataView(fat.buffer);
  fdv.setUint32(0, 0xfffffff8, true);
  fdv.setUint32(4, 0xffffffff, true);
  const chain = (first: number, n: number) => {
    for (let c = first; c < first + n - 1; c++) fdv.setUint32(c * 4, c + 1, true);
    fdv.setUint32((first + n - 1) * 4, 0xffffffff, true);
  };
  chain(bitmapFirst, bitmapClusters);
  chain(upFirst, clustersFor(up.length));
  for (const d of allDirs) chain(d.first, d.clusters);
  fileFirst.forEach((f, i) => chain(f, fileClusters[i]));

  const bitmap = new Uint8Array(bitmapClusters * clusterBytes);
  for (let i = 0; i < used; i++) bitmap[i >> 3] |= 1 << (i & 7);

  const dirBytes = (d: DirNode): Uint8Array => {
    const buf = new Uint8Array(d.clusters * clusterBytes);
    const dv = new DataView(buf.buffer);
    let at = 0;
    if (d === root) {
      const label = o.label.slice(0, 11);
      buf[at] = 0x83;
      buf[at + 1] = label.length;
      for (let j = 0; j < label.length; j++) dv.setUint16(at + 2 + j * 2, label.charCodeAt(j), true);
      at += 32;
      buf[at] = 0x81;
      dv.setUint32(at + 20, bitmapFirst, true);
      dv.setBigUint64(at + 24, BigInt(Math.ceil(clusterCount / 8)), true);
      at += 32;
      buf[at] = 0x82;
      dv.setUint32(at + 4, tableChecksum(up), true);
      dv.setUint32(at + 20, upFirst, true);
      dv.setBigUint64(at + 24, BigInt(up.length), true);
      at += 32;
    }
    for (const c of d.dirs) {
      const set = fileEntrySet(c.name, c.first, c.clusters * clusterBytes, when, true);
      buf.set(set, at);
      at += set.length;
    }
    for (const i of d.files) {
      const set = fileEntrySet(leaf(i), fileFirst[i], o.files[i].source.size, when);
      buf.set(set, at);
      at += set.length;
    }
    return buf;
  };

  const boot = new Uint8Array(12 * SECTOR);
  const bdv = new DataView(boot.buffer);
  boot.set([0xeb, 0x76, 0x90], 0);
  boot.set(new TextEncoder().encode('EXFAT   '), 3);
  bdv.setBigUint64(64, BigInt(o.partitionOffset), true);
  bdv.setBigUint64(72, BigInt(volumeSectors), true);
  bdv.setUint32(80, fatOffset, true);
  bdv.setUint32(84, fatLength, true);
  bdv.setUint32(88, heapOffset, true);
  bdv.setUint32(92, clusterCount, true);
  bdv.setUint32(96, rootFirst, true);
  bdv.setUint32(100, o.serial >>> 0, true);
  bdv.setUint16(104, 0x0100, true);
  boot[108] = 9;
  boot[109] = clusterShift;
  boot[110] = 1;
  boot[111] = 0x80;
  boot[112] = Math.min(100, Math.floor((used * 100) / clusterCount));
  boot[510] = 0x55; boot[511] = 0xaa;
  for (let s = 1; s <= 8; s++) { boot[s * SECTOR + 510] = 0x55; boot[s * SECTOR + 511] = 0xaa; }
  const sum = bootChecksum(boot);
  for (let k = 0; k < SECTOR / 4; k++) bdv.setUint32(11 * SECTOR + k * 4, sum, true);

  const heap = heapOffset * SECTOR;
  const off = (c: number) => heap + (c - 2) * clusterBytes;
  const upPadded = new Uint8Array(clustersFor(up.length) * clusterBytes);
  upPadded.set(up);

  const pieces: Piece[] = [
    { kind: 'bytes', data: boot },
    { kind: 'bytes', data: boot },
    { kind: 'zero', length: fatOffset * SECTOR - 24 * SECTOR },
    { kind: 'bytes', data: fat },
    { kind: 'zero', length: heap - (fatOffset + fatLength) * SECTOR },
    { kind: 'bytes', data: bitmap },
    { kind: 'bytes', data: upPadded },
    ...allDirs.map((d) => ({ kind: 'bytes' as const, data: dirBytes(d) })),
  ];
  const files: ExfatPlan['files'] = [];
  for (const [i, f] of o.files.entries()) {
    const start = off(fileFirst[i]);
    files.push({ name: f.name, offset: start, size: f.source.size });
    pieces.push({ kind: 'range', source: f.source, offset: 0, length: f.source.size });
    const pad = fileClusters[i] * clusterBytes - f.source.size;
    if (pad) pieces.push({ kind: 'zero', length: pad });
  }
  const writtenBytes = concatSource(pieces).size;
  if (writtenBytes !== off(next)) throw new Error('exFAT pieces do not line up');
  return { pieces, writtenBytes, volumeSectors, files };
}
