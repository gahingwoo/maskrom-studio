// Writing an SD card or USB drive on macOS.
//
// macOS lets Apple's /usr/libexec/authopen open a raw disk once the user
// has granted the right sys.openfile.readwrite./dev/rdiskN in the system's
// password dialog (Raspberry Pi Imager and Armbian Imager write the same
// way). Nothing of the imager runs as root, and the app needs no Full Disk
// Access: the small helper maskrom-studio-rawdisk (src/helper/macos/rawdisk.c)
// asks for the right, has authopen open the disk and receives the open file
// descriptor. This module, in the app's main process:
//
//   1. checks the target again (the list in the window could be stale);
//   2. unmounts the disk's volumes (diskutil, no rights needed);
//   3. starts the helper, which makes macOS ask for the password, once;
//   4. decompresses the image and streams it into the helper, which writes
//      whole blocks to the raw disk;
//   5. takes back what the helper then reads from the disk and compares its
//      SHA-256 with the release's extract_sha256.
//
// macWriteRegions does the same for the staged Windows layout on an SD card
// or NVMe drive: pieces at their own places (rawdisk --regions), each read
// back and compared with what was sent.
//
// Linux and Windows write through the elevated writer instead (elevate.ts).

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isOfferedTarget, type DriveInfo } from '../shared/targets';
import type { HelperOutcome } from './elevate';
import { openImage, type ImageSource } from './image-source';
import type { ByteSource } from '../woa/pieces';

/** Exit statuses of maskrom-studio-rawdisk (rawdisk.c). */
export const RAWDISK_EXIT = { ok: 0, args: 2, auth: 3, open: 4, write: 5, read: 6, input: 7, small: 8 } as const;

export const MISMATCH = 'The drive does not read back what the release contains. Do not use it; try another card or drive.';

/** /dev/disk4 gives /dev/rdisk4. Only whole disks: no partition (disk4s1), nothing else. */
export function rawDevice(device: string): string {
  const m = /^\/dev\/disk(\d+)$/.exec(device);
  if (!m) throw new Error(`${device} is not a whole macOS disk`);
  return `/dev/rdisk${m[1]}`;
}

/** The sentence added to the system's password dialog. */
export function promptText(device: string, description: string): string {
  // Printable ASCII only, and short: the text comes from the drive itself.
  const name = description.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const disk = device.replace('/dev/', '');
  return `Maskrom Studio will erase ${name ? `${name} (${disk})` : disk} and write the image to it.`;
}

export function rawdiskArgs(device: string, size: number, description: string): string[] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('bad image size');
  return [rawDevice(device), String(size), promptText(device, description)];
}

export interface RawdiskEnd {
  /** Exit status, or null when a signal ended the helper. */
  code: number | null;
  stderr: string;
  /** Bytes read back and their SHA-256. */
  readBack: number;
  sha256: string;
  /** Why feeding the image stopped, if it did. */
  feedError?: string;
}

/** What to tell the user after the helper has ended. */
export function outcomeOf(end: RawdiskEnd, expect: { size: number; sha256: string }): HelperOutcome {
  const fail = (reason: string, detail?: string): HelperOutcome =>
    ({ type: 'done', ok: false, reason, ...(detail ? { detail } : {}) });
  // The helper's own lines "opened ..." and "written" are not error text.
  const said = end.stderr.split('\n').filter((l) => l && !/^(opened \d+ \d+|written)$/.test(l)).join('\n').trim();
  switch (end.code) {
    case RAWDISK_EXIT.ok:
      if (end.readBack !== expect.size || end.sha256 !== expect.sha256) {
        return fail(MISMATCH, end.readBack !== expect.size
          ? `read ${end.readBack} bytes back, expected ${expect.size}`
          : `read back ${end.sha256}, release ${expect.sha256}`);
      }
      return { type: 'done', ok: true, sha256: end.sha256 };
    case RAWDISK_EXIT.auth:
      return fail('Administrator rights were not granted. Nothing was written.', said);
    case RAWDISK_EXIT.open:
      return fail('macOS did not open the drive for writing. Nothing was written. Take the drive out, put it back and try again.', said);
    case RAWDISK_EXIT.small:
      return fail('The drive is smaller than the image. Nothing was written.', said);
    case RAWDISK_EXIT.write:
      return fail('Writing failed.', said);
    case RAWDISK_EXIT.read:
      return fail('The drive could not be read back after writing. Do not use it; try another card or drive.', said);
    case RAWDISK_EXIT.input:
      return fail('Writing stopped with an error.', [end.feedError, said].filter(Boolean).join('\n'));
    default:
      return fail('The writer stopped without saying why.', [end.code === null ? 'ended by a signal' : `exit status ${end.code}`, said].filter(Boolean).join('\n'));
  }
}

