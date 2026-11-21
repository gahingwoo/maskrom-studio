import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardFromIds, firmwareTargets, WOA_BOARDS, woaBoard } from '../src/woa/boards';
import { firmwareRegions } from '../src/woa/firmware-plan';
import { firmwareRelease, parseSums, winpeRelease } from '../src/woa/releases';
import { bytesSource } from '../src/woa/pieces';
import { INSTALL, LAUNCHER, crlf } from '../src/woa/stage-scripts';
import { inspectWindowsImage } from '../src/main/windows-image';
import { boardHere } from '../src/main/board-here';

const fx = (n: string) => join(__dirname, 'fixtures', n);
const head = new Uint8Array(readFileSync(fx('tspi3m-emmc-head.bin')));

describe('boards (edk2-webflash data)', () => {
  it('keeps edk2-webflash\'s firmware sectors', () => {
    const t = woaBoard('tspi3m')!;
    expect(firmwareTargets(t).map((x) => [x.id, x.lba, x.slice ?? null])).toEqual([
      ['uefi', 0, null], ['uefi-keep', 16384, [16384 * 512, (16384 + 27264) * 512]],
    ]);
    expect(firmwareTargets(woaBoard('cm5io')!).find((x) => x.id === 'uefi-keep')!.lba).toBe(64);
    expect(firmwareTargets(woaBoard('rock4d')!).map((x) => x.id)).toEqual(['uefi']);
    expect(WOA_BOARDS.filter((b) => b.windows).map((b) => b.id)).toEqual(['tspi3m', 'cm5io']);
  });

  it('recognises a board by device tree or SMBIOS', () => {
    expect(boardFromIds(['armsom,cm5-io', 'armsom,cm5', 'rockchip,rk3576'], null)!.id).toBe('cm5io');
    expect(boardFromIds(['rockchip,rk3576'], 'TaishanPi 3M')!.id).toBe('tspi3m');
    expect(boardFromIds(['radxa,rock-5b', 'rockchip,rk3588'], null)).toBeNull();
  });
});

describe('firmware writes', () => {
  const image = bytesSource(new Uint8Array(32 << 20).fill(1));
  it('cuts "keep the partitions" as edk2-webflash does', () => {
    const b = woaBoard('tspi3m')!;
    const keep = firmwareTargets(b).find((t) => t.id === 'uefi-keep')!;
    const r = firmwareRegions(b, keep, image, { capacity: 62008590336, head });
    if ('stop' in r) throw new Error(r.stop);
    expect(r.regions[0].lba).toBe(16384);
    expect(r.regions[0].source.size).toBe(27264 * 512);
  });
  it('refuses "keep the partitions" on an eMMC without the edk2-rk3576 layout', () => {
    const b = woaBoard('cm5io')!;
    const keep = firmwareTargets(b).find((t) => t.id === 'uefi-keep')!;
    expect(firmwareRegions(b, keep, image, { capacity: 31272730624, head: new Uint8Array(34 * 512) })).toMatchObject({ stop: expect.stringMatching(/whole image/) });
  });
  it('says which partitions the whole image drops', () => {
    const b = woaBoard('tspi3m')!;
    const whole = firmwareTargets(b).find((t) => t.id === 'uefi')!;
    const r = firmwareRegions(b, whole, image, { capacity: 62008590336, head });
    if ('stop' in r) throw new Error(r.stop);
    expect(r.summary.dropped.map((d) => d.name)).toEqual(['data']);
  });
  it('refuses an image larger than the ROCK 4D SPI NOR', () => {
    const b = woaBoard('rock4d')!;
    expect(firmwareRegions(b, firmwareTargets(b)[0], bytesSource(new Uint8Array(17 << 20)), { capacity: null, head: null })).toHaveProperty('stop');
  });
});

