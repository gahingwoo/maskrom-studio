// The self-test on Windows' first desktop: woa-selftest.ps1, copied to
// \Windows\Setup\Scripts and started once by an HKLM RunOnce value that
// SetupComplete.cmd sets (RunOnce values are deleted before they run).
//
// It checks, after giving Plug and Play a minute and a half to settle:
//   - Device Manager: no device with a problem, except the EC20 modem's
//     interface MI_04 (USB\VID_2C7C&PID_0125&MI_04), which has no driver;
//   - the GPU: the Mali-G52 is on its WDDM driver with driver model WDDM 2.0
//     (dxdiag), and the clock maliwddm reports (Device Parameters\maliwddm
//     GpuClkHz, written by builds that set the clock) is at least 594 MHz;
//   - audio: at least one audio output endpoint that works;
//   - network: an adapter that is up, and a name that resolves;
//   - storage: 64 MiB written to the system disk with write-through, read
//     back and compared by SHA-256.
// Then a message box: all fine, or the problems with a button that opens a
// prefilled GitHub issue in the browser. Nothing is sent by itself; the
// issue text has no user name, computer name, serial numbers or addresses.
// The whole report is in the message box (a .txt needs a working Notepad
// app to open) and is also saved on the desktop. No NPU test (decided 2026-11-25).

export const SELFTEST_FILE = 'woa-selftest.ps1';
export const ISSUES_URL = 'https://github.com/gahingwoo/maskrom-studio/issues/new';

/** The RunOnce line SetupComplete.cmd adds. */
export function selfTestRunOnce(): string[] {
  return [
    'rem The self-test on the first desktop (selftest.ts): once, for the first user who signs in.',
    `if exist "%WINDIR%\\Setup\\Scripts\\${SELFTEST_FILE}" reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce" /v WoaSelfTest /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File %WINDIR%\\Setup\\Scripts\\${SELFTEST_FILE}" /f >> "%LOG%" 2>&1`,
  ];
}

