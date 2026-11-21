// The Armbian image the user chose, made ready for the eMMC: its root
// partition copied out to a file of the app's own (the user's image is
// never changed), checked, and edited offline with e2fsprogs (debugfs,
// tune2fs, e2fsck), which need no administrator rights on a file. No loop
// mounts. What is changed and why: src/woa/armbian.ts. No Electron here, so
// the tests run it against small ext4 images made with mkfs.ext4.
//
// e2fsprogs is on every Linux; on macOS it comes from Homebrew
// (`brew install e2fsprogs`, keg-only, found where Homebrew puts it). There
// is no e2fsprogs for Windows, so the page does not offer Armbian there.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  ArmbianError, armbianReleaseProblem, debugfsScript, ext4Superblock, parseReleaseFile, rootfsEdits, rootfsPartition,
  type EditInput, type FsOp, type RootfsFacts,
} from '../woa/armbian';
import type { BoardId } from '../woa/boards';
import { openImage, xzExtractSize, detectCompression } from './image-source';

export interface E2fs { debugfs: string; tune2fs: string; e2fsck: string }

/** debugfs, tune2fs and e2fsck, or null when e2fsprogs is not installed. */
export function findE2fsprogs(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): E2fs | null {
  if (platform === 'win32') return null;
  const dirs = [
    ...(env.WOA_IMAGER_E2FSPROGS ? [env.WOA_IMAGER_E2FSPROGS] : []),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    '/usr/sbin', '/sbin', '/usr/local/sbin',
    '/opt/homebrew/opt/e2fsprogs/sbin', '/usr/local/opt/e2fsprogs/sbin', '/opt/local/sbin',
  ];
  const find = (name: string) => dirs.map((d) => join(d, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  const debugfs = find('debugfs'), tune2fs = find('tune2fs'), e2fsck = find('e2fsck');
  return debugfs && tune2fs && e2fsck ? { debugfs, tune2fs, e2fsck } : null;
}

export const NO_E2FSPROGS = 'armbian.notools';

function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** One debugfs request against the file system, read only. */
function debugfs(e: E2fs, fs: string, request: string): string {
  return run(e.debugfs, ['-R', request, fs]).stdout;
}

/** Mode, owner and size of a path, or null when it is not there. */
export function statPath(e: E2fs, fs: string, path: string): { type: string; mode: number; uid: number; gid: number; size: number } | null {
  const out = debugfs(e, fs, `stat ${path}`);
  const m = /Type:\s+(\S+)\s+Mode:\s+([0-7]+)/.exec(out);
  const u = /User:\s+(\d+)\s+Group:\s+(\d+)/.exec(out);
  const s = /Size:\s+(\d+)/.exec(out);
  if (!m || !u) return null;
  return { type: m[1], mode: parseInt(m[2], 8), uid: Number(u[1]), gid: Number(u[2]), size: s ? Number(s[1]) : 0 };
}

export function catFile(e: E2fs, fs: string, path: string): string {
  return debugfs(e, fs, `cat ${path}`);
}

export interface ArmbianImage {
  /** The copy of the root partition, owned by the app. */
  rootfs: string;
  rootfsBytes: number;
  release: Record<string, string>;
  facts: RootfsFacts;
  label: string;
}

type Progress = (p: { stage: 'decompress'; bytes: number; total: number }) => void;

/**
 * Copy the one root partition of an Armbian image (.img, .img.xz, .gz,
 * .bz2) into `outPath`, decompressing as it goes and stopping at the end of
 * the partition. Returns where it was in the image.
 */
export async function extractRootfs(image: string, outPath: string, progress: Progress, signal?: AbortSignal): Promise<{ offset: number; bytes: number }> {
  const compression = await detectCompression(image);
  const imageBytes = compression === null ? statSync(image).size : compression === 'xz' ? (await xzExtractSize(image)) || Infinity : Infinity;
  const src = await openImage(image);
  const HEAD = 1 << 20;
  const head = Buffer.alloc(HEAD);
  let headLen = 0;
  let pos = 0;
  let part: { offset: number; bytes: number } | null = null;
  let fd: number | null = null;
  let written = 0;
  try {
    for await (const c of src.stream as AsyncIterable<Buffer>) {
      if (signal?.aborted) throw new Error('Cancelled.');
      let chunk = c;
      if (!part) {
        const n = Math.min(HEAD - headLen, chunk.length);
        chunk.copy(head, headLen, 0, n);
        headLen += n;
        if (headLen < HEAD) { pos += chunk.length; continue; }
        part = rootfsPartition(new Uint8Array(head), imageBytes);
        if (part.offset < HEAD) throw new ArmbianError('The root partition starts inside the first MiB of the image, which Armbian images do not do.');
        checkFreeSpace(outPath, part.bytes);
        fd = openSync(outPath, 'w', 0o600);
      }
      const start = pos, end = pos + chunk.length;
      pos = end;
      const a = Math.max(start, part.offset), b = Math.min(end, part.offset + part.bytes);
      if (b > a) {
        chunk = chunk.subarray(a - start, b - start);
        let w = 0;
        while (w < chunk.length) w += writeSync(fd!, chunk, w, chunk.length - w, written + w);
        written += chunk.length;
        progress({ stage: 'decompress', bytes: written, total: part.bytes });
      }
      if (pos >= part.offset + part.bytes) break;
    }
  } finally {
    if (fd !== null) closeSync(fd);
    (src.stream as { destroy?: () => void }).destroy?.();
    await src.close();
  }
  if (!part) throw new ArmbianError('The image is smaller than 1 MiB: not an Armbian image.');
  if (written !== part.bytes) {
    rmSync(outPath, { force: true });
    throw new ArmbianError('The image ended before its root partition did. Is the download complete?');
  }
  return part;
}

function checkFreeSpace(outPath: string, bytes: number): void {
  const dir = outPath.slice(0, Math.max(outPath.lastIndexOf('/'), outPath.lastIndexOf('\\')));
  try {
    const s = statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < bytes + (256 << 20)) {
      throw new ArmbianError(`The Armbian root file system needs ${(bytes / 1e9).toFixed(1)} GB of free space on this computer while it is prepared (${dir}); there are ${(free / 1e9).toFixed(1)} GB.`);
    }
  } catch (e) {
    if (e instanceof ArmbianError) throw e;
  }
}

function readHead(path: string): Uint8Array {
  const b = Buffer.alloc(2048);
  const fd = openSync(path, 'r');
  try { readSync(fd, b, 0, 2048, 0); } finally { closeSync(fd); }
  return new Uint8Array(b);
}

/** The directories rootfsEdits() may have to make, to be looked up first. */
function dirsOf(ops: FsOp[]): string[] {
  const out = new Set<string>();
  for (const x of ops) {
    const parts = x.path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length + (x.op === 'mkdir' ? 1 : 0); i++) out.add(`/${parts.slice(0, i).join('/')}`);
  }
  return [...out];
}