/** Passes at most `size` bytes on and fails if more arrive; counts them. */
export function exactly(size: number, onBytes: (total: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > size) {
        cb(new Error(`the image holds more than the ${size} bytes the release states`));
        return;
      }
      onBytes(total);
      cb(null, chunk);
    },
    flush(cb) {
      cb(total < size ? new Error(`the image ended after ${total} of ${size} bytes`) : null);
    },
  });
}

async function listDrives(): Promise<DriveInfo[]> {
  const drivelist = await import('drivelist');
  return await drivelist.list() as unknown as DriveInfo[];
}

function unmountDisk(device: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/diskutil', ['unmountDisk', device], (err, stdout, stderr) => {
      if (err) reject(new Error(`${stdout}${stderr}`.trim() || String(err.message)));
      else resolve();
    });
  });
}

export interface MacWriteOptions {
  /** The .img.xz (or plain image) in the cache. */
  image: string;
  /** /dev/diskN as drivelist names it. */
  device: string;
  extractSize: number;
  extractSha256: string;
  /** maskrom-studio-rawdisk. */
  helperPath: string;
  onProgress: (p: { stage: 'write' | 'verify'; bytes: number; speed: number }) => void;
  signal?: AbortSignal;
  /**
   * Only for the CI test: write to a disk the target rules hide, a RAM disk
   * from hdiutil. The app never sets it.
   */
  testDisk?: boolean;
  /** Stand-ins for tests. */
  drives?: () => Promise<DriveInfo[]>;
  unmount?: (device: string) => Promise<void>;
  open?: (path: string) => Promise<ImageSource>;
}

const NOTHING = 'Nothing was written.';

export async function macWrite(o: MacWriteOptions): Promise<HelperOutcome> {
  const fail = (reason: string, detail?: string): HelperOutcome =>
    ({ type: 'done', ok: false, reason, ...(detail ? { detail } : {}) });

  const drives = await (o.drives ?? listDrives)();
  const drive = drives.find((d) => d.device === o.device);
  if (!o.testDisk) {
    if (!drive) return fail(`${o.device} is no longer connected.`);
    if (!isOfferedTarget(o.device, drives, { minSize: o.extractSize, platform: 'darwin' })) {
      return fail(`${o.device} is not a drive the imager writes to (system disk, read-only or too small). ${NOTHING}`);
    }
  }
  let args: string[];
  try {
    args = rawdiskArgs(o.device, o.extractSize, drive?.description ?? '');
  } catch (e) {
    return fail(`${(e as Error).message}. ${NOTHING}`);
  }
  if (o.signal?.aborted) return fail(`Cancelled. ${NOTHING}`);
  try {
    await (o.unmount ?? unmountDisk)(o.device);
  } catch (e) {
    return fail(`The drive's volumes could not be unmounted. Close the programs that use it and try again. ${NOTHING}`, (e as Error).message);
  }
  if (o.signal?.aborted) return fail(`Cancelled. ${NOTHING}`);

  const child = spawn(o.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let spawnError: Error | null = null;
  let stderr = '';
  let opened = false;
  let noteOpened: () => void = () => {};
  const openedOrGone = new Promise<void>((r) => { noteOpened = r; });
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => { spawnError = e; noteOpened(); resolve(null); });
    child.on('close', (code) => { noteOpened(); resolve(code); });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
    if (!opened && /^opened \d+ \d+$/m.test(stderr)) { opened = true; noteOpened(); }
  });
  // A helper that has gone closes its stdin; the exit status says why.
  child.stdin.on('error', () => {});

  let lastSent = 0;
  const report = (stage: 'write' | 'verify', bytes: number, since: number) => {
    const now = Date.now();
    if (now - lastSent < 100 && bytes < o.extractSize) return;
    lastSent = now;
    o.onProgress({ stage, bytes, speed: Math.round(bytes * 1000 / Math.max(1, now - since)) });
  };

  const hash = createHash('sha256');
  let readBack = 0;
  let verifyStarted = 0;
  child.stdout.on('data', (c: Buffer) => {
    if (!verifyStarted) verifyStarted = Date.now();
    hash.update(c);
    readBack += c.length;
    report('verify', readBack, verifyStarted);
  });

  const onAbort = () => { child.kill('SIGTERM'); };
  o.signal?.addEventListener('abort', onAbort);
  let feedError: string | undefined;
  try {
    // Nothing is sent before the disk is open: until then the user is
    // looking at the password dialog.
    await openedOrGone;
    if (opened && !o.signal?.aborted) {
      const src = await (o.open ?? openImage)(o.image);
      const writeStarted = Date.now();
      try {
        await pipeline(src.stream, exactly(o.extractSize, (n) => report('write', n, writeStarted)), child.stdin);
      } catch (e) {
        feedError = String((e as Error)?.message ?? e);
        // The helper sees the end of its input and stops with "ended early".
        child.stdin.destroy();
      } finally {
        await src.close();
      }
    }
    const code = await exited;
    if (o.signal?.aborted) {
      return fail(opened ? 'Cancelled. The drive is only partly written.' : `Cancelled. ${NOTHING}`);
    }
    if (spawnError) return fail('The writer could not be started.', String((spawnError as Error).message));
    return outcomeOf({ code, stderr, readBack, sha256: hash.digest('hex'), feedError },
      { size: o.extractSize, sha256: o.extractSha256 });
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

// --- regions: the staged Windows layout on an SD card or NVMe drive --------------

/** One piece to write: its first sector (512 bytes) and its bytes. */
export interface MacRegion {
  lba: number;
  source: ByteSource;
  label: string;
}

/** The 16-byte header rawdisk --regions reads before each region; length 0 ends the list. */
export function regionHeader(offset: number, length: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(offset), 0);
  b.writeBigUInt64LE(BigInt(length), 8);
  return b;
}

