// The checks a Windows image goes through before anything is written:
// architecture and build from the WIM/ESD XML, and an ISO's EFI boot files.
// The images here are made up in the test: a WIM header, its XML resource,
// nothing else, which is all the checks read.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesSource } from '../src/woa/pieces';
import { bootFilesFrom, bootFilesProblem, checkEdition, installable, readWimInfo, releaseName } from '../src/woa/wim';
import { inspectWindowsImage } from '../src/main/windows-image';
import { WINDOWS_SOURCES, isWindowsSourceUrl } from '../src/shared/windows-sources';
import { MESSAGES } from '../src/renderer/messages';

const fx = (n: string) => join(__dirname, 'fixtures', n);

interface Ed { name: string; arch: number; build: number; sp?: number; type?: string; langs?: string[] }

function imageXml(eds: Ed[]): string {
  const body = eds.map((e, i) => `<IMAGE INDEX="${i + 1}"><TOTALBYTES>${16e9}</TOTALBYTES><WINDOWS><ARCH>${e.arch}</ARCH>`
    + `<EDITIONID>${e.name.replace(/\W/g, '')}</EDITIONID><INSTALLATIONTYPE>${e.type ?? 'Client'}</INSTALLATIONTYPE>`
    + `<LANGUAGES>${(e.langs ?? ['en-US']).map((l) => `<LANGUAGE>${l}</LANGUAGE>`).join('')}<DEFAULT>${(e.langs ?? ['en-US'])[0]}</DEFAULT></LANGUAGES>`
    + `<VERSION><MAJOR>10</MAJOR><MINOR>0</MINOR><BUILD>${e.build}</BUILD><SPBUILD>${e.sp ?? 0}</SPBUILD></VERSION></WINDOWS>`
    + `<NAME>${e.name}</NAME><DISPLAYNAME>${e.name}</DISPLAYNAME></IMAGE>`).join('');
  return `<WIM><TOTALBYTES>0</TOTALBYTES>${body}</WIM>`;
}

/** A WIM (or, with esd, a solid ESD) header followed by its UTF-16LE XML, as Windows writes it. */
function synthWim(eds: Ed[], esd = false): Uint8Array {
  const xml = imageXml(eds);
  const xmlBytes = new Uint8Array(2 + xml.length * 2);
  xmlBytes[0] = 0xff; xmlBytes[1] = 0xfe;
  for (let i = 0; i < xml.length; i++) { xmlBytes[2 + 2 * i] = xml.charCodeAt(i) & 0xff; xmlBytes[3 + 2 * i] = xml.charCodeAt(i) >> 8; }
  const out = new Uint8Array(208 + 4096 + xmlBytes.length);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('MSWIM\0\0\0'), 0);
  dv.setUint32(8, 208, true);
  dv.setUint32(12, esd ? 0x00000e00 : 0x00010d00, true);
  dv.setUint16(40, 1, true);
  dv.setUint16(42, 1, true);
  dv.setUint32(44, eds.length, true);
  const at = 208 + 4096;
  dv.setUint32(72, xmlBytes.length, true);
  out[79] = 0x02; // metadata, not compressed
  dv.setUint32(80, at, true);
  dv.setUint32(88, xmlBytes.length, true);
  out.set(xmlBytes, at);
  return out;
}

