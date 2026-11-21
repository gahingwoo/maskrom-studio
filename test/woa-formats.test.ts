import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesSource, concatSource, patchedSource } from '../src/woa/pieces';
import { extentSource, UdfVolume } from '../src/woa/udf';
import { installable, readWimInfo, refuseReason } from '../src/woa/wim';
import { buildGpt, findFirmwarePartition, parsePrimaryGpt, randomGuid, TYPE_BASIC_DATA } from '../src/woa/gpt';
import { FatVolume } from '../src/woa/fat32';

const fx = (n: string) => join(__dirname, 'fixtures', n);
const iso = new Uint8Array(execFileSync('xz', ['-dc', fx('udf-small.iso.xz')], { maxBuffer: 64 << 20 }));
const wim = new Uint8Array(readFileSync(fx('two-editions.wim')));
const rand = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);

describe('UDF', () => {
  it('finds sources/install.wim in an ISO and reads it byte for byte', () => {
    const v = new UdfVolume(bytesSource(iso));
    const f = v.find('SOURCES/Install.wim');
    expect(f).not.toBeNull();
    expect(f!.size).toBe(wim.length);
    const src = extentSource(bytesSource(iso), f!);
    expect(Buffer.compare(src.read(0, src.size), wim)).toBe(0);
    expect(v.find('sources/install.esd')).toBeNull();
    expect(v.find('efi/boot/bootaa64.efi')!.size).toBe(5);
  });

  it('refuses a file that is not an ISO', () => {
    expect(() => new UdfVolume(bytesSource(new Uint8Array(600 * 2048)))).toThrow(/not a UDF/);
  });
});

describe('WIM', () => {
  it('reads the editions, architecture and build', () => {
    const info = readWimInfo(bytesSource(wim));
    expect(info.kind).toBe('wim');
    expect(info.totalParts).toBe(1);
    const eds = installable(info);
    expect(eds.map((e) => [e.index, e.name, e.arch, e.build])).toEqual([
      [1, 'Windows 11 Pro', 12, 22631], [2, 'Windows 11 Home', 12, 26100],
    ]);
    expect(refuseReason(eds[0])).toBeNull();
    expect(refuseReason(eds[1])).toMatch(/24H2/);
    expect(refuseReason({ ...eds[0], arch: 9 })).toMatch(/x64/);
  });

  it('says a truncated image is incomplete', () => {
    expect(() => readWimInfo(bytesSource(wim.slice(0, 1000)))).toThrow(/incomplete/);
    expect(() => readWimInfo(bytesSource(new Uint8Array(4096)))).toThrow(/not a Windows image/);
  });
});

describe('GPT', () => {
  const head = new Uint8Array(readFileSync(fx('tspi3m-emmc-head.bin')));
  it('reads the firmware partition of the edk2-rk3576 eMMC layout', () => {
    const t = parsePrimaryGpt(head);
    const fw = findFirmwarePartition(t);
    expect(typeof fw).not.toBe('string');
    expect(t.partitions.map((p) => p.name)).toEqual(['firmware', 'data']);
  });

  it('builds a table that sfdisk reads, with the firmware entry unchanged', () => {
    const t = parsePrimaryGpt(head);
    const fw = findFirmwarePartition(t);
    if (typeof fw === 'string') throw new Error(fw);
    const disk = 121110528;
    const g = buildGpt({
      diskSectors: disk, diskGuid: randomGuid(rand), keep: fw, mbr: t.mbr,
      parts: [{ type: TYPE_BASIC_DATA, guid: randomGuid(rand), firstLba: 110000128, lastLba: 112000000, name: 'WOA-STAGE-BOOT' }],
    });
    const again = parsePrimaryGpt(g.primary);
    expect(again.partitions[0].raw).toEqual(fw.raw);
    expect(again.partitions[1].name).toBe('WOA-STAGE-BOOT');
    expect(g.backupStart + g.backup.length / 512).toBe(disk);
    if (spawnSync('sfdisk', ['--version']).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'gpt-'));
      const p = join(dir, 'd.img');
      // A sparse file of the disk's size with both tables in it.
      writeFileSync(p, g.primary);
      execFileSync('truncate', ['-s', String(disk * 512), p]);
      const fd = require('node:fs').openSync(p, 'r+');
      require('node:fs').writeSync(fd, g.backup, 0, g.backup.length, g.backupStart * 512);
      require('node:fs').closeSync(fd);
      const r = spawnSync('sfdisk', ['--verify', p], { encoding: 'utf8' });
      expect(r.stdout + r.stderr).not.toMatch(/corrupt|invalid|mismatch/i);
      const dump = execFileSync('sfdisk', ['-d', p], { encoding: 'utf8' });
      expect(dump).toMatch(/start=\s*64, size=\s*131008/);
      expect(dump).toMatch(/WOA-STAGE-BOOT/);
      execFileSync('rm', ['-rf', dir]);
    }
  });

  it('refuses a disk without the firmware partition', () => {
    const t = parsePrimaryGpt(head);
    expect(findFirmwarePartition({ ...t, partitions: t.partitions.slice(1) })).toMatch(/sector 64/);
  });
});

