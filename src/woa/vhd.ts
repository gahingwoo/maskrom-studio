// Read a dynamic (expandable) VHD, as Windows' diskpart "create vdisk ...
// type=expandable" makes it for a .vhd file: which 2 MiB blocks of the
// virtual disk hold data, and their bytes. The Windows host build applies
// Windows into such a file the size of the board's eMMC; only the blocks it
// wrote are then sent over Maskrom.
//
// Format: Microsoft's "Virtual Hard Disk Image Format Specification" 1.0: a
// 512-byte footer ("conectix") at the end and a copy at the start, a
// dynamic disk header ("cxsparse") with the block allocation table (BAT, big
// endian sector offsets, 0xFFFFFFFF for an empty block), and each block as a
// sector bitmap followed by its data. A sector whose bit is clear reads as
// zeros. A fixed VHD (raw disk plus footer) is read too.

import type { ByteSource } from './pieces';

const SECTOR = 512;

export interface VhdInfo {
  kind: 'fixed' | 'dynamic';
  /** Size of the virtual disk in bytes. */
  diskBytes: number;
  blockBytes: number;
  /** For each block of the virtual disk: whether it holds data. */
  allocated: (block: number) => boolean;
  blocks: number;
  /** Read bytes of the virtual disk. */
  disk: ByteSource;
}

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be64 = (b: Uint8Array, o: number) => be32(b, o) * 2 ** 32 + be32(b, o + 4);

export function readVhd(file: ByteSource): VhdInfo {
  if (file.size < 1024) throw new Error('The file is too small to be a VHD.');
  const footer = file.read(file.size - SECTOR, SECTOR);
  if (new TextDecoder('latin1').decode(footer.subarray(0, 8)) !== 'conectix') throw new Error('The file is not a VHD (no footer).');
  const diskBytes = be64(footer, 48);
  const type = be32(footer, 60);
  if (type === 2) {
    if (file.size < diskBytes + SECTOR) throw new Error('The fixed VHD is shorter than its disk.');
    return {
      kind: 'fixed', diskBytes, blockBytes: 2 << 20, blocks: Math.ceil(diskBytes / (2 << 20)), allocated: () => true,
      disk: { size: diskBytes, read: (p, n) => file.read(p, n) },
    };
  }
  if (type !== 3) throw new Error(`VHD disk type ${type} (differencing?) is not handled.`);
  const hdrOff = be64(footer, 16);
  const hdr = file.read(hdrOff, 1024);
  if (new TextDecoder('latin1').decode(hdr.subarray(0, 8)) !== 'cxsparse') throw new Error('The VHD has no dynamic disk header.');
  const batOff = be64(hdr, 16);
  const entries = be32(hdr, 28);
  const blockBytes = be32(hdr, 32);
  if (blockBytes % SECTOR || blockBytes === 0) throw new Error('The VHD block size is not whole sectors.');
  const raw = file.read(batOff, entries * 4);
  const bat = new Uint32Array(entries);
  for (let i = 0; i < entries; i++) bat[i] = be32(raw, i * 4);
  const sectorsPerBlock = blockBytes / SECTOR;
  const bitmapBytes = Math.ceil(Math.ceil(sectorsPerBlock / 8) / SECTOR) * SECTOR;
  const bitmaps = new Map<number, Uint8Array>();
  const bitmap = (blk: number) => {
    let b = bitmaps.get(blk);
    if (!b) { b = file.read(bat[blk] * SECTOR, bitmapBytes); bitmaps.set(blk, b); }
    return b;
  };
  return {
    kind: 'dynamic', diskBytes, blockBytes, blocks: entries,
    allocated: (blk) => blk < entries && bat[blk] !== 0xffffffff,
    disk: {
      size: diskBytes,
      read(position, length) {
        const out = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const pos = position + done;
          const blk = Math.floor(pos / blockBytes);
          const inBlk = pos % blockBytes;
          const n = Math.min(length - done, blockBytes - inBlk);
          if (blk < entries && bat[blk] !== 0xffffffff) {
            const data = file.read(bat[blk] * SECTOR + bitmapBytes + inBlk, n);
            const bm = bitmap(blk);
            // Sectors whose bitmap bit is clear read as zeros.
            for (let s = Math.floor(inBlk / SECTOR); s * SECTOR < inBlk + n; s++) {
              if (!(bm[s >> 3] & (0x80 >> (s & 7)))) {
                const a = Math.max(s * SECTOR, inBlk) - inBlk;
                const e = Math.min((s + 1) * SECTOR, inBlk + n) - inBlk;
                data.fill(0, a, e);
              }
            }
            out.set(data, done);
          }
          done += n;
        }
        return out;
      },
    },
  };
}