describe('releases', () => {
  const sums = parseSums('0f67ee93bc3470e6943e90624945a2af152d1fcfb13709eb1338c4854a13a716  woa-rk3576-winpe-0.1.1.img.xz\n');
  it('takes the WinPE image with its SHA-256', () => {
    const r = winpeRelease({ tag_name: '0.1.1', assets: [{ name: 'woa-rk3576-winpe-0.1.1.img.xz', size: 352252908, browser_download_url: 'https://x/w.img.xz' }] }, sums);
    expect(r.image).toMatchObject({ size: 352252908, sha256: '0f67ee93bc3470e6943e90624945a2af152d1fcfb13709eb1338c4854a13a716' });
  });
  it('refuses a file whose SHA-256 the release and GitHub disagree on', () => {
    const r = winpeRelease({ tag_name: '0.1.1', assets: [{ name: 'woa-rk3576-winpe-0.1.1.img.xz', size: 1, browser_download_url: 'u', digest: `sha256:${'0'.repeat(64)}` }] }, sums);
    expect(r.image).toBeNull();
    expect(r.problems[0]).toMatch(/disagree/);
  });
  it('finds each board\'s firmware image', () => {
    const names = ['CM5IO-emmc-edk2-0.4.1.img', 'TaishanPi3M-emmc-edk2-0.4.1.img', 'ROCK4D-spi-edk2-0.4.1.img', 'CM5IO-sdcard-edk2-0.4.1.img'];
    const s = new Map(names.map((n) => [n, 'a'.repeat(64)]));
    const r = firmwareRelease({ tag_name: '0.4.1', assets: names.map((n) => ({ name: n, size: 1, browser_download_url: n })) }, s);
    expect(Object.keys(r.images).sort()).toEqual(['cm5io', 'rock4d', 'tspi3m']);
    expect(r.images.cm5io!.file).toBe('CM5IO-emmc-edk2-0.4.1.img');
  });
});

describe('the Windows image', () => {
  it('reads install.wim inside an ISO, and a .wim file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-'));
    const iso = join(dir, 'w.iso');
    writeFileSync(iso, execFileSync('xz', ['-dc', fx('udf-small.iso.xz')]));
    const a = inspectWindowsImage(iso);
    expect(a).toMatchObject({ container: 'iso', imageName: 'install.wim', imageSize: 4220 });
    expect(a.editions.map((e) => [e.index, e.refuse === null])).toEqual([[1, true], [2, false]]);
    const b = inspectWindowsImage(fx('two-editions.wim'));
    expect(b).toMatchObject({ container: 'wim', extents: null });
    expect(() => inspectWindowsImage(fx('tspi3m-emmc-head.bin'))).toThrow();
  });
});

describe('the board this runs on', () => {
  it('finds the eMMC and SPI NOR of a pretend TaishanPi 3M', async () => {
    const root = mkdtempSync(join(tmpdir(), 'root-'));
    const w = (p: string, v: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), v); };
    w('proc/device-tree/compatible', 'lckfb,tspi-3m-rk3576\0rockchip,rk3576\0');
    w('sys/block/mmcblk0/device/type', 'SD\n');
    w('sys/block/mmcblk0/size', '124735488\n');
    w('sys/block/mmcblk1/device/type', 'MMC\n');
    w('sys/block/mmcblk1/device/name', 'A3A561\n');
    w('sys/block/mmcblk1/size', '121110528\n');
    w('sys/class/mtd/mtd0/type', 'nor\n');
    w('sys/class/mtd/mtd0/name', 'sfc\n');
    w('sys/class/mtd/mtd0/size', '16777216\n');
    const h = await boardHere(root);
    expect(h.board!.id).toBe('tspi3m');
    expect(h.emmc).toMatchObject({ device: '/dev/mmcblk1', bytes: 62008590336, model: 'A3A561' });
    expect(h.mtd).toEqual([{ device: '/dev/mtd0', name: 'sfc', bytes: 16777216 }]);
  });
});

describe('the scripts the board runs', () => {
  for (const [name, s] of [['launcher', LAUNCHER], ['install', INSTALL]] as const) {
    it(`${name}: ASCII, CRLF, nothing WinPE lacks`, () => {
      const b = crlf(s);
      expect(b.every((x) => x === 9 || x === 10 || x === 13 || (x >= 32 && x < 127))).toBe(true);
      const t = new TextDecoder().decode(b);
      expect(t.split('\r\n').every((l) => !l.includes('\n') && l.length < 2000)).toBe(true);
      expect(t).not.toMatch(/findstr|powershell|\u2013|\u2014/i);
    });
  }
  it('install: refuses 24H2, keeps the firmware, removes the staging volumes, extends Windows', () => {
    expect(INSTALL).toMatch(/GTR 25999/);
    expect(INSTALL).toMatch(/call :checkfw/);
    expect(INSTALL).toMatch(/delete volume override[\s\S]*extend/);
    expect(INSTALL).toMatch(/\/Compact \/Verify/);
  });
});
