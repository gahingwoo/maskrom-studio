// The staged layout written on macOS (mac-write.ts macWriteRegions) against a
// stand-in for maskrom-studio-rawdisk --regions that speaks the same
// protocol: 16-byte headers (offset, length), the data, a zero-length end,
// then every region read back in order. Its "disk" is a file.
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macWriteRegions, regionArgs, regionHeader, type MacRegion, type MacRegionsOptions } from '../src/main/mac-write';
import { bytesSource } from '../src/woa/pieces';
import type { DriveInfo } from '../src/shared/targets';

const work = mkdtempSync(join(tmpdir(), 'mac-regions-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const fake = join(work, 'fake-rawdisk');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_DISK + '.args', JSON.stringify(args));
if (args[0] !== '--regions') process.exit(2);
const end = Number(args[2]);
const mode = process.env.FAKE_RAWDISK || '';
if (mode === 'deny') { console.error('authorization not granted (cancelled)'); process.exit(3); }
if (mode === 'small') { process.stderr.write('opened 512 1000\\n'); console.error('the disk holds 1000 bytes'); process.exit(8); }
process.stderr.write('opened 512 ' + end + '\\n');
if (mode === 'stall') { setInterval(() => {}, 1000); return; }
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const all = Buffer.concat(chunks);
  const disk = Buffer.alloc(end, 0xa5);
  const list = [];
  let p = 0;
  for (;;) {
    if (p + 16 > all.length) { console.error('the region list ended early'); process.exit(7); }
    const off = Number(all.readBigUInt64LE(p)); const len = Number(all.readBigUInt64LE(p + 8)); p += 16;
    if (len === 0) break;
    if (p + len > all.length) { console.error('the data of a region ended early'); process.exit(7); }
    all.copy(disk, off, p, p + len); p += len; list.push([off, len]);
  }
  fs.writeFileSync(process.env.FAKE_DISK, disk);
  process.stderr.write('written\\n');
  const out = Buffer.concat(list.map(([o, l]) => Buffer.from(disk.subarray(o, o + l))));
  if (mode === 'corrupt') out[out.length - 3] ^= 1;
  process.stdout.write(out, () => process.exit(0));
});
`);
chmodSync(fake, 0o755);
const disk = join(work, 'disk.bin');
process.env.FAKE_DISK = disk;

const MiB = 1024 * 1024;
const regions: MacRegion[] = [
  { lba: 2048, source: bytesSource(new Uint8Array(randomBytes(9 * MiB + 512))), label: 'WinPE' },
  { lba: 40000, source: bytesSource(new Uint8Array(randomBytes(512 * 7))), label: 'Windows image' },
  { lba: 60000, source: bytesSource(new Uint8Array(randomBytes(512 * 33))), label: 'backup partition table' },
  { lba: 0, source: bytesSource(new Uint8Array(randomBytes(512 * 34))), label: 'partition table' },
];
const END = (60000 + 33) * 512;
const drive = (over: Partial<DriveInfo> = {}): DriveInfo => ({
  device: '/dev/disk4', description: 'Apple SDXC Reader', size: 64e9, mountpoints: [], isReadOnly: false,
  isSystem: false, isVirtual: false, isRemovable: true, isCard: true, isUSB: false, ...over,
});

async function write(mode: string, over: Partial<MacRegionsOptions> = {}) {
  process.env.FAKE_RAWDISK = mode;
  rmSync(disk, { force: true });
  rmSync(`${disk}.args`, { force: true });
  const progress: string[] = [];
  const unmounted: string[] = [];
  const ejected: string[] = [];
  const out = await macWriteRegions({
    device: '/dev/disk4', regions, minSize: 30e9, helperPath: fake,
    onProgress: (p) => { if (!progress.includes(p.stage)) progress.push(p.stage); },
    drives: async () => [drive()],
    unmount: async (d) => { unmounted.push(d); },
    eject: async (d) => { ejected.push(d); },
    ...over,
  });
  let started: string[] | null = null;
  try { started = JSON.parse(readFileSync(`${disk}.args`, 'utf8')); } catch { /* not started */ }
  return { out, progress, unmounted, ejected, started };
}

describe('the region protocol', () => {
  it('has a little-endian header and an end marker', () => {
    expect([...regionHeader(0x1_0000_0200, 512)]).toEqual([0, 2, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]);
    expect(regionHeader(0, 0).every((b) => b === 0)).toBe(true);
  });
  it('gives the helper the raw disk and where the last region ends', () => {
    const a = regionArgs('/dev/disk4', regions, 'Apple SDXC Reader');
    expect(a.slice(0, 3)).toEqual(['--regions', '/dev/rdisk4', String(END)]);
    expect(a[3]).toMatch(/erase Apple SDXC Reader \(disk4\)/);
  });
  it('refuses pieces that are not whole sectors, and partitions', () => {
    expect(() => regionArgs('/dev/disk4', [{ lba: 0, source: bytesSource(new Uint8Array(100)), label: 'x' }], '')).toThrow(/whole sectors/);
    expect(() => regionArgs('/dev/disk4s1', regions, '')).toThrow();
    expect(() => regionArgs('/dev/disk4', [], '')).toThrow();
  });
});

describe('writing the staged layout on macOS', () => {
  it('writes each region at its place, reads them back and ejects', async () => {
    const r = await write('');
    expect(r.out).toEqual({ type: 'done', ok: true, sha256: '' });
    expect(r.unmounted).toEqual(['/dev/disk4']);
    expect(r.ejected).toEqual(['/dev/disk4']);
    expect(r.progress).toEqual(['write', 'verify']);
    const d = readFileSync(disk);
    for (const g of regions) {
      expect(Buffer.compare(d.subarray(g.lba * 512, g.lba * 512 + g.source.size), Buffer.from(g.source.read(0, g.source.size)))).toBe(0);
    }
    // Between the regions the disk is untouched.
    expect(d.subarray(34 * 512, 2048 * 512).every((b) => b === 0xa5)).toBe(true);
  });
  it('names the region that reads back wrong', async () => {
    const r = await write('corrupt');
    expect(r.out).toMatchObject({ ok: false, reason: 'partition table does not read back as written (sector 0). Write it again.' });
    expect(r.ejected).toEqual([]);
  });
  it('never starts the helper for a system disk or one too small for Windows', async () => {
    for (const drives of [[drive({ isSystem: true })], [drive({ size: 16e9 })], [drive({ device: '/dev/disk9' })]]) {
      const r = await write('', { drives: async () => drives });
      expect(r.out.ok).toBe(false);
      expect(r.started).toBeNull();
      expect(r.unmounted).toEqual([]);
    }
  });
  it('says so when the password dialog was dismissed, or the disk is smaller', async () => {
    expect((await write('deny')).out).toMatchObject({ ok: false, reason: 'Administrator rights were not granted. Nothing was written.' });
    expect((await write('small')).out).toMatchObject({ ok: false, reason: 'The drive is smaller than the image. Nothing was written.' });
  });
  it('cancels during the write', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await write('stall', { signal: ac.signal });
    expect(r.out).toEqual({ type: 'done', ok: false, reason: 'Cancelled. The drive is only partly written.' });
  });
});
