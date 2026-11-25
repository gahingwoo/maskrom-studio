import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planStage, StageError } from '../src/woa/stage-layout';
import { parsePrimaryGpt } from '../src/woa/gpt';
import { woaBoard } from '../src/woa/boards';
import { bytesSource, type ByteSource } from '../src/woa/pieces';
import { crlf, LAUNCHER } from '../src/woa/stage-scripts';
import { BROWSER_GPU_PS1 } from '../src/woa/browser-gpu-script';
import { readArmbianImage, SLOT_LBA, resizeLeavesTableAlone } from '../src/woa/armbian-hybrid';
import { fakeArmbian } from './armbian-fixture';

const has = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args); return r.status !== null && !r.error; };
const tools = has('mkfs.vfat', ['--help']) && has('mcopy', ['--version']) && has('sgdisk', ['--version']) && has('sfdisk', ['--version']);
const env = { ...process.env, MTOOLS_SKIP_CHECK: '1' };
const head = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'tspi3m-emmc-head.bin')));
const rand = (() => { let x = 1; return (n: number) => Uint8Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) >>> 0; return x >>> 24; }); })();

function fileSource(path: string): ByteSource {
  const fd = openSync(path, 'r');
  const size = Number(execFileSync('stat', ['-c%s', path], { encoding: 'utf8' }).trim());
  return { size, read(p, n) { const b = Buffer.alloc(n); readSync(fd, b, 0, n, p); return new Uint8Array(b.buffer, b.byteOffset, n); } };
}

/** A small stand-in for woa-rk3576's winpe.img: GPT, one FAT32 partition at sector 2048 with the files the layout looks for. */
function fakeWinpe(dir: string): string {
  const fat = join(dir, 'fat.img');
  execFileSync('truncate', ['-s', '64M', fat]);
  execFileSync('mkfs.vfat', ['-F', '32', '-n', 'WINPE', fat]);
  const put = (path: string, data: string | Buffer) => {
    const f = join(dir, 'tmpfile');
    writeFileSync(f, data);
    execFileSync('mcopy', ['-i', fat, f, `::/${path}`], { env });
  };
  for (const d of ['EFI', 'EFI/Boot', 'sources', 'woa-drivers', 'woa-drivers/dwcsdhc', 'woa-debug']) execFileSync('mmd', ['-i', fat, `::/${d}`], { env });
  put('EFI/Boot/bootaa64.efi', Buffer.alloc(1804232, 1));
  put('sources/boot.wim', Buffer.alloc(3 << 20, 2));
  put('woa-drivers/dwcsdhc/dwcsdhc.inf', '[Version]\r\n');
  put('woa-drivers/dwcsdhc/dwcsdhc.cat', readFileSync(join(__dirname, 'fixtures', 'woa-rk3576-0.1.1-dwcsdhc.cat')));
  put('woa-debug/collect.cmd', Buffer.alloc(14566, 'r'));
  const img = join(dir, 'winpe.img');
  execFileSync('truncate', ['-s', String(66 << 20), img]);
  execFileSync('sgdisk', ['-o', '-n', `1:2048:${2048 + (64 << 11) - 1}`, '-t', '1:0700', '-c', '1:WINPE', img]);
  const fd = openSync(img, 'r+');
  writeSync(fd, readFileSync(fat), 0, 64 << 20, 1 << 20);
  closeSync(fd);
  return img;
}

