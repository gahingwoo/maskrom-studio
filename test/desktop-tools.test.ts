import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_SWITCH_FILE, DESKTOP_FOLDER, DESKTOP_SCRIPT_FILES, DESKTOP_TOOLS_FILE, DIAG_FILE, SSH_FIX_FILE, SSH_RULE,
  browserSwitchScript, desktopListing, desktopScripts, desktopToolsFirstStart, desktopToolsScript, diagScript, sshFixScript,
} from '../src/woa/desktop-tools';
import { setupComplete } from '../src/woa/setup-files';
import { CONFIGURE } from '../src/woa/stage-scripts';
import { selfTestScript } from '../src/woa/selftest';

describe('the RK3576 Tools desktop folder', () => {
  it('lists the same shortcuts in English and Chinese', () => {
    expect(desktopListing('en').map((e) => e.file)).toEqual([
      'Self-test.lnk', 'RK3576 Monitor.lnk', 'Drivers, install and update.url', 'Collect diagnostics.lnk',
      'Fix SSH.lnk', 'Browser GPU switch.lnk', 'User guide.url',
    ]);
    expect(desktopListing('zh-CN').map((e) => e.file)).toEqual([
      '自检.lnk', 'RK3576 监视器.lnk', '驱动安装与更新.url', '收集诊断信息.lnk',
      '修复 SSH.lnk', '浏览器 GPU 开关.lnk', '使用说明.url',
    ]);
    expect(DESKTOP_FOLDER).toEqual({ en: 'RK3576 Tools', 'zh-CN': 'RK3576 工具' });
  });

  it('links the docs in the folder\'s language', () => {
    const en = desktopListing('en');
    const zh = desktopListing('zh-CN');
    expect(en.find((e) => e.file === 'User guide.url')!.opens).toBe('https://github.com/gahingwoo/maskrom-studio/blob/main/docs/use.md');
    expect(zh.find((e) => e.file === '使用说明.url')!.opens).toBe('https://github.com/gahingwoo/maskrom-studio/blob/main/docs/zh-CN/use.md');
    expect(en.find((e) => e.file.startsWith('Drivers'))!.opens).toMatch(/woa-rk3576\/blob\/main\/docs\/drivers\.md$/);
    expect(zh.find((e) => e.file.startsWith('驱动'))!.opens).toMatch(/woa-rk3576\/blob\/main\/docs\/drivers\.zh-CN\.md$/);
  });

  it('makes shortcuts only, on the Public Desktop, each only when its target is there', () => {
    const ps = desktopToolsScript();
    expect(ps).toContain("GetFolderPath('CommonDesktopDirectory')");
    expect(ps).toContain("'RK3576 Tools'");
    expect(ps).toContain("'RK3576 工具'");
    for (const zh of ['自检', '收集诊断信息', '修复 SSH', '浏览器 GPU 开关']) expect(ps).toContain(`'${zh}'`);
    // Nothing is copied into the folder: only .lnk and .url files are written there.
    expect(ps).not.toMatch(/Copy-Item|Move-Item/);
    expect(ps).toContain("if (Test-Path (Join-Path $Rk 'rk-monitor.exe'))");
    expect(ps).toContain("Test-Path (Join-Path $Ssh 'install-sshd.ps1')");
    expect(ps).toContain("Test-Path (Join-Path $Rk 'browser-gpu\\rk3576-browser-gpu.ps1')");
    // The self-test shortcut runs it again without the first-start wait.
    expect(ps).toContain("Join-Path $Scripts 'woa-selftest.ps1') + '\" -Now')");
  });

  it('is run by SetupComplete.cmd after the RK3576 tools and the browser GPU switch, and staged with its scripts', () => {
    const sc = setupComplete({ skipSetup: null, ssh: true, sshKey: '', rkTools: true });
    const at = sc.indexOf(desktopToolsFirstStart()[1]);
    expect(at).toBeGreaterThan(sc.indexOf('firstboot.cmd'));
    expect(at).toBeGreaterThan(sc.indexOf('-Action Install'));
    expect(desktopScripts().map((f) => f.name)).toEqual([...DESKTOP_SCRIPT_FILES]);
    expect(CONFIGURE).toContain(`for %%f in (${DESKTOP_SCRIPT_FILES.join(' ')}) do if exist "%STAGE%\\%%f" copy /y "%STAGE%\\%%f" W:\\Windows\\Setup\\Scripts\\%%f`);
    expect(DESKTOP_SCRIPT_FILES).toEqual([DESKTOP_TOOLS_FILE, DIAG_FILE, SSH_FIX_FILE, BROWSER_SWITCH_FILE]);
  });

  it('the self-test takes -Now and skips its wait with it', () => {
    const s = selfTestScript({ appVersion: '1' });
    expect(s).toContain('param([switch]$Now)');
    expect(s).toMatch(/if \(\$Now\) \{[^\n]*\} else \{ Start-Sleep -Seconds 90 \}/);
  });
});

