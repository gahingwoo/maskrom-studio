// The on-board writer: run on an RK3576 board under Linux, with
// administrator rights (pkexec, through main/elevate.ts like the SD writer),
// it writes that board's own eMMC or SPI NOR flash.
//
//   write-helper --socket PATH --token T --job FILE.json
//
// It trusts nothing in the job but what to write: the board, its eMMC and
// what is mounted are looked up again here (main/board-here.ts), the eMMC is
// refused while anything on it is mounted or in use, and the partition table
// is read from the disk itself. Everything written is read back from the
// disk (after the kernel's cache of it is dropped) and compared.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { boardHere } from '../main/board-here';
import { firmwareTargets, woaBoard } from '../woa/boards';
import { firmwareRegions } from '../woa/firmware-plan';
import { MIN_DISK_BYTES, planStage, StageError, type Region } from '../woa/stage-layout';
import { isOfferedTarget, type DriveInfo } from '../shared/targets';
import { withDiskFacts } from '../main/linux-disks';
import { extentSource, type Extent } from '../woa/udf';
import type { ByteSource } from '../woa/pieces';
import type { SetupOptions } from '../woa/setup-files';
import type { HelperMessage } from './write-helper';

export type BoardJob =
  | { kind: 'stage'; device: string; boardId: string; winpe: string; appVersion: string;
      image: { path: string; extents: Extent[] | null; name: 'install.wim' | 'install.esd'; size: number;
        sha256: string | null; index: number; edition: string; build: number };
      setup: SetupOptions; extras: Array<{ path: string; base64: string }> }
  | { kind: 'firmware'; device: string; boardId: string; targetId: string; image: string }
  | { kind: 'spinor'; device: string; boardId: string; image: string }
  /** The staged layout on an SD card or NVMe drive attached to this computer (not the board). */
  | { kind: 'stage-disk'; target: 'sd' | 'nvme'; device: string; boardId: string; winpe: string; appVersion: string;
      image: { path: string; extents: Extent[] | null; name: 'install.wim' | 'install.esd'; size: number;
        sha256: string | null; index: number; edition: string; build: number };
      setup: SetupOptions; extras: Array<{ path: string; base64: string }> };

const CHUNK = 4 << 20;

async function runDiskJob(job: Extract<BoardJob, { kind: 'stage-disk' }>, send: (m: HelperMessage) => void,
  fail: (reason: string, detail?: string) => void): Promise<void> {
  const board = woaBoard(job.boardId);
  if (!board) return fail('Unknown board.');
  // The same check the SD writer makes: never a system disk, a mounted
  // built-in disk or a read-only one, looked up again here.
  const drivelist = await import('drivelist');
  const drives = await withDiskFacts(await drivelist.list() as unknown as DriveInfo[]);
  if (!isOfferedTarget(job.device, drives, { minSize: MIN_DISK_BYTES, platform: process.platform, internal: false })) {
    return fail(`${job.device} is not a drive the imager writes to (system disk, read-only, too small, or gone). Nothing was written.`);
  }
  const d = drives.find((x) => x.device === job.device)!;
  const planned = planDiskStage(job, d.size ?? 0);
  if ('stop' in planned) return fail(planned.stop);
  try {
    const regions = planned.regions;
    const bad = await writeDriveRegions(job.device, regions, send);
    if (bad) return fail(`${bad} Write it again.`);
    send({ type: 'done', ok: true, sha256: '' });
  } finally {
    planned.close();
  }
}

/**
 * The staged layout for an SD card or NVMe drive of diskBytes (a fresh GPT:
 * what is on the drive now does not matter). Also used by the main process
 * on macOS, which writes it through maskrom-studio-rawdisk. close() closes
 * the files the regions read from.
 */
export function planDiskStage(job: Extract<BoardJob, { kind: 'stage-disk' }>, diskBytes: number):
  { regions: Region[]; close(): void } | { stop: string } {
  const board = woaBoard(job.boardId);
  if (!board) return { stop: 'Unknown board.' };
  const winpe = fileSource(job.winpe);
  const file = fileSource(job.image.path);
  const close = () => { winpe.close(); file.close(); };
  try {
    const source = job.image.extents ? extentSource(file, { path: job.image.name, size: job.image.size, extents: job.image.extents }) : file;
    const regions = planStage({
      board, target: job.target, diskBytes, head: new Uint8Array(34 * 512), winpe,
      image: { source, name: job.image.name, sha256: job.image.sha256, index: job.image.index, edition: job.image.edition, build: job.image.build },
      rand: (n) => new Uint8Array(randomBytes(n)), appVersion: job.appVersion,
      setup: job.setup, extras: job.extras.map((e) => ({ path: e.path, data: new Uint8Array(Buffer.from(e.base64, 'base64')) })),
    }).regions;
    return { regions, close };
  } catch (e) {
    close();
    if (e instanceof StageError) return { stop: e.message };
    throw e;
  }
}

