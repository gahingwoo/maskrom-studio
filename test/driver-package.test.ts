import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BOARD_EXTRA_KINDS, boardDrivers, DRIVERS_ASSET, parseManifest, REQUIRED_DRIVERS, selectPackage } from '../src/woa/driver-package';
import { WOA_BOARDS, type BoardId } from '../src/woa/boards';
import { winpeRelease, type GithubRelease } from '../src/woa/releases';
import { CONFIGURE, HOST_BUILD, INSTALL } from '../src/woa/stage-scripts';
import { trustedCerts } from '../src/woa/certs';

// The manifest woa-rk3576's tools/rk3576-drivers/assemble.py wrote from its
// drivers.tsv (real GPU, NPU and woa-rk3576 builds of 2026-11-26).
const manifestText = readFileSync(join(__dirname, 'fixtures', 'rk3576-drivers-manifest.json'), 'utf8');
const manifest = parseManifest(manifestText);
const dirs = (b: BoardId) => boardDrivers(manifest, b).map((d) => d.dir);
const enc = (s: string) => new TextEncoder().encode(s);

/** An unzipped package: the manifest, two files per driver, and SHA256SUMS.txt over them. */
function fakePackage(text = manifestText, tamper?: (files: Array<{ path: string; data: Uint8Array }>) => void) {
  const m = JSON.parse(text) as { drivers: Array<{ dir: string }> };
  const files: Array<{ path: string; data: Uint8Array }> = [{ path: 'rk3576-drivers/manifest.json', data: enc(text) }];
  for (const d of m.drivers) {
    files.push({ path: `rk3576-drivers/drivers/${d.dir}/${d.dir}.inf`, data: enc(`[Version]\r\n; ${d.dir}\r\n`) });
    files.push({ path: `rk3576-drivers/drivers/${d.dir}/${d.dir}.sys`, data: enc(`MZ ${d.dir}`) });
  }
  files.push({ path: 'rk3576-drivers/install.cmd', data: enc('@echo off\r\n') });
  const sums = files.map((f) => `${bytesToHex(sha256(f.data))}  ${f.path.slice('rk3576-drivers/'.length)}`).join('\n');
  tamper?.(files);
  files.push({ path: 'rk3576-drivers/SHA256SUMS.txt', data: enc(`${sums}\n`) });
  return files;
}

describe('the RK3576 driver package, per board', () => {
  it('gives every board its storage, network, GPU, video decoder, NPU and audio drivers', () => {
    for (const b of WOA_BOARDS) {
      const got = dirs(b.id);
      for (const d of [...REQUIRED_DRIVERS, 'dwc_eqos', 'rk3xgpio', 'rk3xi2c', 'pl330dma', 'rk3xspi', 'maliwddm', 'vdpu383', 'rknpu', 'es8323', 'csaudiork3x', 'rk3xi2sbus']) {
        expect(got, `${b.id} ${d}`).toContain(d);
      }
    }
  });

  it('puts the TaishanPi 3M touch screen and Bluetooth on the TaishanPi 3M only', () => {
    expect(dirs('tspi3m')).toEqual(expect.arrayContaining(['gt9271', 'bcm4345bt']));
    for (const b of ['cm5io', 'rock4d'] as const) {
      expect(dirs(b)).not.toContain('gt9271');
      expect(dirs(b)).not.toContain('bcm4345bt');
    }
    // CM5-IO Bluetooth is optional (untested): never installed by the app.
    expect(manifest.drivers.find((d) => d.dir === 'bcm4345bt')!.optional).toEqual(['cm5io']);
  });

  it('puts the RK806 power button on the CM5-IO and ROCK 4D, the EEPROM on the ROCK 4D', () => {
    expect(dirs('tspi3m')).not.toContain('rk806pwrkey');
    expect(dirs('cm5io')).toContain('rk806pwrkey');
    expect(dirs('rock4d')).toEqual(expect.arrayContaining(['rk806pwrkey', 'rkeeprom']));
    expect(dirs('cm5io')).not.toContain('rkeeprom');
    expect(dirs('tspi3m')).not.toContain('rkeeprom');
  });

  it('words exactly the drivers a board gets beyond the common ones', () => {
    const kind: Record<string, string> = { gt9271: 'drivers.kind.touch', bcm4345bt: 'drivers.kind.bluetooth', rk806pwrkey: 'drivers.kind.pwrkey', rkeeprom: 'drivers.kind.eeprom' };
    const common = manifest.drivers.filter((d) => WOA_BOARDS.every((b) => d.default.includes(b.id))).map((d) => d.dir);
    for (const b of WOA_BOARDS) {
      const extra = dirs(b.id).filter((d) => !common.includes(d));
      expect(extra.every((d) => kind[d]), `${b.id}: ${extra.join(',')} has no wording`).toBe(true);
      expect(extra.map((d) => kind[d]).sort()).toEqual([...BOARD_EXTRA_KINDS[b.id]].sort());
    }
  });
});