describe('FAT32', () => {
  const hasTools = spawnSync('mkfs.vfat', ['--help']).status !== null && spawnSync('mcopy', ['--version']).status === 0;
  it.skipIf(!hasTools)('replaces one file in place and keeps the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fat-'));
    const img = join(dir, 'v.img');
    execFileSync('truncate', ['-s', '300M', img]);
    execFileSync('mkfs.vfat', ['-F', '32', '-n', 'WINPE', img]);
    const big = Buffer.alloc(14566, 'x');
    writeFileSync(join(dir, 'collect.cmd'), big);
    writeFileSync(join(dir, 'other.txt'), 'other file\r\n');
    const env = { ...process.env, MTOOLS_SKIP_CHECK: '1' };
    execFileSync('mmd', ['-i', img, '::/woa-debug'], { env });
    execFileSync('mcopy', ['-i', img, join(dir, 'collect.cmd'), '::/woa-debug/collect.cmd'], { env });
    execFileSync('mcopy', ['-i', img, join(dir, 'other.txt'), '::/other.txt'], { env });
    const base = bytesSource(new Uint8Array(readFileSync(img)));
    const vol = new FatVolume(base);
    expect(vol.readFile('WOA-DEBUG/COLLECT.CMD').length).toBe(14566);
    const next = new TextEncoder().encode('@echo off\r\necho staged\r\n');
    const patched = patchedSource(base, vol.replaceFile('woa-debug/collect.cmd', next));
    // Only the used parts, written onto an empty file, must still be the same file system.
    const out = new Uint8Array(base.size);
    for (const [a, b] of vol.usedRanges()) out.set(patched.read(a, b - a), a);
    expect(vol.usedRanges().reduce((s, [a, b]) => s + b - a, 0)).toBeLessThan(base.size / 2);
    writeFileSync(img, out);
    expect(execFileSync('mtype', ['-i', img, '::/woa-debug/collect.cmd'], { env, encoding: 'latin1' })).toBe('@echo off\r\necho staged\r\n');
    expect(execFileSync('mtype', ['-i', img, '::/other.txt'], { env, encoding: 'latin1' })).toBe('other file\r\n');
    const fsck = spawnSync('fsck.fat', ['-n', img], { encoding: 'utf8' });
    expect(fsck.status).toBe(0);
    execFileSync('rm', ['-rf', dir]);
  });
});

describe('pieces', () => {
  it('reads across piece boundaries', () => {
    const s = concatSource([{ kind: 'bytes', data: Uint8Array.of(1, 2) }, { kind: 'zero', length: 3 }, { kind: 'range', source: bytesSource(Uint8Array.of(9, 8, 7)), offset: 1, length: 2 }]);
    expect(Array.from(s.read(0, s.size))).toEqual([1, 2, 0, 0, 0, 8, 7]);
    expect(Array.from(s.read(1, 5))).toEqual([2, 0, 0, 0, 8]);
  });
});
