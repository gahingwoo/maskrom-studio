// The generated trimming script and first-start lines (src/woa/trim.ts), and
// where the install scripts call them (CONFIGURE in stage-scripts.ts).
import { describe, expect, it } from 'vitest';
import { CONFIGURE } from '../src/woa/stage-scripts';
import { setupComplete } from '../src/woa/setup-files';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  anyTrim, CHROME_MSI, COPILOT_APPS, EDGE_APPS, FRAMEWORK_PREFIXES, KEEP_APPS, notepadFixCmd, chromeAssociations, EDGE_APP_ID, NO_TRIM, RECOMMENDED_TRIM, STORE_APPS, TRIM_APPS, TRIM_KEYS, trimCmd, WEBVIEW2_APP_ID,
} from '../src/woa/trim';


/** Parentheses outside quotes balance on every line set, as cmd needs them to. */
function balanced(script: string): boolean {
  let depth = 0;
  for (const line of script.split('\n')) {
    let q = false;
    for (const c of line.replace(/\^[()]/g, '')) {
      if (c === '"') q = !q;
      else if (!q && c === '(') depth++;
      else if (!q && c === ')') depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

describe('the recommended set', () => {
  it('stops background work, adds Chrome, keeps drivers out of Windows Update, and leaves Edge and the Store', () => {
    expect(RECOMMENDED_TRIM.removeEdge).toBe(false);
    expect(RECOMMENDED_TRIM.chrome).toBe(true);
    expect(RECOMMENDED_TRIM.wuDrivers).toBe(true);
    expect(RECOMMENDED_TRIM.removeStore).toBe(false);
    expect(anyTrim(RECOMMENDED_TRIM)).toBe(true);
    expect(anyTrim(NO_TRIM)).toBe(false);
    expect(anyTrim(undefined)).toBe(false);
  });
  it('never lists what Windows needs to update and run', () => {
    for (const keep of ['Microsoft.WindowsStore', 'Microsoft.StorePurchaseApp', 'Microsoft.DesktopAppInstaller', 'Microsoft.VCLibs',
      'Microsoft.UI.Xaml', 'Microsoft.SecHealthUI', 'Microsoft.WindowsTerminal', 'Microsoft.MicrosoftEdge.Stable']) {
      expect(TRIM_APPS).not.toContain(keep);
    }
  });
});

describe('woa-trim.cmd', () => {
  const rec = trimCmd(RECOMMENDED_TRIM);
  const noEdge = trimCmd({ ...RECOMMENDED_TRIM, removeEdge: false });
  it('keeps Windows Update from installing drivers, and changes nothing else of it', () => {
    expect(rec).toContain('Policies\\Microsoft\\Windows\\WindowsUpdate" /v ExcludeWUDriversInQualityUpdate /t REG_DWORD /d "1"');
    expect(rec.match(/WindowsUpdate"/g)?.length).toBe(1);
    expect(trimCmd({ ...NO_TRIM, apps: true })).not.toContain('ExcludeWUDriversInQualityUpdate');
  });
  it('removes the listed apps by name, without pipes inside the loop', () => {
    expect(rec).toContain('/Get-ProvisionedAppxPackages');
    expect(rec).toContain('Microsoft.BingNews');
    expect(rec).toContain('/Remove-ProvisionedAppxPackage /PackageName:!PKG!');
    const loop = rec.slice(rec.indexOf('for /f'), rec.indexOf('reg load'));
    expect(loop).not.toMatch(/\|/);
    expect(rec).not.toContain('Microsoft.WindowsStore');
    expect(noEdge).not.toContain('Microsoft.MicrosoftEdge.Stable');
    expect(rec).not.toContain('Microsoft.MicrosoftEdge.Stable');
    expect(trimCmd({ ...RECOMMENDED_TRIM, removeEdge: true })).toContain('Microsoft.MicrosoftEdge.Stable');
  });
  it('sets the documented policies in the loaded hives and unloads all three', () => {
    for (const v of ['DisableFileSyncNGSC /t REG_DWORD /d "1"', 'TurnOffWindowsCopilot /t REG_DWORD /d "1"', 'AllowNewsAndInterests /t REG_DWORD /d "0"',
      'StartupBoostEnabled /t REG_DWORD /d "0"', 'BackgroundModeEnabled /t REG_DWORD /d "0"', 'DisableWindowsConsumerFeatures /t REG_DWORD /d "1"',
      'AllowTelemetry /t REG_DWORD /d "1"', 'Services\\WSearch" /v DelayedAutostart', 'Services\\SysMain" /v Start /t REG_DWORD /d "4"']) {
      expect(rec).toContain(v);
    }
    expect(rec).toContain('reg delete "HKLM\\WOATRIMDEF\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v OneDriveSetup');
    for (const h of ['WOATRIMSW', 'WOATRIMSYS', 'WOATRIMDEF']) {
      expect(rec).toContain(`reg load HKLM\\${h}`);
      expect(rec).toContain(`reg unload HKLM\\${h}`);
    }
    expect(balanced(rec)).toBe(true);
    expect(rec.trim().endsWith('exit /b 0')).toBe(true);
  });
  it('never touches Windows Update, activation, Defender or WebView2', () => {
    const all = trimCmd(Object.fromEntries(TRIM_KEYS.map((k) => [k, true])) as unknown as typeof NO_TRIM);
    const code = all.split('\n').filter((l) => !/^\s*rem /.test(l)).join('\n');
    expect(code).not.toMatch(/wuauserv|UsoSvc|WaaSMedic|sppsvc|Windows Defender|DisableAntiSpyware|DisableRealtimeMonitoring|EdgeWebView/i);
    expect(code).not.toContain(WEBVIEW2_APP_ID);
    expect(balanced(all)).toBe(true);
  });
  it('removes Edge only when asked, and stops Edge Update from bringing it back', () => {
    expect(noEdge).not.toContain('rd /s /q');
    const edge = trimCmd({ ...NO_TRIM, removeEdge: true });
    expect(edge).toContain(`Install${EDGE_APP_ID} /t REG_DWORD /d "0"`);
    expect(edge).toContain('DoNotUpdateToEdgeWithChromium /t REG_DWORD /d "1"');
    expect(edge).toContain('"W:\\Program Files (x86)\\Microsoft\\Edge"');
    expect(edge).toContain('Microsoft.MicrosoftEdge.Stable');
    expect(edge).toContain('StartupBoostEnabled');
  });
  it('brings back the classic right-click menu for new users', () => {
    expect(rec).toContain('/v ClassicContextMenu');
    expect(rec).toContain('HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32');
    expect(rec).toContain('reg unload HKLM\\WOATRIMCLS');
    expect(trimCmd({ ...NO_TRIM, sysmain: true })).not.toContain('ClassicContextMenu');
  });
  it('removes the Store only when asked', () => {
    const store = trimCmd({ ...NO_TRIM, removeStore: true });
    for (const a of STORE_APPS) expect(store).toContain(a);
  });
  it('points new users at Chrome through DefaultAssociationsConfiguration', () => {
    const c = trimCmd({ ...NO_TRIM, chrome: true });
    expect(c).toContain('DefaultAssociationsConfiguration /t REG_SZ /d "C:\\ProgramData\\Maskrom Studio\\default-browser.xml"');
    expect(c).toContain(`"%STAGE%\\${CHROME_MSI.path.replace('/', '\\')}"`);
    const xml = chromeAssociations();
    for (const id of ['.html', '.pdf', 'http', 'https']) expect(xml).toContain(`Identifier="${id}" ProgId="ChromeHTML"`);
  });
});

describe('the first start and the install scripts', () => {
  it('installs Chrome only after checking Google\'s signature', () => {
    const sc = setupComplete({ skipSetup: null, ssh: false, sshKey: '', trim: { ...NO_TRIM, chrome: true } });
    expect(sc).toContain('Get-AuthenticodeSignature');
    expect(sc).toContain('O=Google LLC');
    expect(sc.indexOf('Get-AuthenticodeSignature')).toBeLessThan(sc.indexOf('msiexec.exe /i'));
    expect(setupComplete({ skipSetup: null, ssh: false, sshKey: '' })).not.toContain('msiexec');
  });
  it('runs the RK3576 tools\' first-boot step only when they are installed', () => {
    expect(setupComplete({ skipSetup: null, ssh: false, sshKey: '', rkTools: true })).toContain('call "%ProgramFiles%\\RK3576\\setup\\firstboot.cmd"');
    expect(setupComplete({ skipSetup: null, ssh: false, sshKey: '' })).not.toContain('RK3576\\setup');
  });
  it('calls the trimming and the offline tools install after the hives are unloaded, without /hook', () => {
    const at = (s: string) => CONFIGURE.indexOf(s);
    expect(at('call "%STAGE%\\woa-trim.cmd"')).toBeGreaterThan(at('reg unload HKLM\\WOAOFF'));
    expect(CONFIGURE).toContain('cmd /c ""%STAGE%\\rk3576-tools\\offline-install.cmd" W:\\"');
    expect(CONFIGURE).not.toMatch(/offline-install\.cmd" W:\\"? \/hook/);
  });
});

// What DISM really holds: test/fixtures/appx-22621-iot-arm64.json, recorded from
// a Windows 11 IoT Enterprise 22621.2428 ARM64 install.wim (see its comment).
interface Pkg { name: string; version: string; arch: string; framework: boolean; dependencies: string[] }
const inv = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'appx-22621-iot-arm64.json'), 'utf8')) as { provisioned: string[]; packages: Pkg[] };
/** woa-trim.cmd's match: !PKG:<name>_=! changes the full name, case-insensitively, wherever <name>_ is in it. */
const removedBy = (names: string[], full: string) => names.some((n) => full.toLowerCase().includes(`${n.toLowerCase()}_`));
const everyList = [...TRIM_APPS, ...COPILOT_APPS, ...STORE_APPS, ...EDGE_APPS];

describe('app removal never takes a framework or what a kept app needs', () => {
  const frameworks = inv.packages.filter((p) => p.framework).map((p) => p.name);
  it('the static framework list knows every framework the image has', () => {
    expect(frameworks.length).toBeGreaterThan(0);
    for (const f of frameworks) expect(FRAMEWORK_PREFIXES.some((x) => f.startsWith(x))).toBe(true);
  });
  it('no list names a framework, by name or by what the match would hit', () => {
    for (const n of everyList) {
      expect(FRAMEWORK_PREFIXES.some((x) => n.toLowerCase().startsWith(x.toLowerCase()))).toBe(false);
      for (const f of frameworks) expect(removedBy([n], `${f}_1.0.0.0_arm64__8wekyb3d8bbwe`)).toBe(false);
    }
  });
  it('no list names a kept app (the Store only through its own option)', () => {
    for (const k of KEEP_APPS) {
      for (const n of [...TRIM_APPS, ...COPILOT_APPS, ...EDGE_APPS]) expect(removedBy([n], `${k}_1.0.0.0_neutral_~_8wekyb3d8bbwe`)).toBe(false);
    }
  });
  it('of the provisioned packages, removes only listed apps, and none that a remaining package depends on', () => {
    const all = { ...RECOMMENDED_TRIM, removeStore: true, removeEdge: true };
    const names = [...(all.apps ? TRIM_APPS : []), ...COPILOT_APPS, ...STORE_APPS, ...EDGE_APPS];
    const removed = inv.provisioned.filter((full) => removedBy(names, full)).map((full) => full.split('_')[0]);
    expect(removed).toContain('Microsoft.BingNews');
    expect(removed).not.toContain('Microsoft.VCLibs.140.00');
    expect(removed).not.toContain('Microsoft.WindowsNotepad');
    const kept = inv.packages.filter((p) => !removed.includes(p.name));
    for (const p of kept) for (const d of p.dependencies) expect(removed).not.toContain(d);
  });
});

describe('Notepad on images whose Notepad app is x64 only', () => {
  const has = (name: string, arch: string) => inv.packages.some((p) => p.name === name && p.arch === arch);
  it('the recorded image has exactly that problem: its only unmet dependency', () => {
    const unmet = inv.packages.filter((p) => !p.framework).flatMap((p) => p.dependencies
      .filter((d) => !has(d, p.arch) && !has(d, 'neutral')).map((d) => `${p.name} ${p.arch} -> ${d}`));
    expect(unmet).toEqual(['Microsoft.WindowsNotepad x64 -> Microsoft.UI.Xaml.2.7']);
  });
  const cmd = notepadFixCmd();
  it('unprovisions the app only when it is x64 only, the x64 framework is missing and notepad.exe is there', () => {
    expect(cmd).toContain('Microsoft.WindowsNotepad_*_x64__8wekyb3d8bbwe');
    expect(cmd).toContain('Microsoft.WindowsNotepad_*_arm64__8wekyb3d8bbwe');
    expect(cmd).toContain('Microsoft.UI.Xaml.2.7_*_x64__8wekyb3d8bbwe');
    expect(cmd).toContain('if defined NP_X64 if not defined NP_ARM64 if not defined XAML27_X64 if exist W:\\Windows\\System32\\notepad.exe (');
    expect(cmd).toContain('if /i "!NPKG:~0,25!"=="Microsoft.WindowsNotepad_" dism /English /Image:W:\\ /Remove-ProvisionedAppxPackage /PackageName:!NPKG!');
    expect('Microsoft.WindowsNotepad_'.length).toBe(25);
    expect(balanced(cmd)).toBe(true);
    expect(cmd).not.toMatch(/\|/);
  });
  it('runs on every install, trimmed or not', () => {
    expect(CONFIGURE).toContain(cmd);
    expect(trimCmd(NO_TRIM)).not.toContain('WindowsNotepad');
  });
});