describe('taking the board\'s drivers out of the package', () => {
  it('stages the default list under rk3576-drivers/, checked against SHA256SUMS.txt', () => {
    const s = selectPackage(fakePackage(), 'cm5io');
    expect(s.version).toBe('ci-test');
    const staged = new Set(s.files.map((f) => f.path.split('/')[1]));
    expect([...staged].sort()).toEqual([...dirs('cm5io')].sort());
    expect(s.files.some((f) => f.path === 'rk3576-drivers/maliwddm/maliwddm.inf')).toBe(true);
    expect(s.files.some((f) => f.path.includes('gt9271') || f.path.includes('bcm4345bt'))).toBe(false);
    // Nothing besides the drivers goes onto the staging volume from the package.
    expect(s.files.every((f) => f.path.startsWith('rk3576-drivers/') && f.path.split('/').length === 3)).toBe(true);
  });

  it('refuses a file that does not match the package\'s SHA-256', () => {
    const files = fakePackage(manifestText, (fs) => { fs.find((f) => f.path.endsWith('maliwddm.sys'))!.data = enc('MZ changed'); });
    expect(() => selectPackage(files, 'tspi3m')).toThrow(/maliwddm\.sys.*SHA-256/);
    // A driver only the other boards get is not checked, because it is not staged.
    const other = fakePackage(manifestText, (fs) => { fs.find((f) => f.path.endsWith('rkeeprom.sys'))!.data = enc('MZ changed'); });
    expect(() => selectPackage(other, 'tspi3m')).not.toThrow();
  });

  it('refuses a package without the eMMC or SD driver, without a manifest, or with a folder name that escapes', () => {
    const m = JSON.parse(manifestText);
    const noSd = JSON.stringify({ ...m, drivers: m.drivers.filter((d: { dir: string }) => d.dir !== 'dwcmshc') });
    expect(() => selectPackage(fakePackage(noSd), 'rock4d')).toThrow(/dwcmshc/);
    expect(() => selectPackage(fakePackage().filter((f) => !f.path.endsWith('manifest.json')), 'rock4d')).toThrow(/manifest/);
    const bad = JSON.stringify({ ...m, drivers: [...m.drivers, { dir: '..', what: 'x', from: 'woa', default: ['rock4d'], optional: [], infs: [] }] });
    expect(() => parseManifest(bad)).toThrow();
    expect(() => parseManifest(JSON.stringify({ ...m, format: 2 }))).toThrow(/Update Maskrom Studio/);
  });

  it('refuses a listed driver with no .inf', () => {
    const files = fakePackage().filter((f) => !f.path.endsWith('vdpu383.inf'));
    expect(() => selectPackage(files, 'tspi3m')).toThrow(/vdpu383/);
  });
});