const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The script. Saved with a UTF-8 BOM so Windows PowerShell 5.1 reads the Chinese text right. */
export function selfTestScript(o: { appVersion: string }): string {
  return `﻿# Written by Maskrom Studio (src/woa/selftest.ts). Runs once on the first desktop;
# -Now (the desktop folder's shortcut) runs it again without the wait.
param([switch]$Now)
$ErrorActionPreference = 'Continue'
$Board = (Get-CimInstance Win32_ComputerSystem).Model
$AppVersion = ${psString(o.appVersion)}
$zh = (Get-Culture).Name -like 'zh*'
function T($en, $cn) { if ($zh) { $cn } else { $en } }
if ($Now) { Write-Host (T 'RK3576 self-test: running, about a minute...' 'RK3576 自检：正在运行，大约一分钟...') } else { Start-Sleep -Seconds 90 }

$problems = New-Object System.Collections.Generic.List[string]
$notes = New-Object System.Collections.Generic.List[string]

# 1. Device Manager. Instance IDs are cut after the hardware ID: the rest can hold serial numbers.
$allowed = @('USB\\VID_2C7C&PID_0125&MI_04')
try {
  # Code 22 is a device disabled on purpose; anything else that is not 0 is a warning in Device Manager.
  $bad = Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { ($_.ConfigManagerErrorCode -ne 0 -and $_.ConfigManagerErrorCode -ne 22) -or $_.Status -eq 'Error' -or $_.Status -eq 'Degraded' }
  foreach ($d in $bad) {
    $id = ($d.InstanceId -split '\\\\')[0..1] -join '\\'
    if ($allowed | Where-Object { $id -like "$_*" }) { continue }
    $problems.Add((T "Device: $($d.FriendlyName) [$id], code $($d.ConfigManagerErrorCode)" "设备：$($d.FriendlyName) [$id]，错误代码 $($d.ConfigManagerErrorCode)"))
  }
} catch { $problems.Add((T "Device Manager could not be read: $_" "无法读取设备管理器：$_")) }

# 2. GPU: WDDM 2.0 on the Mali-G52, and its clock.
$gpu = Get-PnpDevice -PresentOnly -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Mali' } | Select-Object -First 1
if (-not $gpu) { $problems.Add((T 'GPU: no Mali display adapter is installed.' 'GPU：没有安装 Mali 显示适配器。')) }
else {
  $dx = Join-Path $env:TEMP 'woa-dxdiag.txt'
  Start-Process -FilePath dxdiag.exe -ArgumentList "/t \`"$dx\`"" -Wait -WindowStyle Hidden
  $model = (Select-String -Path $dx -Pattern 'Driver Model:\\s*(.+)$' -ErrorAction SilentlyContinue | Where-Object { $_.Line -match 'WDDM' } | Select-Object -First 1)
  if (-not $model) { $problems.Add((T 'GPU: dxdiag reports no WDDM driver model.' 'GPU：dxdiag 没有报告 WDDM 驱动模型。')) }
  elseif ($model.Matches[0].Groups[1].Value.Trim() -ne 'WDDM 2.0') { $problems.Add((T "GPU: driver model is $($model.Matches[0].Groups[1].Value.Trim()), expected WDDM 2.0." "GPU：驱动模型是 $($model.Matches[0].Groups[1].Value.Trim())，应为 WDDM 2.0。")) }
  Remove-Item $dx -ErrorAction SilentlyContinue
  $key = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$($gpu.InstanceId)\\Device Parameters\\maliwddm"
  $hz = (Get-ItemProperty -Path $key -Name GpuClkHz -ErrorAction SilentlyContinue).GpuClkHz
  if ($hz -eq $null) { $notes.Add((T 'GPU clock: not reported by this driver build.' 'GPU 频率：此驱动版本不报告。')) }
  elseif ($hz -lt 594000000) { $problems.Add((T "GPU: clock $([math]::Round($hz / 1e6)) MHz, expected at least 594 MHz." "GPU：频率 $([math]::Round($hz / 1e6)) MHz，应至少 594 MHz。")) }
  else { $notes.Add((T "GPU clock: $([math]::Round($hz / 1e6)) MHz." "GPU 频率：$([math]::Round($hz / 1e6)) MHz。")) }
}

# 3. Audio: a working output endpoint.
$out = Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' }
if (-not $out) { $problems.Add((T 'Audio: no working audio output.' '声音：没有可用的音频输出。')) }

# 4. Network.
$up = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }
if (-not $up) { $problems.Add((T 'Network: no network adapter is connected.' '网络：没有已连接的网卡。')) }
else {
  try { Resolve-DnsName github.com -ErrorAction Stop | Out-Null }
  catch { $problems.Add((T 'Network: connected, but names do not resolve (no internet?).' '网络：已连接，但无法解析域名（没有互联网？）。')) }
}

# 5. Storage: write, read back, compare.
try {
  $f = Join-Path $env:SystemDrive 'woa-selftest.bin'
  $data = New-Object byte[] (64MB)
  (New-Object System.Random).NextBytes($data)
  $s = New-Object System.IO.FileStream($f, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, [int]1MB, [System.IO.FileOptions]::WriteThrough)
  $s.Write($data, 0, $data.Length); $s.Flush($true); $s.Close()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $want = [BitConverter]::ToString($sha.ComputeHash($data))
  $got = [BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($f)))
  Remove-Item $f -ErrorAction SilentlyContinue
  if ($want -ne $got) { $problems.Add((T 'Storage: 64 MiB written to the system disk did not read back the same.' '存储：写入系统盘的 64 MiB 读回来不一致。')) }
} catch { $problems.Add((T "Storage: the write test failed: $($_.Exception.Message)" "存储：写入测试失败：$($_.Exception.Message)")) }

# The report, the message box, and the issue link.
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$lines = @("Board: $Board", "Firmware: $($bios.SMBIOSBIOSVersion)", "Windows: $($os.Caption) $($os.Version) build $($os.BuildNumber)", "Maskrom Studio: $AppVersion", '')
$lines += if ($problems.Count) { @('Problems:') + ($problems | ForEach-Object { "- $_" }) } else { @('All checks passed.') }
if ($notes.Count) { $lines += @('', 'Notes:') + ($notes | ForEach-Object { "- $_" }) }
$report = $lines -join "\`r\`n"
try { Set-Content -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'RK3576-selftest.txt') -Value $report -Encoding UTF8 } catch {}
# The whole report is in the message box: opening the .txt needs a working
# Notepad app, which some images do not have (trim.ts, notepadFixCmd).
$where = T "The report is also on the desktop (RK3576-selftest.txt; notepad.exe opens it)." "报告也保存在桌面上（RK3576-selftest.txt；可用 notepad.exe 打开）。"
Add-Type -AssemblyName System.Windows.Forms
if ($problems.Count -eq 0) {
  [System.Windows.Forms.MessageBox]::Show((T "All checks passed: devices, GPU, audio, network and storage." "全部检查通过：设备、GPU、声音、网络和存储。") + "\`r\`n\`r\`n" + $report + "\`r\`n\`r\`n" + $where, (T 'RK3576 self-test' 'RK3576 自检'), 'OK', 'Information') | Out-Null
} else {
  $text = (T "The self-test found problems:" "自检发现问题：") + "\`r\`n\`r\`n" + $report + "\`r\`n\`r\`n" + $where + "\`r\`n\`r\`n" + (T "Open a prefilled problem report on GitHub? Nothing is sent until you submit it there." "要在 GitHub 上打开预先填好的问题报告吗？在那里提交之前不会发送任何内容。")
  $r = [System.Windows.Forms.MessageBox]::Show($text, (T 'RK3576 self-test' 'RK3576 自检'), 'YesNo', 'Warning')
  if ($r -eq 'Yes') {
    $body = $report
    if ($body.Length -gt 6000) { $body = $body.Substring(0, 6000) }
    $title = "Self-test: $($problems.Count) problem(s) on $Board"
    $url = '${ISSUES_URL}?title=' + [uri]::EscapeDataString($title) + '&body=' + [uri]::EscapeDataString($body)
    Start-Process $url
  }
}
`;
}
