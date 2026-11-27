import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVhd } from '../src/woa/vhd';
import { planHostImage } from '../src/woa/host-image';
import { buildGpt, parsePrimaryGpt, randomGuid, TYPE_BASIC_DATA, TYPE_ESP } from '../src/woa/gpt';
import { bytesSource, concatSource } from '../src/woa/pieces';
import { woaBoard } from '../src/woa/boards';
import { HOST_BUILD, INSTALL, CONFIGURE } from '../src/woa/stage-scripts';

const head = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'tspi3m-emmc-head.bin')));
const rand = (() => { let x = 7; return (n: number) => Uint8Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) >>> 0; return x >>> 24; }); })();

/** A dynamic VHD (Microsoft's VHD specification) holding `blocks` (block number -> 2 MiB of data) of a disk of `diskBytes`. */
function makeVhd(diskBytes: number, blocks: Map<number, Uint8Array>): Uint8Array {
  const bb = 2 << 20;
  const entries = Math.ceil(diskBytes / bb);
  const footer = new Uint8Array(512);
  const fdv = new DataView(footer.buffer);
  footer.set(new TextEncoder().encode('conectix'), 0);
  fdv.setUint32(8, 2); fdv.setUint32(12, 0x00010000);
  fdv.setBigUint64(16, 512n);
  fdv.setBigUint64(40, BigInt(diskBytes)); fdv.setBigUint64(48, BigInt(diskBytes));
  fdv.setUint32(60, 3);
  const hdr = new Uint8Array(1024);
  const hdv = new DataView(hdr.buffer);
  hdr.set(new TextEncoder().encode('cxsparse'), 0);
  hdv.setBigUint64(8, 0xffffffffffffffffn);
  const batOff = 512 + 1024;
  hdv.setBigUint64(16, BigInt(batOff));
  hdv.setUint32(24, 0x00010000); hdv.setUint32(28, entries); hdv.setUint32(32, bb);
  const batBytes = Math.ceil((entries * 4) / 512) * 512;
  const bat = new Uint8Array(batBytes).fill(0xff);
  const bdv = new DataView(bat.buffer);
  const parts: Uint8Array[] = [];
  let at = batOff + batBytes;
  for (const [blk, data] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    bdv.setUint32(blk * 4, at / 512);
    const bitmap = new Uint8Array(512).fill(0xff);
    parts.push(bitmap, data);
    at += 512 + bb;
  }
  const out = new Uint8Array(at + 512);
  out.set(footer, 0); out.set(hdr, 512); out.set(bat, batOff);
  let o = batOff + batBytes;
  for (const p of parts) { out.set(p, o); o += p.length; }
  out.set(footer, at);
  return out;
}

describe('the Windows host build for the eMMC', () => {
  const diskBytes = 62008590336 - (1 << 20) * 3;
  const sectors = Math.floor(diskBytes / 512);
  const gpt = buildGpt({
    diskSectors: sectors, diskGuid: randomGuid(rand), keep: null,
    parts: [
      { type: TYPE_ESP, guid: randomGuid(rand), firstLba: 131072, lastLba: 131072 + 532479, name: 'EFI system partition' },
      { type: TYPE_BASIC_DATA, guid: randomGuid(rand), firstLba: 131072 + 532480 + 32768, lastLba: sectors - 2048, name: 'Basic data partition' },
    ],
  });
  const block0 = new Uint8Array(2 << 20); block0.set(gpt.primary, 0);
  const vhd = makeVhd(diskBytes, new Map([[0, block0], [32, new Uint8Array(2 << 20).fill(0xe5)], [33, new Uint8Array(2 << 20).fill(0x33)], [900, new Uint8Array(2 << 20).fill(0x77)]]));

  it('reads the VHD: its GPT, the blocks with data, zeros elsewhere', () => {
    const v = readVhd(bytesSource(vhd));
    expect(v.kind).toBe('dynamic');
    expect(v.diskBytes).toBe(diskBytes);
    expect(parsePrimaryGpt(v.disk.read(0, 34 * 512)).partitions.length).toBe(2);
    expect(v.allocated(32)).toBe(true);
    expect(v.allocated(31)).toBe(false);
    expect(v.disk.read(31 * (2 << 20), 4).every((b) => b === 0)).toBe(true);
    expect(v.disk.read(900 * (2 << 20) + 5, 3).every((b) => b === 0x77)).toBe(true);
  });

  it('writes the VHD partitions behind the eMMC firmware partition, keeping it', () => {
    const v = readVhd(bytesSource(vhd));
    const plan = planHostImage({ board: woaBoard('tspi3m')!, capacity: 62008590336, head, vhd: v });
    const data = plan.regions.filter((r) => r.label === 'Windows');
    expect(data.map((r) => [r.lba, r.source.size])).toEqual([[32 * 4096, 2 * (2 << 20)], [900 * 4096, 2 << 20]]);
    const t = parsePrimaryGpt(plan.regions[plan.regions.length - 1].source.read(0, 34 * 512));
    expect(t.partitions.map((p) => [p.name, p.firstLba])).toEqual([['firmware', 64], ['EFI system partition', 131072], ['Basic data partition', 131072 + 532480 + 32768]]);
    expect(plan.removed.map((p) => p.name)).toEqual(['data']);
    expect(concatSource([{ kind: 'range', source: data[0].source, offset: 0, length: 8 }]).read(0, 8).every((b) => b === 0xe5)).toBe(true);
  });

  it('refuses a VHD larger than the eMMC', () => {
    expect(() => planHostImage({ board: woaBoard('tspi3m')!, capacity: 31272730624, head, vhd: readVhd(bytesSource(vhd)) })).toThrow(/larger/);
  });
});