/** The arguments of rawdisk --regions: the raw disk, where the last region ends, the prompt. */
export function regionArgs(device: string, regions: MacRegion[], description: string): string[] {
  if (regions.length === 0) throw new Error('nothing to write');
  let end = 0;
  for (const r of regions) {
    if (!Number.isSafeInteger(r.lba) || r.lba < 0 || r.source.size <= 0 || r.source.size % SECTOR) {
      throw new Error(`${r.label} is not whole sectors`);
    }
    end = Math.max(end, r.lba * SECTOR + r.source.size);
  }
  return ['--regions', rawDevice(device), String(end), promptText(device, description).replace('write the image to it', 'write Windows staging files to it')];
}

export interface MacRegionsOptions {
  device: string;
  regions: MacRegion[];
  /** The smallest drive this is offered for (stage-layout.ts MIN_DISK_BYTES). */
  minSize: number;
  helperPath: string;
  onProgress: (p: { stage: 'write' | 'verify'; bytes: number; total: number; speed: number }) => void;
  signal?: AbortSignal;
  /** Only for the CI test: a disk image from hdiutil, which the target rules hide. */
  testDisk?: boolean;
  drives?: () => Promise<DriveInfo[]>;
  unmount?: (device: string) => Promise<void>;
  /** After a good write, so macOS does not keep the new volumes mounted; failures are ignored. */
  eject?: (device: string) => Promise<void>;
}

function ejectDisk(device: string): Promise<void> {
  return new Promise((resolve) => { execFile('/usr/sbin/diskutil', ['eject', device], () => resolve()); });
}

const SECTOR = 512;
const PIECE = 4 << 20;

/**
 * Write the regions to a drive of this Mac through maskrom-studio-rawdisk
 * --regions, read every one back and compare it with what was sent.
 */