export function fileSource(path: string): ByteSource & { close(): void } {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  return {
    size,
    read(position, length) {
      const b = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, b, got, length - got, position + got);
        if (n === 0) throw new Error(`${path} ended early`);
        got += n;
      }
      return new Uint8Array(b.buffer, b.byteOffset, length);
    },
    close: () => closeSync(fd),
  };
}

function deviceBytes(fd: number, device: string): number {
  const name = device.replace(/^\/dev\//, '');
  try {
    return Number(readFileSync(`/sys/block/${name}/size`, 'utf8').trim()) * 512;
  } catch {
    return fstatSync(fd).size;
  }
}

function flushCache(device: string): void {
  spawnSync('blockdev', ['--flushbufs', device]);
}

async function writeAndVerify(device: string, regions: Region[], send: (m: HelperMessage) => void): Promise<string | null> {
  const total = regions.reduce((s, r) => s + r.source.size, 0);
  const sums: string[] = [];
  const fd = openSync(device, 'r+');
  const started = Date.now();
  let done = 0;
  try {
    for (const r of regions) {
      const h = createHash('sha256');
      for (let off = 0; off < r.source.size; off += CHUNK) {
        const n = Math.min(CHUNK, r.source.size - off);
        const b = r.source.read(off, n);
        h.update(b);
        let w = 0;
        while (w < n) w += writeSync(fd, b, w, n - w, r.lba * 512 + off + w);
        done += n;
        send({ type: 'progress', stage: 'write', bytes: done, percent: Math.floor((done * 100) / total),
          speed: done / Math.max(0.001, (Date.now() - started) / 1000) });
      }
      sums.push(h.digest('hex'));
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  flushCache(device);
  const rd = openSync(device, 'r');
  let checked = 0;
  try {
    for (const [i, r] of regions.entries()) {
      const h = createHash('sha256');
      const b = Buffer.allocUnsafe(CHUNK);
      for (let off = 0; off < r.source.size; off += CHUNK) {
        const n = Math.min(CHUNK, r.source.size - off);
        let got = 0;
        while (got < n) {
          const k = readSync(rd, b, got, n - got, r.lba * 512 + off + got);
          if (k === 0) return `${r.label}: the disk ended while reading it back`;
          got += k;
        }
        h.update(b.subarray(0, n));
        checked += n;
        send({ type: 'progress', stage: 'verify', bytes: checked, percent: Math.floor((checked * 100) / total), speed: 0 });
      }
      if (h.digest('hex') !== sums[i]) return `${r.label} does not read back as written (sector ${r.lba}).`;
    }
  } finally {
    closeSync(rd);
  }
  spawnSync('blockdev', ['--rereadpt', device]);
  return null;
}

/**
 * Write regions to a drive attached to this computer through etcher-sdk's
 * BlockDevice (which on Windows cleans the disk first and handles
 * alignment), then read every region back and compare.
 */
async function writeDriveRegions(device: string, regions: Region[], send: (m: HelperMessage) => void): Promise<string | null> {
  const drivelist = await import('drivelist');
  const { BlockDevice } = await import('etcher-sdk/build/source-destination/block-device');
  const drive = (await drivelist.list()).find((d) => d.device === device);
  if (!drive) return `${device} is no longer connected.`;
  const total = regions.reduce((a, r) => a + r.source.size, 0);
  // Buffered, not O_DIRECT: these buffers are not memory-aligned. The cache
  // is flushed before the read-back, so the read-back sees the drive.
  const dev = new BlockDevice({ drive, write: true, direct: false, unmountOnSuccess: false });
  await dev.open();
  const sums: string[] = [];
  const started = Date.now();
  let done = 0;
  try {
    for (const r of regions) {
      const h = createHash('sha256');
      for (let off = 0; off < r.source.size; off += CHUNK) {
        const n = Math.min(CHUNK, r.source.size - off);
        const b = Buffer.from(r.source.read(off, n));
        h.update(b);
        await dev.write(b, 0, n, r.lba * 512 + off);
        done += n;
        send({ type: 'progress', stage: 'write', bytes: done, percent: Math.floor((done * 100) / total),
          speed: done / Math.max(0.001, (Date.now() - started) / 1000) });
      }
      sums.push(h.digest('hex'));
    }
  } finally {
    await dev.close();
  }
  if (process.platform === 'linux') flushCache(device);
  const rd = new BlockDevice({ drive, write: false, direct: false });
  await rd.open();
  let checked = 0;
  try {
    for (const [i, r] of regions.entries()) {
      const h = createHash('sha256');
      for (let off = 0; off < r.source.size; off += CHUNK) {
        const n = Math.min(CHUNK, r.source.size - off);
        const b = Buffer.alloc(n);
        await rd.read(b, 0, n, r.lba * 512 + off);
        h.update(b);
        checked += n;
        send({ type: 'progress', stage: 'verify', bytes: checked, percent: Math.floor((checked * 100) / total), speed: 0 });
      }
      if (h.digest('hex') !== sums[i]) return `${r.label} does not read back as written (sector ${r.lba}).`;
    }
  } finally {
    await rd.close();
  }
  return null;
}

export async function runBoardJob(job: BoardJob, send: (m: HelperMessage) => void): Promise<void> {
  const fail = (reason: string, detail?: string) => send({ type: 'done', ok: false, reason, ...(detail ? { detail } : {}) });
  if (job.kind === 'stage-disk') return runDiskJob(job, send, fail);
  const here = await boardHere();
  const board = woaBoard(job.boardId);
  if (!here.rk3576 || !board) return fail('This is not an RK3576 board the imager knows. Nothing was written.');
  if (here.board && here.board.id !== board.id) return fail(`This board is a ${here.board.name}, not a ${board.name}. Nothing was written.`);

  if (job.kind === 'spinor') {
    const mtd = here.mtd.find((m) => m.device === job.device);
    if (!mtd) return fail(`${job.device} is not an SPI NOR flash on this board. Nothing was written.`);
    const img = fileSource(job.image);
    const size = img.size;
    img.close();
    if (size > mtd.bytes) return fail(`The image (${size} bytes) is larger than the SPI NOR flash (${mtd.bytes} bytes). Nothing was written.`);
    const flashcp = ['/usr/sbin/flashcp', '/usr/bin/flashcp', '/sbin/flashcp'].find((p) => existsSync(p));
    if (!flashcp) return fail('flashcp is not installed. Install mtd-utils (it erases, writes and checks the flash) and try again. Nothing was written.');
    send({ type: 'progress', stage: 'write', bytes: 0, percent: 0, speed: 0 });
    const r = spawnSync(flashcp, ['-v', job.image, job.device], { encoding: 'utf8' });
    if (r.status !== 0) return fail('flashcp failed. The SPI NOR flash may be partly written: write it again before restarting.', `${r.stdout}\n${r.stderr}`.trim());
    send({ type: 'progress', stage: 'verify', bytes: size, percent: 100, speed: 0 });
    return send({ type: 'done', ok: true, sha256: '' });
  }

  if (!here.emmc || here.emmc.device !== job.device) return fail(`${job.device} is not this board's eMMC. Nothing was written.`);
  if (here.emmcRefusal) return fail(`${here.emmcRefusal} Nothing was written.`);

  const fd = openSync(job.device, 'r');
  const head = Buffer.alloc(34 * 512);
  readSync(fd, head, 0, head.length, 0);
  const capacity = deviceBytes(fd, job.device);
  closeSync(fd);

  const open: Array<{ close(): void }> = [];
  try {
    let regions: Region[];
    if (job.kind === 'stage') {
      const winpe = fileSource(job.winpe);
      const file = fileSource(job.image.path);
      open.push(winpe, file);
      const source = job.image.extents ? extentSource(file, { path: job.image.name, size: job.image.size, extents: job.image.extents }) : file;
      try {
        regions = planStage({
          board, diskBytes: capacity, head: new Uint8Array(head), winpe,
          image: { source, name: job.image.name, sha256: job.image.sha256, index: job.image.index, edition: job.image.edition, build: job.image.build },
          rand: (n) => new Uint8Array(randomBytes(n)), appVersion: job.appVersion,
          setup: job.setup, extras: job.extras.map((e) => ({ path: e.path, data: new Uint8Array(Buffer.from(e.base64, 'base64')) })),
        }).regions;
      } catch (e) {
        if (e instanceof StageError) return fail(e.message);
        throw e;
      }
    } else {
      const target = firmwareTargets(board).find((t) => t.id === job.targetId);
      if (!target) return fail(`Unknown firmware choice ${job.targetId}.`);
      const img = fileSource(job.image);
      open.push(img);
      const r = await firmwareRegions(board, target, img, { capacity, head: new Uint8Array(head) });
      if ('stop' in r) return fail(r.stop);
      regions = r.regions;
    }
    const bad = await writeAndVerify(job.device, regions, send);
    if (bad) return fail(`${bad} Write it again.`);
    send({ type: 'done', ok: true, sha256: '' });
  } finally {
    for (const o of open) o.close();
  }
}