/** Read what the edits depend on, and check this is an Armbian for the board. */
export function inspectRootfs(e: E2fs, rootfs: string, boardId: BoardId): ArmbianImage {
  const sb = ext4Superblock(readHead(rootfs));
  if (sb.bytes > statSync(rootfs).size) throw new ArmbianError('The root file system is larger than its partition. Is the image damaged?');
  const release = parseReleaseFile(catFile(e, rootfs, '/etc/armbian-release'));
  const problem = armbianReleaseProblem(release, boardId);
  if (problem) throw new ArmbianError(problem);
  const kernels = debugfs(e, rootfs, 'ls -p /boot').split('\n')
    .map((l) => l.split('/'))
    .filter((f) => f.length >= 6 && f[2].startsWith('100') && /^vmlinuz-\S+$/.test(f[5]))
    .map((f) => f[5].slice('vmlinuz-'.length));
  if (!kernels.length) throw new ArmbianError('The image has no kernel in /boot (vmlinuz-<version>).');
  const withStat = (path: string) => {
    const s = statPath(e, rootfs, path);
    return s && s.type === 'regular' ? { content: catFile(e, rootfs, path), mode: s.mode & 0o7777, uid: s.uid, gid: s.gid } : null;
  };
  const facts: RootfsFacts = { uuid: sb.uuid, fstab: withStat('/etc/fstab'), armbianEnv: withStat('/boot/armbianEnv.txt'), kernels, dirs: [] };
  // Which of the directories the edits use are there already.
  const probe = rootfsEdits({ boardId, uuid: '00000000-0000-4000-8000-000000000000', defaultOs: 'windows', timeout: 5, facts: { ...facts, dirs: [] }, account: null, sshKey: 'ssh-ed25519 x' });
  facts.dirs = dirsOf(probe).filter((d) => statPath(e, rootfs, d)?.type === 'directory');
  return { rootfs, rootfsBytes: statSync(rootfs).size, release, facts, label: sb.label };
}

