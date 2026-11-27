// Takes --disable-direct-composition back out of Edge, Chrome and WebView2.
// Version 1 of woa-rk3576's rk3576-browser-gpu.ps1 added it at WDDM 2.x; it
// never helped (white Edge windows on maliwddm before 2df1808, 32 fps instead
// of DirectComposition's 60 at 1440p on the fixed one; wddm-mali-g52
// docs/EDGE-PRESENT.md). Version 2 only removes it: the switch, the Edge and
// Chrome policies version 1 set (given back their saved state), WebView2's
// arguments, and version 1's task \RK3576\Browser GPU, its copy in
// %ProgramFiles%\RK3576\browser-gpu and its settings. Its documentation:
// woa-rk3576 tools/rk3576-tools/BROWSER-GPU.md.
//
// The script is woa-rk3576's, copied into src/woa/browser-gpu/ and turned
// into browser-gpu-script.ts by scripts/sync-browser-gpu.mjs.
//
// Here: the staged install copies it to \Windows\Setup\Scripts and
// SetupComplete.cmd runs "-Action Install" after Chrome and the RK3576 tools
// are in, then deletes that copy. It stays because a tools bundle built
// before version 2 (the woa-rk3576 "ci" release carries one) still installs
// version 1 at its first boot; running version 2 after it takes that out
// again. On a Windows that never had the switch it changes nothing.

import { BROWSER_GPU_PS1 } from './browser-gpu-script';

export const BROWSER_GPU_FILE = 'rk3576-browser-gpu.ps1';

export function browserGpuScript(): string {
  return BROWSER_GPU_PS1;
}

/** SetupComplete.cmd lines. */
export function browserGpuFirstStart(): string[] {
  const ps = `%WINDIR%\\Setup\\Scripts\\${BROWSER_GPU_FILE}`;
  return [
    'rem Take out the --disable-direct-composition an older RK3576 tools bundle may have put on',
    'rem Edge, Chrome and WebView2, with its task \\RK3576\\Browser GPU (woa-rk3576',
    'rem tools/rk3576-tools/BROWSER-GPU.md). The fixed maliwddm needs no browser switch.',
    `if exist "${ps}" (`,
    `  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps}" -Action Install >> "%LOG%" 2>&1`,
    `  del /f /q "${ps}"`,
    ')',
  ];
}
