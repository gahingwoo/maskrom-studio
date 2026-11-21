import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planStage, StageError } from '../src/woa/stage-layout';
import { parsePrimaryGpt } from '../src/woa/gpt';
import { woaBoard } from '../src/woa/boards';
import { bytesSource, type ByteSource } from '../src/woa/pieces';
import { LAUNCHER } from '../src/woa/stage-scripts';

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

  it.skipIf(!tools)('puts Armbian in its own partition at the end of the eMMC, after the staging space, and keeps the firmware', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-armbian-'));
    try {
      const diskBytes = 62008590336;
      // A stand-in root file system: 64 MiB with a recognisable first and last sector.
      const rootfs = new Uint8Array(64 << 20).fill(0x33);
      rootfs.fill(0xa1, 0, 512);
      rootfs.fill(0xa2, rootfs.length - 512);
      const esp = [
        { path: 'armbian-esp/EFI/armbian/grubaa64.efi', data: new Uint8Array(4096).fill(7) },
        { path: 'armbian-esp/EFI/armbian/grub.cfg', data: new TextEncoder().encode('search --fs-uuid x\n') },
        { path: 'armbian-esp/startup.nsh', data: new TextEncoder().encode('bcfg boot add 0 x\r\n') },
      ];
      const partitionBytes = 6 * 1024 ** 3;
      const plan = planStage({
        board, diskBytes, head, winpe: fileSource(fakeWinpe(dir)), image, rand, appVersion: 'test', extras: esp,
        linux: { source: bytesSource(rootfs), partitionBytes },
      });
      const diskSectors = Math.floor(diskBytes / 512);
      expect(plan.linux).not.toBeNull();
      expect(plan.linux!.bytes).toBe(partitionBytes);
      expect(plan.linux!.firstLba % 2048).toBe(0);
      expect(plan.linux!.firstLba + partitionBytes / 512).toBeLessThanOrEqual(diskSectors - 34);
      expect(plan.ini).toContain(`\r\narmbian=1\r\nlinux_offset=${plan.linux!.firstLba * 512}\r\n`);
      // Windows ends up with everything between the firmware and Armbian, less the ESP and MSR.
      expect(plan.windowsFinalBytes).toBe((plan.linux!.firstLba - 131072 - 276 * 2048) * 512);
      // Nothing is written into sectors 1..131071 (the table at 0..33 is the only thing below 131072).
      for (const r of plan.regions) {
        if (r.lba === 0) expect(r.source.size).toBe(34 * 512);
        else expect(r.lba).toBeGreaterThanOrEqual(131072);
      }
      const arm = plan.regions.find((r) => r.label === 'Armbian root file system')!;
      expect(arm.lba).toBe(plan.linux!.firstLba);
      expect(plan.regions[plan.regions.length - 1].lba).toBe(0);

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
      const m = /start=\s*(\d+), size=\s*(\d+), type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, uuid=([0-9A-F-]+), name="Armbian"/.exec(dump)!;
      expect(m).not.toBeNull();
      expect(Number(m[1])).toBe(plan.linux!.firstLba);
      expect(Number(m[2]) * 512).toBe(partitionBytes);
      expect(m[3].toLowerCase()).toBe(plan.linux!.guid);
      // Staging comes right before Armbian, so extending Windows over it reaches Armbian.
      const data = /start=\s*(\d+), size=\s*(\d+), type=[^,]+, uuid=[^,]+, name="WOA-STAGE-DATA"/.exec(dump)!;
      expect(Number(data[1]) + Number(data[2])).toBeLessThanOrEqual(plan.linux!.firstLba);
      expect(plan.linux!.firstLba - (Number(data[1]) + Number(data[2]))).toBeLessThan(2048);
      expect(spawnSync('sfdisk', ['--verify', disk], { encoding: 'utf8' }).stdout).not.toMatch(/corrupt|mismatch/i);
      const back = fileSource(disk);
      expect(back.read(plan.linux!.firstLba * 512, 512).every((x) => x === 0xa1)).toBe(true);
      expect(back.read(plan.linux!.firstLba * 512 + rootfs.length - 512, 512).every((x) => x === 0xa2)).toBe(true);
      // The EFI files are on the staging volume, where woa-stage.cmd copies them from.
      const raw = Buffer.from(back.read(plan.dataFirst * 512, plan.regions.find((r) => r.label === 'Windows image')!.source.size));
      expect(raw.includes(Buffer.from('bcfg boot add 0 x\r\n'))).toBe(true);
      expect(raw.includes(Buffer.from('search --fs-uuid x\n'))).toBe(true);
    } finally {
      execFileSync('rm', ['-rf', dir]);
    }
  }, 120000);

  it('refuses an Armbian partition that is too large, too small, off the eMMC or without its boot loader', () => {
    if (!tools) return;
    const dir = mkdtempSync(join(tmpdir(), 'stage-armbian-r-'));
    try {
      const winpe = fileSource(fakeWinpe(dir));
      const grub = [{ path: 'armbian-esp/EFI/armbian/grubaa64.efi', data: new Uint8Array(512).fill(1) }];
      const base = { board, diskBytes: 62008590336, head, winpe, image, rand, appVersion: 't' };
      const rootfs = bytesSource(new Uint8Array(1 << 20));
      expect(() => planStage({ ...base, extras: grub, linux: { source: rootfs, partitionBytes: 40e9 } })).toThrow(/more than half/);
      expect(() => planStage({ ...base, extras: grub, linux: { source: rootfs, partitionBytes: 1 << 19 } })).toThrow(/smaller than its root/);
      expect(() => planStage({ ...base, linux: { source: rootfs, partitionBytes: 1 << 30 } })).toThrow(/boot loader/);
      expect(() => planStage({ ...base, extras: grub })).toThrow(/no Armbian partition/);
      expect(() => planStage({ ...base, extras: [{ path: 'armbian-esp/../x', data: new Uint8Array(1) }], linux: { source: rootfs, partitionBytes: 1 << 30 } })).toThrow(/cannot go/);
      expect(() => planStage({ ...base, board: woaBoard('rock4d')!, target: 'nvme', diskBytes: 256e9, head: new Uint8Array(34 * 512), extras: grub, linux: { source: rootfs, partitionBytes: 1 << 30 } })).toThrow(/eMMC only/);
    } finally {
      execFileSync('rm', ['-rf', dir]);
    }
  }, 60000);

  it('refuses the ROCK 4D', () => {
    expect(() => planStage({ board: woaBoard('rock4d')!, diskBytes: 62008590336, head, winpe: bytesSource(new Uint8Array(1)), image, rand, appVersion: 't' })).toThrow(/NVMe/);
  });
});