describe('the driver package on a woa-rk3576 release', () => {
  const rel = (names: string[], digests: Record<string, string> = {}): GithubRelease => ({
    tag_name: 'ci', assets: names.map((name) => ({ name, size: 100, browser_download_url: `https://example.invalid/${name}`, digest: digests[name] ?? null })),
  });
  const sum = 'c'.repeat(64);

  it('is found by its name and carries the SHA-256 the release gives', () => {
    expect(DRIVERS_ASSET.test('rk3576-drivers-arm64.zip')).toBe(true);
    expect(DRIVERS_ASSET.test('rk3576-drivers-arm64-0.5.0.zip')).toBe(true);
    expect(DRIVERS_ASSET.test('woa-rk3576-drivers-0.1.1.zip')).toBe(false);
    const sums = new Map([['woa-rk3576-winpe-ci-abc.img.xz', 'a'.repeat(64)], ['rk3576-drivers-arm64.zip', sum]]);
    const w = winpeRelease(rel(['woa-rk3576-winpe-ci-abc.img.xz', 'rk3576-drivers-arm64.zip']), sums);
    expect(w.drivers).toMatchObject({ file: 'rk3576-drivers-arm64.zip', sha256: sum });
    expect(w.problems).toEqual([]);
  });

  it('is left out, and said so, when the release gives no SHA-256 for it or two different ones', () => {
    const sums = new Map([['woa-rk3576-winpe-ci-abc.img.xz', 'a'.repeat(64)]]);
    const w = winpeRelease(rel(['woa-rk3576-winpe-ci-abc.img.xz', 'rk3576-drivers-arm64.zip']), sums);
    expect(w.drivers).toBeNull();
    expect(w.problems.join()).toMatch(/no SHA-256 for rk3576-drivers-arm64\.zip/);
    const both = new Map([...sums, ['rk3576-drivers-arm64.zip', sum]]);
    const x = winpeRelease(rel(['woa-rk3576-winpe-ci-abc.img.xz', 'rk3576-drivers-arm64.zip'], { 'rk3576-drivers-arm64.zip': `sha256:${'d'.repeat(64)}` }), both);
    expect(x.drivers).toBeNull();
    expect(x.problems.join()).toMatch(/disagree/);
  });

  it('is absent on 0.1.1, whose WinPE drivers are installed instead', () => {
    const sums = new Map([['woa-rk3576-winpe-0.1.1.img.xz', 'a'.repeat(64)], ['woa-rk3576-drivers-0.1.1.zip', sum]]);
    const w = winpeRelease(rel(['woa-rk3576-winpe-0.1.1.img.xz', 'woa-rk3576-drivers-0.1.1.zip']), sums);
    expect(w.drivers).toBeNull();
    expect(w.problems).toEqual([]);
  });
});

describe('the install scripts and the package', () => {
  it('add the package when it is staged, else the WinPE drivers and audio', () => {
    expect(CONFIGURE).toMatch(/if exist "%STAGE%\\rk3576-drivers\\dwcsdhc" \(\n.*\n\s+dism \/English \/Image:W:\\ \/Add-Driver \/Driver:"%STAGE%\\rk3576-drivers" \/Recurse/);
    expect(CONFIGURE).toMatch(/\) else \(\n.*\n\s+dism .*\/Driver:"%DRIVERS%"[^\n]*\n\s+if exist "%AUDIO%" dism .*\/Driver:"%AUDIO%"/);
    expect(INSTALL).toContain('set AUDIO=%PE%\\woa-audio');
    expect(HOST_BUILD).toContain('set AUDIO=%HERE%\\woa-audio');
  });

  it('trust the GPU package\'s own test certificate', () => {
    const cat = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'wddm-mali-g52-malivop.cat')));
    const woa = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'woa-rk3576-0.1.1-dwcsdhc.cat')));
    const certs = trustedCerts([woa, cat]);
    expect(certs.length).toBe(2);
  });
});
