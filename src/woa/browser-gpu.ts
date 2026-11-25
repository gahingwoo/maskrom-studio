// Edge, Chrome and WebView2 on the GPU. At WDDM 2.x (maliwddm's default
// since 2026-11-24) Chromium's DirectComposition presents fail on the
// Mali-G52 and both browsers fall back to software rendering; started with
// --disable-direct-composition they render on the GPU (board, 2026-11-25).
// No policy sets a command-line switch, so woa-rk3576's
// rk3576-browser-gpu.ps1 adds it to every launch path (shortcuts, pinned
// taskbar icons, open commands, Run values), turns off Edge's startup boost
// and both browsers' background mode, appends it to WebView2's arguments,
// and keeps it there with the scheduled task \RK3576\Browser GPU, only while
// maliwddm runs at WDDM 2.x. Its documentation:
// woa-rk3576 tools/rk3576-tools/BROWSER-GPU.md.
//
// The script is woa-rk3576's, copied into src/woa/browser-gpu/ and turned
// into browser-gpu-script.ts by scripts/sync-browser-gpu.mjs. The tools
// bundle installs the same script; both install into
// %ProgramFiles%\RK3576\browser-gpu and register the same task, and the
// higher $BgVersion stays, so a board with both runs one copy.
//
// Here: the staged install copies it to \Windows\Setup\Scripts and
// SetupComplete.cmd runs "-Action Install" after Chrome and the RK3576 tools
// are in, then deletes that copy. If maliwddm has not reported WDDM 2.x by
// then, the task does it at the first sign-in.

import { BROWSER_GPU_PS1 } from './browser-gpu-script';

export const BROWSER_GPU_FILE = 'rk3576-browser-gpu.ps1';

export function browserGpuScript(): string {
  return BROWSER_GPU_PS1;
}

/** SetupComplete.cmd lines. */
export function browserGpuFirstStart(): string[] {
  const ps = `%WINDIR%\\Setup\\Scripts\\${BROWSER_GPU_FILE}`;
  return [
    'rem Edge, Chrome and WebView2 on the GPU at WDDM 2.x: --disable-direct-composition on their',
    'rem shortcuts and open commands, kept by the task \\RK3576\\Browser GPU (woa-rk3576',
    'rem tools/rk3576-tools/BROWSER-GPU.md). Off: HKLM\\SOFTWARE\\RK3576\\BrowserGpu Mode 0.',
    `if exist "${ps}" (`,
    `  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps}" -Action Install >> "%LOG%" 2>&1`,
    `  del /f /q "${ps}"`,
    ')',
  ];
}