/** A new random file system UUID. */
export function newUuid(rand: (n: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n))): string {
  const r = rand(16);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const h = Array.from(r, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Make every change: a fresh check (e2fsck -fy on the app's copy), the new
 * file system UUID (tune2fs -U), the files (debugfs -w -f), then a check
 * that changes nothing (e2fsck -fn) and every file read back. The host
 * files that carry the contents (one holds the password) live in a private
 * folder that is removed before this returns.
 */
export function applyEdits(e: E2fs, img: ArmbianImage, input: Omit<EditInput, 'facts'>, tmpRoot: string): FsOp[] {
  const ops = rootfsEdits({ ...input, facts: img.facts });
  const fsck = run(e.e2fsck, ['-fy', img.rootfs]);
  if (fsck.status >= 4) throw new ArmbianError('The root file system has errors e2fsck cannot repair.', { cause: fsck.stdout + fsck.stderr });
  const tune = run(e.tune2fs, ['-U', input.uuid, img.rootfs]);
  if (tune.status !== 0) throw new ArmbianError('tune2fs could not give the root file system a new UUID.', { cause: tune.stdout + tune.stderr });
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'edit-'));
  chmodSync(dir, 0o700);
  try {
    const hostFile = (i: number) => join(dir, `f${i}`);
    ops.forEach((x, i) => { if (x.op === 'write') writeFileSync(hostFile(i), x.content, { mode: 0o600 }); });
    const script = join(dir, 'edits.debugfs');
    writeFileSync(script, debugfsScript(ops, hostFile), { mode: 0o600 });
    const r = run(e.debugfs, ['-w', '-f', script, img.rootfs]);
    if (r.status !== 0) throw new ArmbianError('debugfs could not change the root file system.', { cause: r.stderr });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const check = run(e.e2fsck, ['-fn', img.rootfs]);
  if (check.status !== 0) throw new ArmbianError('After the changes e2fsck finds errors in the root file system. Nothing was written.', { cause: check.stdout });
  for (const x of ops) {
    const s = statPath(e, img.rootfs, x.path);
    if (x.op === 'write') {
      if (!s || s.type !== 'regular' || (s.mode & 0o7777) !== x.mode || s.uid !== (x.uid ?? 0) || s.gid !== (x.gid ?? 0)) throw new ArmbianError(`${x.path} is not in the root file system as it should be.`);
      if (catFile(e, img.rootfs, x.path) !== x.content) throw new ArmbianError(`${x.path} does not read back as written.`);
    } else if (x.op === 'symlink') {
      if (!s || s.type !== 'symlink') throw new ArmbianError(`${x.path} is not a link in the root file system.`);
      const target = /Fast link dest:\s*"(.*)"/.exec(debugfs(e, img.rootfs, `stat ${x.path}`))?.[1];
      if (target !== x.target) throw new ArmbianError(`${x.path} does not point to ${x.target}.`);
    } else if (!s || s.type !== 'directory') throw new ArmbianError(`${x.path} is not a directory in the root file system.`);
  }
  if (ext4Superblock(readHead(img.rootfs)).uuid !== input.uuid) throw new ArmbianError('The root file system did not take its new UUID.');
  return ops;
}

/** Everything left in the app's Armbian folder (copies of root file systems) goes. */
export function clearWork(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
