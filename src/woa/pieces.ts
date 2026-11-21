// Byte sources put together from pieces: bytes made here (partition tables,
// file system metadata, scripts), ranges of files on this computer (the
// WinPE image, install.wim inside an ISO) and zeros. A staged install is a
// handful of such regions, each written to the board with one command, so
// nothing the size of the Windows image is ever copied on this computer.

import type { ByteSource } from '../maskrom/rkcore';

export type { ByteSource };

export type Piece =
  | { kind: 'bytes'; data: Uint8Array }
  | { kind: 'range'; source: ByteSource; offset: number; length: number }
  | { kind: 'zero'; length: number };

export const pieceLength = (p: Piece): number => (p.kind === 'bytes' ? p.data.length : p.length);

/** One source over `pieces` laid end to end. */
export function concatSource(pieces: Piece[]): ByteSource {
  const starts: number[] = [];
  let size = 0;
  for (const p of pieces) {
    starts.push(size);
    size += pieceLength(p);
  }
  const find = (pos: number) => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  return {
    size,
    read(position, length) {
      const out = new Uint8Array(length);
      let done = 0;
      let i = find(position);
      while (done < length) {
        const p = pieces[i];
        const off = position + done - starts[i];
        const n = Math.min(length - done, pieceLength(p) - off);
        if (n > 0) {
          if (p.kind === 'bytes') out.set(p.data.subarray(off, off + n), done);
          else if (p.kind === 'range') out.set(p.source.read(p.offset + off, n), done);
          done += n;
        }
        i++;
        if (i >= pieces.length && done < length) throw new Error('read past the end of the pieces');
      }
      return out;
    },
  };
}

/** A part of `src`. */
export function sliceSource(src: ByteSource, offset: number, length: number): ByteSource {
  if (offset < 0 || offset + length > src.size) throw new Error('slice outside its source');
  return { size: length, read: (p, n) => src.read(offset + p, n) };
}

export function bytesSource(data: Uint8Array): ByteSource {
  return { size: data.length, read: (p, n) => data.slice(p, p + n) };
}

/** `base` with some byte ranges replaced. Patches must not overlap. */
export function patchedSource(base: ByteSource, patches: Array<{ offset: number; data: Uint8Array }>): ByteSource {
  const sorted = [...patches].sort((a, b) => a.offset - b.offset);
  return {
    size: base.size,
    read(position, length) {
      const out = base.read(position, length);
      const end = position + length;
      for (const p of sorted) {
        const pEnd = p.offset + p.data.length;
        if (pEnd <= position || p.offset >= end) continue;
        const from = Math.max(position, p.offset);
        const to = Math.min(end, pEnd);
        out.set(p.data.subarray(from - p.offset, to - p.offset), from - position);
      }
      return out;
    },
  };
}