export async function macWriteRegions(o: MacRegionsOptions): Promise<HelperOutcome> {
  const fail = (reason: string, detail?: string): HelperOutcome =>
    ({ type: 'done', ok: false, reason, ...(detail ? { detail } : {}) });
  const drives = await (o.drives ?? listDrives)();
  const drive = drives.find((d) => d.device === o.device);
  if (!o.testDisk) {
    if (!drive) return fail(`${o.device} is no longer connected.`);
    if (!isOfferedTarget(o.device, drives, { minSize: o.minSize, platform: 'darwin' })) {
      return fail(`${o.device} is not a drive the imager writes to (system disk, read-only or too small). ${NOTHING}`);
    }
  }
  let args: string[];
  try {
    args = regionArgs(o.device, o.regions, drive?.description ?? '');
  } catch (e) {
    return fail(`${(e as Error).message}. ${NOTHING}`);
  }
  if (o.signal?.aborted) return fail(`Cancelled. ${NOTHING}`);
  try {
    await (o.unmount ?? unmountDisk)(o.device);
  } catch (e) {
    return fail(`The drive's volumes could not be unmounted. Close the programs that use it and try again. ${NOTHING}`, (e as Error).message);
  }
  if (o.signal?.aborted) return fail(`Cancelled. ${NOTHING}`);

  const total = o.regions.reduce((s, r) => s + r.source.size, 0);
  const child = spawn(o.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let spawnError: Error | null = null;
  let stderr = '';
  let opened = false;
  let noteOpened: () => void = () => {};
  const openedOrGone = new Promise<void>((r) => { noteOpened = r; });
  let gone = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => { spawnError = e; gone = true; noteOpened(); resolve(null); });
    child.on('close', (code) => { gone = true; noteOpened(); resolve(code); });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
    if (!opened && /^opened \d+ \d+$/m.test(stderr)) { opened = true; noteOpened(); }
  });
  child.stdin.on('error', () => {});

  let lastSent = 0;
  const report = (stage: 'write' | 'verify', bytes: number, since: number) => {
    const now = Date.now();
    if (now - lastSent < 100 && bytes < total) return;
    lastSent = now;
    o.onProgress({ stage, bytes, total, speed: Math.round(bytes * 1000 / Math.max(1, now - since)) });
  };

  // The read-back arrives region after region, in the order written.
  const sent: string[] = [];
  const back: string[] = [];
  let cur = 0;
  let inCur = 0;
  let h = createHash('sha256');
  let readBack = 0;
  let verifyStarted = 0;
  child.stdout.on('data', (c: Buffer) => {
    if (!verifyStarted) verifyStarted = Date.now();
    readBack += c.length;
    let off = 0;
    while (off < c.length && cur < o.regions.length) {
      const n = Math.min(c.length - off, o.regions[cur].source.size - inCur);
      h.update(c.subarray(off, off + n));
      off += n;
      inCur += n;
      if (inCur === o.regions[cur].source.size) { back.push(h.digest('hex')); h = createHash('sha256'); cur++; inCur = 0; }
    }
    report('verify', readBack, verifyStarted);
  });

  const onAbort = () => { child.kill('SIGTERM'); };
  o.signal?.addEventListener('abort', onAbort);
  const put = (b: Buffer) => new Promise<void>((resolve, reject) => {
    if (gone || child.stdin.destroyed) { reject(new Error('the writer stopped')); return; }
    if (child.stdin.write(b)) resolve();
    else {
      const done = () => { child.stdin.off('drain', done); child.off('close', done); if (gone) reject(new Error('the writer stopped')); else resolve(); };
      child.stdin.on('drain', done);
      child.once('close', done);
    }
  });
  let feedError: string | undefined;
  try {
    await openedOrGone;
    if (opened && !o.signal?.aborted) {
      const started = Date.now();
      let done = 0;
      try {
        for (const r of o.regions) {
          await put(regionHeader(r.lba * SECTOR, r.source.size));
          const rh = createHash('sha256');
          for (let off = 0; off < r.source.size; off += PIECE) {
            if (o.signal?.aborted) throw new Error('cancelled');
            const b = Buffer.from(r.source.read(off, Math.min(PIECE, r.source.size - off)));
            rh.update(b);
            await put(b);
            done += b.length;
            report('write', done, started);
          }
          sent.push(rh.digest('hex'));
        }
        await put(regionHeader(0, 0));
        child.stdin.end();
      } catch (e) {
        feedError = String((e as Error)?.message ?? e);
        child.stdin.destroy();
      }
    }
    const code = await exited;
    if (o.signal?.aborted) {
      return fail(opened ? 'Cancelled. The drive is only partly written.' : `Cancelled. ${NOTHING}`);
    }
    if (spawnError) return fail('The writer could not be started.', String((spawnError as Error).message));
    if (code === RAWDISK_EXIT.ok) {
      const bad = o.regions.findIndex((_r, i) => back[i] !== sent[i]);
      if (bad >= 0 || readBack !== total) {
        const r = o.regions[bad >= 0 ? bad : 0];
        return fail(`${r.label} does not read back as written (sector ${r.lba}). Write it again.`,
          readBack !== total ? `read ${readBack} bytes back, expected ${total}` : undefined);
      }
      await (o.eject ?? ejectDisk)(o.device).catch(() => {});
      return { type: 'done', ok: true, sha256: '' };
    }
    // The other statuses read as for a whole image.
    return outcomeOf({ code, stderr, readBack, sha256: '', feedError }, { size: total, sha256: '' });
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