describe('the scripts', () => {
  it('share the configure steps between the board and the PC', () => {
    expect(INSTALL).toContain(CONFIGURE);
    expect(HOST_BUILD).toContain(CONFIGURE);
    expect(HOST_BUILD).toMatch(/create vdisk file="%W_vhd_path%" maximum=%W_vhd_mb% type=expandable/);
    expect(HOST_BUILD).toMatch(/create partition efi size=260 offset=65536/);
    expect(HOST_BUILD).toMatch(/Mount-DiskImage/);
    expect(CONFIGURE).toMatch(/dwcmshc \/v Start \/t REG_DWORD \/d 0/);
  });
  // Seen on a ROCK 4D (no eMMC) installing to NVMe, 2026-11-26: the screen said eMMC three times.
  it('name the disk Windows goes onto, and say eMMC only when it is the eMMC', () => {
    const lines = `${INSTALL}\n${HOST_BUILD}`.split('\n');
    const said = lines.filter((l) => /^\s*(if [^e]*)?echo\b.*eMMC/i.test(l) || /^\s*if .*echo\b.*eMMC/.test(l));
    const unguarded = said.filter((l) => !/"%W_target%"=="emmc"/.test(l)
      // Inside blocks that run only on the eMMC: the firmware partition found, Armbian next to Windows on the eMMC, the VHD for the eMMC.
      && !/Firmware partition found at sector 64|virtual disk the size of the eMMC/.test(l));
    expect(unguarded).toEqual([]);
    expect(INSTALL).toContain('onto %TGT%.');
    // Armbian beside Windows: on the eMMC (TaishanPi 3M) or the NVMe drive (CM5-IO), said as such.
    expect(INSTALL).toMatch(/set "AWHERE=the eMMC"\nif \/i "%W_target%"=="nvme" set "AWHERE=the NVMe drive"\n/);
    expect(INSTALL).toContain('echo Armbian is on %AWHERE% too.');
    expect(INSTALL).toMatch(/set "TGT=this board's eMMC"\nif \/i "%W_target%"=="sd" set "TGT=the SD card"\nif \/i "%W_target%"=="nvme" set "TGT=the NVMe drive"\n/);
    // TGT is set before anything can jump to :fail, which names it.
    expect(INSTALL.indexOf('set "TGT=')).toBeLessThan(INSTALL.indexOf('goto :fail'));
    expect(INSTALL).toContain('The staging partitions are still on %TGT%');
    for (const target of ['emmc', 'sd', 'nvme']) {
      expect(CONFIGURE).toMatch(new RegExp(`if /i "%W_target%"=="${target}" [^\\n]*echo Applying the image`));
      expect(CONFIGURE).toMatch(new RegExp(`if /i "%W_target%"=="${target}" echo [^\n]*sdbus off`));
    }
    // The registry is changed the same way for every target.
    expect(CONFIGURE).toMatch(/\nreg add HKLM\\WOASYS\\ControlSet00!CS!\\Services\\sdstor \/v Start \/t REG_DWORD \/d 0 \/f/);
    expect(CONFIGURE).toMatch(/\nreg add HKLM\\WOASYS\\ControlSet00!CS!\\Services\\sdbus \/v Start \/t REG_DWORD \/d 4 \/f/);
    expect(INSTALL).toMatch(/if "%W_armbian_sd%"=="1" \(\n\s+echo\.\n\s+echo Armbian is on the SD card/);
  });
});
