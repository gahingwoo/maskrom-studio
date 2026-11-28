// Which Windows releases the app installs, what each lacks on these boards,
// and how that decides the targets, the notes, the driver list and the
// staging files (shared/windows-version.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { familyOfBuild, NEWEST_BUILD, OLDEST_BUILD, targetProblem, versionIni, versionLabel, versionNotes, WINDOWS_VERSIONS, windowsVersion } from '../src/shared/windows-version';
import { checkEdition } from '../src/woa/wim';
import { boardDrivers, parseManifest } from '../src/woa/driver-package';
import { WOA_BOARDS, woaBoard } from '../src/woa/boards';
import { MESSAGES } from '../src/renderer/messages';
import { WINDOWS_SOURCES } from '../src/shared/windows-sources';

const v = (b: number) => windowsVersion(b)!;

describe('the Windows releases', () => {
  it('are Windows 10 2004 to 22H2 and Windows 11 21H2, 22H2, 23H2, by their real names', () => {
    expect(WINDOWS_VERSIONS.map(versionLabel)).toEqual([
      'Windows 10 2004 (19041)', 'Windows 10 20H2 (19042)', 'Windows 10 21H1 (19043)', 'Windows 10 21H2 (19044)', 'Windows 10 22H2 (19045)',
      'Windows 11 21H2 (22000)', 'Windows 11 22H2 (22621)', 'Windows 11 23H2 (22631)',
    ]);
    expect([OLDEST_BUILD, NEWEST_BUILD]).toEqual([19041, 22631]);
    for (const b of [17763, 19046, 20348, 22632, 26100]) expect(windowsVersion(b), String(b)).toBeNull();
  });
  it('agree with the image check: every release is ok, nothing else is', () => {
    for (let b = 17000; b <= 27000; b++) expect(checkEdition({ arch: 12, build: b }).level === 'ok', String(b)).toBe(windowsVersion(b) !== null);
  });
  it('say which KMDF and WiFiCx each has', () => {
    for (const x of WINDOWS_VERSIONS) {
      expect(x.kmdf, x.name).toBe(x.build < 22000 ? '1.31' : '1.33');
      expect(x.wificx, x.name).toBe(x.build < 22000 ? null : '1.0');
      expect(x.family).toBe(familyOfBuild(x.build));
    }
    expect(v(22000).tested).toBe('less');
    expect(WINDOWS_VERSIONS.filter((x) => x.tested === 'less').map((x) => x.build)).toEqual([22000]);
  });
});

describe('where each release can go', () => {
  it('keeps Windows 10 off NVMe drives until its NVMe driver is out, and nothing else', () => {
    for (const b of WOA_BOARDS) {
      for (const tg of b.windowsTargets) {
        for (const x of WINDOWS_VERSIONS) {
          expect(targetProblem(x, tg), `${b.id} ${tg} ${x.build}`).toBe(x.family === 'win10' && tg === 'nvme' ? 'ver.nvme.blocked' : null);
        }
      }
    }
    expect(targetProblem(null, 'nvme')).toBeNull();
  });
  it('leaves the ROCK 4D only an SD card for Windows 10, and the CM5-IO its eMMC and SD card', () => {
    const left = (id: string) => woaBoard(id)!.windowsTargets.filter((tg) => !targetProblem(v(19045), tg));
    expect(left('rock4d')).toEqual(['sd']);
    expect(left('cm5io')).toEqual(['emmc', 'sd']);
    expect(left('tspi3m')).toEqual(['emmc', 'sd']);
  });
  it('notes NVMe only where the board takes NVMe, Wi-Fi on every Windows 10, and 21H2 as run less', () => {
    expect(versionNotes(v(19045), woaBoard('rock4d')!.windowsTargets)).toEqual(['ver.note.nvme', 'ver.note.wifi']);
    expect(versionNotes(v(19041), woaBoard('cm5io')!.windowsTargets)).toEqual(['ver.note.nvme', 'ver.note.wifi']);
    expect(versionNotes(v(19045), woaBoard('tspi3m')!.windowsTargets)).toEqual(['ver.note.wifi']);
    expect(versionNotes(v(19045), ['emmc'])).toEqual(['ver.note.wifi']);
    expect(versionNotes(v(22000), ['emmc', 'nvme'])).toEqual(['ver.note.less']);
    expect(versionNotes(v(22621), ['emmc', 'nvme'])).toEqual([]);
    expect(versionNotes(v(22631), ['emmc', 'sd', 'nvme'])).toEqual([]);
    expect(versionNotes(null, ['nvme'])).toEqual([]);
  });
  it('has every note and refusal in both languages, plain, without dashes', () => {
    for (const k of ['ver.note.nvme', 'ver.note.wifi', 'ver.note.less', 'ver.nvme.blocked', 'ver.nvme.blocked.here', 'ver.nvme.refused', 'ver.blocked.title', 'ver.blocked.use', 'ver.notes.title']) {
      for (const l of ['en', 'zh-CN'] as const) {
        const m = MESSAGES[k]?.[l];
        expect(m, `${k} ${l}`).toBeTruthy();
        expect(m, `${k} ${l}`).not.toMatch(/[\u2013\u2014]/);
      }
    }
    // The 21H2 note says it has run less, and nothing about a freeze (that was an old eMMC/SD driver, not 21H2).
    expect(MESSAGES['ver.note.less'].en).not.toMatch(/froze|freeze|hang/i);
  });
});

