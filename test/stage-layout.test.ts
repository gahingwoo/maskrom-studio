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

  it('refuses the ROCK 4D', () => {
    expect(() => planStage({ board: woaBoard('rock4d')!, diskBytes: 62008590336, head, winpe: bytesSource(new Uint8Array(1)), image, rand, appVersion: 't' })).toThrow(/NVMe/);
  });
});