describe('which editions may be installed', () => {
  const arm = (build: number) => checkEdition({ arch: 12, build });
  it('takes 22H2 and 23H2 on ARM64 without a word', () => {
    expect(arm(22621).level).toBe('ok');
    expect(arm(22631).level).toBe('ok');
  });
  it('refuses 24H2, 25H2 and later: they need ARMv8.1', () => {
    for (const b of [26000, 26100, 26200, 27000]) expect(arm(b)).toMatchObject({ level: 'refuse', code: 'new' });
    expect(arm(25999).level).not.toBe('refuse');
  });
  it('allows Windows 11 21H2 and Windows 10 1809 to 22H2 with a notice', () => {
    expect(arm(22000)).toMatchObject({ level: 'notice', code: 'untested', vars: { release: 'Windows 11 21H2' } });
    expect(arm(17763)).toMatchObject({ level: 'notice', code: 'untested', vars: { release: 'Windows 10 1809' } });
    expect(arm(19045)).toMatchObject({ level: 'notice', code: 'untested', vars: { release: 'Windows 10 22H2' } });
    expect(arm(22000).text).not.toMatch(/froze|freeze/);
  });
  it('refuses anything older than 1809', () => {
    expect(arm(17134)).toMatchObject({ level: 'refuse', code: 'tooold' });
    expect(checkEdition({ arch: 12, build: 18000, major: 6 })).toMatchObject({ level: 'refuse', code: 'tooold' });
  });
  it('warns about preview builds', () => {
    expect(arm(22635)).toMatchObject({ level: 'warn', code: 'preview' });
    expect(arm(25398)).toMatchObject({ level: 'warn', code: 'preview' });
    expect(arm(20348)).toMatchObject({ level: 'warn', code: 'preview' });
  });
  it('refuses x64, x86, 32-bit ARM and an image without ARCH or BUILD', () => {
    expect(checkEdition({ arch: 9, build: 22631 })).toMatchObject({ level: 'refuse', code: 'arch', vars: { arch: 'x64' } });
    expect(checkEdition({ arch: 0, build: 22631 })).toMatchObject({ level: 'refuse', code: 'arch', vars: { arch: 'x86' } });
    expect(checkEdition({ arch: 5, build: 22631 }).level).toBe('refuse');
    expect(checkEdition({ arch: null, build: 22631 }).level).toBe('refuse');
    expect(checkEdition({ arch: 12, build: null })).toMatchObject({ level: 'refuse', code: 'nobuild' });
  });
  it('names the releases', () => {
    expect(releaseName(22631)).toBe('Windows 11 23H2');
    expect(releaseName(26200)).toBe('Windows 11 25H2');
    expect(releaseName(28000)).toMatch(/24H2 or later/);
    expect(releaseName(19045)).toBe('Windows 10 22H2');
    expect(releaseName(22635)).toBeNull();
  });
  it('has the page text for every check in both languages, without dashes', () => {
    for (const code of ['arch', 'nobuild', 'new', 'tooold', 'untested', 'preview']) {
      const m = MESSAGES[`win.check.${code}`];
      expect(m?.en, code).toBeTruthy();
      expect(m?.['zh-CN'], code).toBeTruthy();
    }
    for (const k of ['arm64', 'x64', 'x86', 'none']) expect(MESSAGES[`win.found.boot.${k}`]?.en).toBeTruthy();
  });
});

describe('the WIM and ESD XML', () => {
  it('reads architecture, build and languages from a WIM', () => {
    const info = readWimInfo(bytesSource(synthWim([
      { name: 'Windows 11 Pro', arch: 12, build: 22631, sp: 2861, langs: ['zh-CN', 'en-US'] },
      { name: 'Windows 11 Home', arch: 12, build: 22631, sp: 2861 },
    ])));
    expect(info.kind).toBe('wim');
    expect(installable(info).map((e) => [e.name, e.arch, e.build, e.spBuild, e.languages])).toEqual([
      ['Windows 11 Pro', 12, 22631, 2861, ['zh-CN', 'en-US']],
      ['Windows 11 Home', 12, 22631, 2861, ['en-US']],
    ]);
  });
  it('reads the XML of a solid ESD and leaves out its setup and WinPE images', () => {
    const info = readWimInfo(bytesSource(synthWim([
      { name: 'Windows Setup Media', arch: 12, build: 22621, type: 'WindowsPE' },
      { name: 'Microsoft Windows PE (ARM64)', arch: 12, build: 22621, type: 'WindowsPE' },
      { name: 'Windows 11 Pro', arch: 12, build: 22621 },
    ], true)));
    expect(info).toMatchObject({ kind: 'esd', solid: true });
    expect(installable(info).map((e) => e.name)).toEqual(['Windows 11 Pro']);
  });
});

describe('an ISO\'s EFI boot files', () => {
  it('tells an ARM64 ISO from a PC one', () => {
    expect(bootFilesFrom(['BOOTAA64.EFI'])).toEqual({ arm64: true, x64: false, x86: false });
    expect(bootFilesFrom(['bootx64.efi', 'bootia32.efi'])).toEqual({ arm64: false, x64: true, x86: true });
    expect(bootFilesProblem(bootFilesFrom(['bootx64.efi']), [{ arch: 9 }])).toMatch(/x64 Windows ISO/);
    expect(bootFilesProblem(bootFilesFrom(['bootaa64.efi']), [{ arch: 9 }])).toMatch(/no ARM64 edition/);
    expect(bootFilesProblem(bootFilesFrom(['bootaa64.efi']), [{ arch: 12 }])).toBeNull();
    expect(bootFilesProblem(null, [{ arch: 12 }])).toBeNull();
  });
});

