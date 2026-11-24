import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISSUES_URL, selfTestRunOnce, selfTestScript } from '../src/woa/selftest';
import { setupComplete } from '../src/woa/setup-files';

describe('first-desktop self-test', () => {
  const ps = selfTestScript({ appVersion: '9.9.9' });

  it('is UTF-8 with a BOM, so Windows PowerShell 5.1 reads the Chinese text', () => {
    expect(ps.charCodeAt(0)).toBe(0xfeff);
    expect(ps).toContain('RK3576 自检');
  });

  it('checks what was decided, and lets the EC20 modem interface MI_04 pass', () => {
    expect(ps).toContain("'USB\\VID_2C7C&PID_0125&MI_04'");
    expect(ps).toContain("'WDDM 2.0'");
    expect(ps).toContain('GpuClkHz');
    expect(ps).toContain('594000000');
    expect(ps).toContain('-Class AudioEndpoint');
    expect(ps).toContain('Resolve-DnsName');
    expect(ps).toContain('WriteThrough');
    expect(ps).not.toMatch(/npu/i);
  });

  it('only opens a prefilled issue when asked, never sends anything itself', () => {
    expect(ps).toContain(`'${ISSUES_URL}?title='`);
    expect(ps).toMatch(/if \(\$r -eq 'Yes'\) \{[\s\S]*Start-Process \$url/);
    expect(ps).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient/);
    // No user name or computer name in the report.
    expect(ps).not.toMatch(/USERNAME|COMPUTERNAME|\$env:USER/);
  });

  it('is started once from RunOnce by SetupComplete.cmd', () => {
    const sc = setupComplete({ skipSetup: null, ssh: false, sshKey: '' });
    expect(sc).toContain(selfTestRunOnce()[1]);
    expect(sc).toMatch(/RunOnce" \/v WoaSelfTest/);
  });

  it('parses in PowerShell where pwsh is installed', () => {
    const has = spawnSync('pwsh', ['-v']);
    if (has.error || has.status !== 0) return;
    const f = join(mkdtempSync(join(tmpdir(), 'selftest-')), 's.ps1');
    writeFileSync(f, ps);
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e) | Out-Null; $e.Count`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('0');
  });
});
