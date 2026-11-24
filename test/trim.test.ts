// The generated trimming script and first-start lines (src/woa/trim.ts), and
// where the install scripts call them (CONFIGURE in stage-scripts.ts).
import { describe, expect, it } from 'vitest';
import { CONFIGURE } from '../src/woa/stage-scripts';
import { setupComplete } from '../src/woa/setup-files';
import {
  anyTrim, CHROME_MSI, chromeAssociations, EDGE_APP_ID, NO_TRIM, RECOMMENDED_TRIM, STORE_APPS, TRIM_APPS, TRIM_KEYS, trimCmd, WEBVIEW2_APP_ID,
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
  it('only stops background work: Edge, the Store and Chrome are left alone', () => {
    expect(RECOMMENDED_TRIM.removeEdge).toBe(false);
    expect(RECOMMENDED_TRIM.removeStore).toBe(false);
    expect(RECOMMENDED_TRIM.chrome).toBe(false);
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
  it('removes the listed apps by name, without pipes inside the loop', () => {
    expect(rec).toContain('/Get-ProvisionedAppxPackages');
    expect(rec).toContain('Microsoft.BingNews');
    expect(rec).toContain('/Remove-ProvisionedAppxPackage /PackageName:!PKG!');
    const loop = rec.slice(rec.indexOf('for /f'), rec.indexOf('reg load'));
    expect(loop).not.toMatch(/\|/);
    expect(rec).not.toContain('Microsoft.WindowsStore');
    expect(rec).not.toContain('Microsoft.MicrosoftEdge.Stable');
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
    const all = trimCmd(Object.fromEntries(TRIM_KEYS.map((k) => [k, true])) as typeof NO_TRIM);
    const code = all.split('\n').filter((l) => !/^\s*rem /.test(l)).join('\n');
    expect(code).not.toMatch(/wuauserv|UsoSvc|WaaSMedic|sppsvc|Windows Defender|DisableAntiSpyware|DisableRealtimeMonitoring|EdgeWebView/i);
    expect(code).not.toContain(WEBVIEW2_APP_ID);
    expect(balanced(all)).toBe(true);
  });
  it('removes Edge only when asked, and stops Edge Update from bringing it back', () => {
    expect(rec).not.toContain('rd /s /q');
    const edge = trimCmd({ ...NO_TRIM, removeEdge: true });
    expect(edge).toContain(`Install${EDGE_APP_ID} /t REG_DWORD /d "0"`);
    expect(edge).toContain('DoNotUpdateToEdgeWithChromium /t REG_DWORD /d "1"');
    expect(edge).toContain('"W:\\Program Files (x86)\\Microsoft\\Edge"');
    expect(edge).toContain('Microsoft.MicrosoftEdge.Stable');
    expect(edge).toContain('StartupBoostEnabled');
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
