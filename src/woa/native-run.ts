// RunOnce commands that run as native ARM64 processes.
//
// Windows 10 22H2 (19045) on the CM5-IO started an HKLM RunOnce command as
// an x86 process (2026-11-28): %ProgramFiles% was "Program Files (x86)", so
// the RK3576 tools' first-boot step found no RK3576 folder, and pnputil
// (ARM64 only) was "not recognized". Windows 11 23H2 runs them natively.
// %WINDIR%\Sysnative exists only inside a 32-bit process and leads to the
// native System32, so a command that goes through it runs natively either way.

/**
 * A RunOnce value that runs `inner` in a native cmd.exe. `pct` is how a
 * percent sign is written: '%' where the value is written at run time,
 * '%%' inside a batch file that expands variables while writing it.
 * `inner` may not contain double quotes (it sits inside reg add /d "...").
 */
export function nativeRunOnce(inner: string, pct: '%' | '%%' = '%'): string {
  if (inner.includes('"')) throw new Error('nativeRunOnce: no double quotes in the command');
  const w = `${pct}WINDIR${pct}`;
  return `cmd.exe /c if exist ${w}\\Sysnative\\cmd.exe (${w}\\Sysnative\\cmd.exe /c ${inner}) else (${inner})`;
}