describe('inspectWindowsImage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vet-'));
  const iso = new Uint8Array(execFileSync('xz', ['-dc', fx('udf-small.iso.xz')], { maxBuffer: 64 << 20 }));

  it('shows what an ARM64 ISO holds and why its 24H2 edition is refused', () => {
    const p = join(dir, 'arm.iso');
    writeFileSync(p, iso);
    const w = inspectWindowsImage(p);
    expect(w.boot).toEqual({ arm64: true, x64: false, x86: false });
    expect(w.refuse).toBeNull();
    expect(w.editions.map((e) => [e.name, e.archName, e.release, e.check.level])).toEqual([
      ['Windows 11 Pro', 'ARM64', 'Windows 11 23H2', 'ok'],
      ['Windows 11 Home', 'ARM64', 'Windows 11 24H2', 'refuse'],
    ]);
  });

  it('refuses an ISO that starts PCs, whatever its image says', () => {
    // The fixture with efi\boot\bootaa64.efi renamed to bootx64.efi in its
    // UDF directory: one name byte shorter, the entry keeps its padded size.
    const x = iso.slice();
    const name = new TextEncoder().encode('bootaa64.efi');
    let at = -1;
    for (let i = 0; i + name.length <= x.length; i++) {
      if (x[i - 1] === 8 && name.every((c, j) => x[i + j] === c)) { at = i; break; }
    }
    expect(at).toBeGreaterThan(0);
    expect(x[at - 20]).toBe(13);
    x[at - 20] = 12;
    x.set(new TextEncoder().encode('bootx64.efi\0'), at);
    const p = join(dir, 'x64.iso');
    writeFileSync(p, x);
    const w = inspectWindowsImage(p);
    expect(w.boot).toEqual({ arm64: false, x64: true, x86: false });
    expect(w.refuse).toMatch(/x64 Windows ISO/);
    expect(w.editions.every((e) => e.refuse === w.refuse)).toBe(true);
  });

  it('sorts an image with 17763, 19045, 22000, 22631, 26100 and x64 editions', () => {
    const p = join(dir, 'mixed.wim');
    writeFileSync(p, synthWim([
      { name: 'Windows 10 Pro', arch: 12, build: 17763 },
      { name: 'Windows 10 Pro', arch: 12, build: 19045 },
      { name: 'Windows 11 Pro', arch: 12, build: 22000 },
      { name: 'Windows 11 Pro', arch: 12, build: 22631 },
      { name: 'Windows 11 Pro', arch: 12, build: 26100 },
      { name: 'Windows 11 Pro', arch: 9, build: 22631 },
    ]));
    const w = inspectWindowsImage(p);
    expect(w).toMatchObject({ container: 'wim', boot: null, refuse: null });
    expect(w.editions.map((e) => [e.build, e.archName, e.release, e.check.level, e.refuse === null])).toEqual([
      [17763, 'ARM64', 'Windows 10 1809', 'notice', true],
      [19045, 'ARM64', 'Windows 10 22H2', 'notice', true],
      [22000, 'ARM64', 'Windows 11 21H2', 'notice', true],
      [22631, 'ARM64', 'Windows 11 23H2', 'ok', true],
      [26100, 'ARM64', 'Windows 11 24H2', 'refuse', false],
      [22631, 'x64', 'Windows 11 23H2', 'refuse', false],
    ]);
    expect(w.editions[0].warn).toMatch(/not tested on these boards with the current drivers/);
    expect(w.editions[3].warn).toBeNull();
    expect(w.editions[4].refuse).toMatch(/ARMv8\.1/);
    expect(w.editions[5].refuse).toMatch(/x64, not ARM64/);
  });

  it('reads an .esd by its contents', () => {
    const p = join(dir, 'install.esd');
    writeFileSync(p, synthWim([{ name: 'Windows 11 Pro', arch: 12, build: 26100 }], true));
    const w = inspectWindowsImage(p);
    expect(w).toMatchObject({ container: 'esd', imageName: 'install.esd' });
    expect(w.editions[0].check).toMatchObject({ level: 'refuse', code: 'new', vars: { build: '26100' } });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('where to get Windows', () => {
  it('lists the sources, NTriver first, then UUP dump, with both languages', () => {
    expect(WINDOWS_SOURCES.map((s) => s.id).slice(0, 2)).toEqual(['ntriver', 'uupdump']);
    for (const s of WINDOWS_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const l of ['en', 'zh-CN'] as const) {
        expect(s.title[l]).toBeTruthy();
        expect(s.text[l]).toBeTruthy();
        expect(`${s.title[l]}${s.text[l]}`).not.toMatch(/[\u2013\u2014]/);
      }
      expect(isWindowsSourceUrl(s.url)).toBe(true);
    }
    // Only the listed pages open: no direct image downloads, no other pages of those sites.
    expect(isWindowsSourceUrl('https://uupdump.net/get.php?id=x')).toBe(false);
    expect(readFileSync(join(__dirname, '..', 'src', 'shared', 'windows-sources.json'), 'utf8')).not.toMatch(/\.iso"/i);
  });
});