describe('staged install layout', () => {
  const board = woaBoard('tspi3m')!;
  const image = { source: bytesSource(new Uint8Array(5 << 20).fill(0x5a)), name: 'install.wim' as const, sha256: 'ab'.repeat(32), index: 6, edition: 'Windows 11 Pro', build: 22631 };

  it.skipIf(!tools)('writes a disk that has the firmware, the WinPE volume with the launcher, and the image', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-'));
    const winpe = process.env.WOA_WINPE_IMG && existsSync(process.env.WOA_WINPE_IMG) ? process.env.WOA_WINPE_IMG : fakeWinpe(dir);
    const diskBytes = 62008590336;
    const plan = planStage({
      board, diskBytes, head, winpe: fileSource(winpe), image, rand, appVersion: 'test',
      setup: { skipSetup: { user: 'woa', password: 'secret', computerName: '', locale: '', keyboard: '', timeZone: '', autoLogonAlways: false }, ssh: true, sshKey: '' },
      extras: [{ path: 'openssh/sshd.exe', data: new Uint8Array(1000).fill(3) }, { path: 'openssh/install-sshd.ps1', data: new TextEncoder().encode('# x') }],
    });
    expect(plan.certificates).toContain('FE74B735711614F79FDC6A0F58348419522857F3');
    expect(plan.ini).toMatch(/skip_setup=1\r\nssh=1\r\n/);
    expect(plan.ini).not.toContain('secret');
    expect(plan.regions[plan.regions.length - 1].lba).toBe(0);
    expect(plan.windowsBytes).toBeGreaterThan(55e9);
    expect(plan.removed.map((p) => p.name)).toEqual(['data']);

    // Write the regions into a sparse file the size of the eMMC.
    const disk = join(dir, 'emmc.img');
    execFileSync('truncate', ['-s', String(diskBytes), disk]);
    const fd = openSync(disk, 'r+');
    for (const r of plan.regions) {
      for (let off = 0; off < r.source.size; off += 8 << 20) {
        const n = Math.min(8 << 20, r.source.size - off);
        writeSync(fd, r.source.read(off, n), 0, n, r.lba * 512 + off);
      }
    }
    closeSync(fd);

    const dump = execFileSync('sfdisk', ['-d', disk], { encoding: 'utf8' });
    expect(dump).toMatch(/start=\s*64, size=\s*131008, type=8DA63339-0007-60C0-C436-083AC8230908/);
    expect(dump).toMatch(/name="WOA-STAGE-BOOT"/);
    expect(dump).toMatch(/name="WOA-STAGE-DATA"/);
    expect(spawnSync('sfdisk', ['--verify', disk], { encoding: 'utf8' }).stdout).not.toMatch(/corrupt|mismatch/i);
    const t = parsePrimaryGpt(fileSource(disk).read(0, 34 * 512));
    expect(t.diskGuid).toBe(plan.diskGuid);

    const peAt = `${disk}@@${plan.bootFirst * 512}`;
    expect(execFileSync('mtype', ['-i', peAt, '::/woa-debug/collect.cmd'], { env, encoding: 'latin1' })).toBe(LAUNCHER.replace(/\n/g, '\r\n'));
    expect(spawnSync('mdir', ['-i', peAt, '::/sources'], { env, encoding: 'latin1' }).stdout).toMatch(/boot(\.|\s+)wim/i);

    // The image is in the data volume, byte for byte, where the volume says.
    const data = fileSource(disk);
    const fsck = [process.env.FSCK_EXFAT, 'fsck.exfat'].find((c) => c && has(c, ['-V']) && /exfatprogs/.test(spawnSync(c, ['-V'], { encoding: 'utf8' }).stdout + spawnSync(c, ['-V'], { encoding: 'utf8' }).stderr));
    const volBytes = plan.regions.find((r) => r.label === 'Windows image')!.source.size;
    const m = /start=\s*(\d+), size=\s*(\d+), type=[^,]+, uuid=[^,]+, name="WOA-STAGE-DATA"/.exec(dump)!;
    expect(Number(m[1])).toBe(plan.dataFirst);
    const vol = join(dir, 'data.img');
    writeFileSync(vol, data.read(plan.dataFirst * 512, volBytes));
    execFileSync('truncate', ['-s', String(Number(m[2]) * 512), vol]);
    const raw = data.read(plan.dataFirst * 512, volBytes);
    // The image's bytes are somewhere in the volume, whole.
    const at = Buffer.from(raw).indexOf(Buffer.alloc(4096, 0x5a));
    expect(at).toBeGreaterThan(0);
    expect(Buffer.compare(raw.subarray(at, at + (5 << 20)), image.source.read(0, 5 << 20))).toBe(0);
    // The browser GPU script is on the volume too, with CRLF line ends.
    expect(Buffer.from(raw).indexOf(Buffer.from(crlf(BROWSER_GPU_PS1).subarray(0, 4000)))).toBeGreaterThan(0);
    if (fsck) expect(spawnSync(fsck, ['-n', vol]).status).toBe(0);
    expect(plan.ini).toMatch(/\r\nindex=6\r\n/);
    expect(plan.ini).toContain(`disk_guid=${plan.diskGuid}`);
    execFileSync('rm', ['-rf', dir]);
  }, 120000);

  it('refuses an eMMC of the wrong size and one without the firmware partition', () => {
    const winpe = bytesSource(new Uint8Array(1 << 20));
    expect(() => planStage({ board, diskBytes: 31272730624, head, winpe, image, rand, appVersion: 't' })).toThrow(StageError);
    const noFw = head.slice();
    noFw.fill(0, 512, 1024);
    expect(() => planStage({ board, diskBytes: 62008590336, head: noFw, winpe, image, rand, appVersion: 't' })).toThrow(/whole image/);
  });

  it('stages onto an SD card or NVMe drive with a fresh table and no firmware', () => {
    if (!tools) return;
    const dir = mkdtempSync(join(tmpdir(), 'stage-sd-'));
    const plan = planStage({ board: woaBoard('rock4d')!, target: 'nvme', diskBytes: 256e9, head: new Uint8Array(34 * 512), winpe: fileSource(fakeWinpe(dir)), image, rand, appVersion: 't' });
    const t = parsePrimaryGpt(plan.regions[plan.regions.length - 1].source.read(0, 34 * 512));
    expect(t.partitions.map((p) => p.name)).toEqual(['WOA-STAGE-BOOT', 'WOA-STAGE-DATA']);
    expect(plan.ini).toMatch(/target=nvme\r\nfw_offset=none\r\nfw_size=none\r\nwindows_offset_kb=1024\r\n/);
    expect(() => planStage({ board: woaBoard('tspi3m')!, target: 'sd', diskBytes: 16e9, head: new Uint8Array(34 * 512), winpe: fileSource(fakeWinpe(dir)), image, rand, appVersion: 't' })).toThrow(/at least/);
    execFileSync('rm', ['-rf', dir]);
  }, 60000);

  it('passes a chosen layout to the install script, and refuses one that does not fit', () => {
    if (!tools) return;
    const dir = mkdtempSync(join(tmpdir(), 'stage-layout-'));
    const winpe = fileSource(fakeWinpe(dir));
    const GiB = 1024 ** 3;
    const plan = planStage({ board, diskBytes: 62008590336, head, winpe, image, rand, appVersion: 't',
      setup: { skipSetup: null, ssh: false, sshKey: '', layout: { windowsBytes: 40 * GiB, rest: 'exfat', dataLabel: 'Shared', linuxReserveBytes: 8 * GiB } } });
    // 40 GiB is less than the gap before the staging partitions: made at that size, never extended.
    expect(plan.ini).toMatch(/\r\nwindows_create_mb=40960\r\nwindows_extend_mb=none\r\ndata_fs=exfat\r\ndata_label=Shared\r\ndata_mb=\d+\r\n/);
    expect(plan.layout).toMatchObject({ windowsBytes: 40 * GiB, data: { fs: 'exfat', label: 'Shared' }, linuxReserveBytes: 8 * GiB });
    const whole = planStage({ board, diskBytes: 62008590336, head, winpe, image, rand, appVersion: 't' });
    expect(whole.ini).toMatch(/\r\nwindows_create_mb=0\r\nwindows_extend_mb=all\r\ndata_fs=none\r\n/);
    expect(() => planStage({ board, diskBytes: 62008590336, head, winpe, image, rand, appVersion: 't',
      setup: { skipSetup: null, ssh: false, sshKey: '', layout: { windowsBytes: 20 * GiB, rest: 'unallocated', dataLabel: 'x', linuxReserveBytes: 0 } } })).toThrow(/at least 32\.0 GB/);
    execFileSync('rm', ['-rf', dir]);
  }, 60000);

  it('puts Armbian at the end of the eMMC, its U-Boot in the firmware slot, and the staging space before it', () => {
    if (!tools) return;
    const dir = mkdtempSync(join(tmpdir(), 'stage-armbian-'));
    const winpe = fileSource(fakeWinpe(dir));
    const GiB = 1024 ** 3;
    const diskBytes = 62008590336;
    const parts = readArmbianImage(bytesSource(fakeArmbian()));
    const plan = planStage({ board, diskBytes, head, winpe, image, rand, appVersion: 't',
      setup: { skipSetup: null, ssh: false, sshKey: '', layout: { windowsBytes: 32 * GiB, rest: 'unallocated', dataLabel: 'Data', linuxReserveBytes: 0 } },
      armbian: { parts, partitionBytes: 24 * GiB } });
    const t = parsePrimaryGpt(plan.regions[plan.regions.length - 1].source.read(0, 34 * 512));
    expect(t.partitions.map((p) => p.name).slice(-3)).toEqual(['WOA-STAGE-BOOT', 'WOA-STAGE-DATA', 'Armbian']);
    const a = t.partitions.find((p) => p.name === 'Armbian')!;
    expect(a.type).toBe('b921b045-1df0-41c3-af44-4c6f280d3fae');
    expect(a.attributes).toBe(4n);
    expect((a.lastLba - a.firstLba + 1) * 512).toBe(24 * GiB);
    expect(a.lastLba).toBeLessThanOrEqual(Math.floor(diskBytes / 512) - 34);
    expect(resizeLeavesTableAlone(a.lastLba, Math.floor(diskBytes / 512))).toBe(true);
    expect(plan.armbian).toEqual({ firstLba: a.firstLba, bytes: 24 * GiB, guid: a.guid });
    // Staging and Windows before Armbian; nothing overlaps.
    const data = t.partitions.find((p) => p.name === 'WOA-STAGE-DATA')!;
    expect(data.lastLba).toBeLessThan(a.firstLba);
    expect(plan.ini).toContain(`\r\nlinux_offset=${a.firstLba * 512}\r\n`);
    expect(plan.layout.windowsBytes).toBe(32 * GiB);
    const root = plan.regions.find((r) => r.label === 'Armbian root file system')!;
    expect(root.lba).toBe(a.firstLba);
    expect(root.source.size).toBe(parts.root.size);
    const slot = plan.regions.find((r) => r.label.startsWith('Armbian U-Boot'))!;
    expect(slot.lba).toBe(SLOT_LBA);
    expect(slot.source.size).toBe(parts.fit.size);
    // Too small for the root file system, an SD target, and a Linux reserve as well are refused.
    expect(() => planStage({ board, diskBytes, head, winpe, image, rand, appVersion: 't', armbian: { parts, partitionBytes: 1 << 20 } })).toThrow(/smaller than/);
    expect(() => planStage({ board, diskBytes, head, winpe, image, rand, appVersion: 't',
      setup: { skipSetup: null, ssh: false, sshKey: '', layout: { windowsBytes: 32 * GiB, rest: 'unallocated', dataLabel: 'Data', linuxReserveBytes: GiB } },
      armbian: { parts, partitionBytes: 8 * GiB } })).toThrow(/cannot both/);
    // Windows bigger than what is left before Armbian.
    expect(() => planStage({ board, diskBytes, head, winpe, image, rand, appVersion: 't',
      setup: { skipSetup: null, ssh: false, sshKey: '', layout: { windowsBytes: 40 * GiB, rest: 'unallocated', dataLabel: 'Data', linuxReserveBytes: 0 } },
      armbian: { parts, partitionBytes: 24 * GiB } })).toThrow(/at most/);
    execFileSync('rm', ['-rf', dir]);
  }, 60000);

  it('refuses a target the board does not have', () => {
    const tiny = { head, winpe: bytesSource(new Uint8Array(1)), image, rand, appVersion: 't' };
    expect(() => planStage({ board: woaBoard('rock4d')!, diskBytes: 62008590336, ...tiny })).toThrow(/eMMC on the Radxa ROCK 4D\. The Radxa ROCK 4D has no eMMC/);
    expect(() => planStage({ board: woaBoard('tspi3m')!, target: 'nvme', diskBytes: 256e9, ...tiny })).toThrow(/NVMe drive on the LCKFB TaishanPi 3M/);
  });
});
