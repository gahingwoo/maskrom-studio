// Charsiu Desktop (gahingwoo/charsiu-desktop), the chat window for charsiu
// on the RK3576 NPU, preinstalled on Windows by default (user decision
// 2026-11-25: "charsiu installed, no model"). Only the desktop app: no model
// is downloaded, and the charsiu command line stays in the RK3576 tools.
//
// The installer is the arm64 setup.exe of charsiu-desktop's stable release,
// pinned below with its size and SHA-256 like OpenSSH (setup-files.ts) and
// checked after the download (release-download.ts). Pinned, not read from the
// release at write time: v0.3.0's SHA256SUMS.txt was uploaded before the
// binaries were replaced, so it disagrees with GitHub's digest for every one
// of them and releases.ts would refuse the release. The SHA-256 here is
// GitHub's digest, which matches the file. test/charsiu-desktop.test.ts
// checks it against the recorded release.
//
// It is a Tauri NSIS installer with installMode "currentUser": run as SYSTEM
// from SetupComplete.cmd it would install into the system profile, so it
// runs at the first sign-in instead, as that user:
//   - the install script copies it to \ProgramData\Maskrom Studio and
//     woa-charsiu.ps1 to \Windows\Setup\Scripts;
//   - SetupComplete.cmd adds an HKLM RunOnce value for the script, as for
//     the self-test (selftest.ts), so the first user who signs in gets it;
//   - the script checks the installer's SHA-256 again, runs it silently
//     (/S), logs to \ProgramData\Maskrom Studio\charsiu-desktop.log, and
//     deletes the installer and itself.
// Later users install it themselves from the release page.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const CHARSIU_REPO = 'gahingwoo/charsiu-desktop';
export const CHARSIU_DESKTOP = {
  version: '0.3.0',
  tag: 'v0.3.0',
  file: 'Charsiu.Desktop_0.3.0_arm64-setup.exe',
  url: 'https://github.com/gahingwoo/charsiu-desktop/releases/download/v0.3.0/Charsiu.Desktop_0.3.0_arm64-setup.exe',
  size: 1856664,
  sha256: '6f56f87ac9b7b9278782c6ff716af5206afa560fc1df211885a92a10dc339ef2',
};
/** Where the installer goes on the staging volume, whatever its release calls it. */
export const CHARSIU_SETUP_PATH = 'charsiu/charsiu-desktop-setup.exe';
export const CHARSIU_FILE = 'woa-charsiu.ps1';

const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** \Windows\Setup\Scripts\woa-charsiu.ps1 for an installer with this SHA-256. */
export function charsiuScript(sha: string): string {
  return `# Written by Maskrom Studio (src/woa/charsiu-desktop.ts). Run once at the first
# sign-in (HKLM RunOnce), as that user: Charsiu Desktop installs per user.
$ErrorActionPreference = 'Continue'
$Dir = Join-Path $env:ProgramData 'Maskrom Studio'
$Setup = Join-Path $Dir 'charsiu-desktop-setup.exe'
$Log = Join-Path $Dir 'charsiu-desktop.log'
function Log($m) { try { Add-Content -Path $Log -Value "$(Get-Date -Format s) $m" } catch { } }
$Want = ${psString(sha.toLowerCase())}
if (Test-Path -LiteralPath $Setup) {
  $Got = (Get-FileHash -LiteralPath $Setup -Algorithm SHA256).Hash.ToLower()
  if ($Got -ne $Want) {
    Log "installer SHA-256 $Got (expected $Want), not run"
  } else {
    try {
      $p = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
      Log "Charsiu Desktop installer finished, exit code $($p.ExitCode)"
    } catch {
      Log "Charsiu Desktop installer could not start: $($_.Exception.Message)"
    }
  }
  Remove-Item -LiteralPath $Setup -Force -ErrorAction SilentlyContinue
} else {
  Log 'no installer'
}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`;
}

/** The script for the installer among the staged files, or nothing when there is none. */
export function charsiuGenerated(extras: Array<{ path: string; data: Uint8Array }>): Array<{ name: string; text: string }> {
  const setup = extras.find((e) => e.path === CHARSIU_SETUP_PATH && e.data.length > 0);
  return setup ? [{ name: CHARSIU_FILE, text: charsiuScript(bytesToHex(sha256(setup.data))) }] : [];
}

/** The SetupComplete.cmd line: the first user who signs in runs the script. */
export function charsiuRunOnce(): string[] {
  return [
    'rem Charsiu Desktop (charsiu-desktop.ts): its installer installs per user, so it runs at the first sign-in.',
    `if exist "%WINDIR%\\Setup\\Scripts\\${CHARSIU_FILE}" reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce" /v WoaCharsiuDesktop /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File %WINDIR%\\Setup\\Scripts\\${CHARSIU_FILE}" /f >> "%LOG%" 2>&1`,
  ];
}