describe('the scripts behind the shortcuts', () => {
  it('are UTF-8 with a BOM, have no em or en dashes, and elevate themselves where they need to', () => {
    for (const f of desktopScripts()) {
      expect(f.text.charCodeAt(0), f.name).toBe(0xfeff);
      expect(f.text, f.name).not.toMatch(/[\u2013\u2014]/);
    }
    for (const t of [diagScript(), sshFixScript(), browserSwitchScript()]) {
      expect(t).toContain('-Verb RunAs');
      expect(t).toMatch(/if \(-not \(Test-Admin\)\) \{ Invoke-Elevated/);
    }
  });

  it('diagnostics: read-only, every section asked for, a dated file on the desktop', () => {
    const d = diagScript();
    for (const s of ['Get-NetAdapter ', 'ipconfig.exe /all', 'Get-NetAdapterStatistics', 'Get-NetConnectionProfile', 'ConfigManagerErrorCode',
      'pnputil.exe /enum-drivers', 'Win32_VideoController', 'ThermalZoneInformation', 'Get-Service sshd', 'bcdedit.exe /enum all', 'woa-setupcomplete.log']) {
      expect(d).toContain(s);
    }
    expect(d).toContain("'RK3576-diag-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'");
    // The elevated copy writes to the desktop of whoever started it.
    expect(d).toContain(`Invoke-Elevated (' -OutDir "' + $OutDir + '"')`);
    expect(d).not.toMatch(/Set-Service|Set-NetFirewallRule|New-NetFirewallRule|Remove-Item|reg add|bcdedit\.exe \/set|Invoke-WebRequest/);
  });

  it('SSH fix: registers sshd if missing, automatic, started, port 22 on every profile', () => {
    const s = sshFixScript();
    expect(s).toContain("if (-not (Get-Service sshd -ErrorAction SilentlyContinue))");
    expect(s).toContain("-File (Join-Path $Dir 'install-sshd.ps1')");
    expect(s).toContain('Set-Service -Name sshd -StartupType Automatic');
    expect(s).toContain('Start-Service sshd');
    expect(s).toContain(`$Rule = '${SSH_RULE}'`);
    expect(s).toContain('Set-NetFirewallRule -Profile Any -Enabled True -Action Allow');
    expect(s).toContain('New-NetFirewallRule -DisplayName $Rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -Profile Any');
    expect(s).not.toMatch(/-Profile (Private|Domain|Public)/);
  });

  it('browser GPU switch: Mode 0 is off, anything else on; uses the installed script', () => {
    const b = browserSwitchScript();
    expect(b).toContain("RK3576\\browser-gpu\\rk3576-browser-gpu.ps1");
    expect(b).toContain('$on = -not ($mode -eq 0)');
    expect(b).toContain("$action = 'Disable'");
    expect(b).toContain("$action = 'Enable'");
  });

  it('parse in PowerShell where pwsh is installed', () => {
    const has = spawnSync('pwsh', ['-v']);
    if (has.error || has.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), 'desktop-tools-'));
    for (const f of desktopScripts()) {
      const p = join(dir, f.name);
      writeFileSync(p, f.text);
      const r = spawnSync('pwsh', ['-NoProfile', '-Command', `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${p}', [ref]$null, [ref]$e) | Out-Null; $e.Count`], { encoding: 'utf8' });
      expect(r.stdout.trim(), f.name).toBe('0');
    }
  });
});
