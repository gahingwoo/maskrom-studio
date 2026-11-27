// The browser switch cleanup (src/woa/browser-gpu.ts): the copy of
// woa-rk3576's rk3576-browser-gpu.ps1, and where the install runs it. The
// script itself is tested on Windows (browser-gpu job in ci.yml).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSER_GPU_FILE, browserGpuFirstStart, browserGpuScript } from '../src/woa/browser-gpu';
import { BROWSER_GPU_PS1, BROWSER_GPU_VERSION } from '../src/woa/browser-gpu-script';
import { setupComplete } from '../src/woa/setup-files';
import { CONFIGURE } from '../src/woa/stage-scripts';
import { NO_TRIM, RECOMMENDED_TRIM } from '../src/woa/trim';

describe('the script', () => {
  const ps1 = readFileSync('src/woa/browser-gpu/rk3576-browser-gpu.ps1', 'utf8').replace(/\r\n/g, '\n');
  it('is the .ps1 next to it (run node scripts/sync-browser-gpu.mjs after changing it)', () => {
    expect(BROWSER_GPU_PS1).toBe(ps1);
    expect(browserGpuScript()).toBe(ps1);
    expect(Number(/^\$BgVersion = (\d+)/m.exec(ps1)![1])).toBe(BROWSER_GPU_VERSION);
  });
  it('is ASCII, as Windows PowerShell 5.1 reads a file without a BOM', () => {
    expect(/[^\x00-\x7f]/.test(ps1)).toBe(false);
  });
  it('only takes --disable-direct-composition out, and removes version 1\'s task', () => {
    expect(BROWSER_GPU_VERSION).toBeGreaterThanOrEqual(2);
    expect(ps1).toContain("$BgFlag = '--disable-direct-composition'");
    expect(ps1).toContain("$BgTaskName = 'Browser GPU'");
    expect(ps1).toContain('Unregister-ScheduledTask');
    expect(ps1).not.toContain('Register-ScheduledTask -');
    expect(ps1).not.toMatch(/function (Add-Flag|Sync-|Get-GpuGate|Get-TaskXml)/);
    expect(ps1).toMatch(/ValidateSet\('Status', 'Apply', 'Revert', 'Enable', 'Disable', 'Install', 'Uninstall'\)/);
  });
});

describe('the first start', () => {
  const base = { skipSetup: null, ssh: false, sshKey: '' };
  it('installs it from SetupComplete.cmd, after Chrome and the RK3576 tools, then deletes the copy', () => {
    const sc = setupComplete({ ...base, trim: RECOMMENDED_TRIM, rkTools: true });
    const run = `-File "%WINDIR%\\Setup\\Scripts\\${BROWSER_GPU_FILE}" -Action Install`;
    expect(sc).toContain(run);
    expect(sc.indexOf(run)).toBeGreaterThan(sc.indexOf('msiexec.exe /i'));
    expect(sc.indexOf(run)).toBeGreaterThan(sc.indexOf('RK3576\\setup\\firstboot.cmd'));
    expect(sc).toContain(`del /f /q "%WINDIR%\\Setup\\Scripts\\${BROWSER_GPU_FILE}"`);
    // Without the tools bundle and without Chrome too.
    expect(setupComplete({ ...base, trim: NO_TRIM })).toContain(run);
    expect(setupComplete({ ...base, browserGpu: false })).not.toContain(BROWSER_GPU_FILE);
  });
  it('has no parenthesis inside its if block (cmd would end the block there)', () => {
    const lines = browserGpuFirstStart();
    const open = lines.findIndex((l) => l.startsWith('if exist'));
    for (const l of lines.slice(open + 1, -1)) expect(l).not.toMatch(/[()]/);
    expect(lines[lines.length - 1]).toBe(')');
  });
  it('is copied into the new Windows by the install scripts', () => {
    expect(CONFIGURE).toContain(`copy /y "%STAGE%\\${BROWSER_GPU_FILE}" W:\\Windows\\Setup\\Scripts\\${BROWSER_GPU_FILE}`);
  });
});