describe('the version as data for the install', () => {
  it('goes into woa-stage.ini and host-build.ini', () => {
    expect(versionIni(19045)).toEqual({ windows_family: 'win10', windows_name: 'Windows 10 22H2', windows_kmdf: '1.31', windows_wificx: 'none' });
    expect(versionIni(22000)).toEqual({ windows_family: 'win11', windows_name: 'Windows 11 21H2', windows_kmdf: '1.33', windows_wificx: '1.0' });
    expect(versionIni(22631)).toEqual({ windows_family: 'win11', windows_name: 'Windows 11 23H2', windows_kmdf: '1.33', windows_wificx: '1.0' });
  });
  it('picks the driver package\'s Windows 10 list below 22000, as its install.cmd does', () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'rk3576-drivers-manifest.json'), 'utf8');
    const m = JSON.parse(text) as { drivers: Array<Record<string, unknown>> };
    // A package with the os column: a Windows 11 only Wi-Fi driver and its Windows 10 build.
    m.drivers.push({ dir: 'wifi11', what: 'Wi-Fi (WiFiCx)', from: 'woa', default: ['tspi3m'], optional: [], os: 'win11', infs: [] });
    m.drivers.push({ dir: 'wifi10', what: 'Wi-Fi (NDIS)', from: 'woa', default: ['tspi3m'], optional: [], os: 'win10', infs: [] });
    const man = parseManifest(JSON.stringify(m));
    const dirs = (b?: number) => boardDrivers(man, 'tspi3m', b).map((d) => d.dir);
    expect(dirs(19045)).toContain('wifi10');
    expect(dirs(19045)).not.toContain('wifi11');
    expect(dirs(22000)).toContain('wifi11');
    expect(dirs(22631)).not.toContain('wifi10');
    expect(dirs()).toEqual(dirs(22631));
    // Rows without the column (packages before it) are for every Windows.
    expect(dirs(19045)).toEqual(expect.arrayContaining(['dwcsdhc', 'dwcmshc']));
    expect(man.drivers.find((d) => d.dir === 'dwcsdhc')!.os).toBe('all');
    m.drivers.push({ dir: 'odd', what: 'x', from: 'woa', default: [], optional: [], os: 'win12', infs: [] });
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/win12/);
  });
});

describe('where to get Windows', () => {
  it('lists a Windows 10 22H2 ARM64 source and a Windows 11 23H2 one', () => {
    expect(WINDOWS_SOURCES.some((s) => s.fits && /19045/.test(s.url + s.text.en))).toBe(true);
    expect(WINDOWS_SOURCES.some((s) => s.fits && /22631/.test(s.url + s.text.en))).toBe(true);
  });
});
