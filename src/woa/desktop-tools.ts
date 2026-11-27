// The "RK3576 Tools" folder on the Public Desktop of the installed Windows
// (user decision 2026-11-26): shortcuts only, so deleting the folder breaks
// nothing. The real files stay in \Windows\Setup\Scripts (the scripts below
// and the self-test), \Program Files\RK3576 (the RK3576 tools bundle) and
// \Program Files\OpenSSH.
//
// SetupComplete.cmd runs woa-desktop-tools.ps1 once as SYSTEM, after the
// RK3576 tools' first-boot step and the browser switch cleanup. It names the
// folder and the shortcuts in the Windows display language (Chinese for
// zh-*, English otherwise) and adds a shortcut only when what it points to
// is there. An administrator can run it again to bring the folder back.
//
// The scripts the shortcuts start:
//   woa-diag.ps1               collect diagnostics, read only, into a dated
//                              .txt on the desktop of whoever started it
//   woa-ssh-fix.ps1            register sshd if it is missing, make it
//                              automatic, start it, port 22 on every profile
// The SSH fix elevates itself (UAC); the diagnostics
// elevate too, for bcdedit and the driver list.
//
// Written for Windows PowerShell 5.1, saved with a UTF-8 BOM (5.1 reads a
// file without one as the ANSI code page and mangles the Chinese text).

export const DESKTOP_TOOLS_FILE = 'woa-desktop-tools.ps1';
export const DIAG_FILE = 'woa-diag.ps1';
export const SSH_FIX_FILE = 'woa-ssh-fix.ps1';
/** Every script this file writes, in the order they are staged. */
export const DESKTOP_SCRIPT_FILES = [DESKTOP_TOOLS_FILE, DIAG_FILE, SSH_FIX_FILE] as const;

/** The firewall rule's display name, the same in SetupComplete.cmd and the fix script. */
export const SSH_RULE = 'OpenSSH Server (sshd)';

export type ToolsLang = 'en' | 'zh-CN';

export const DESKTOP_FOLDER: Record<ToolsLang, string> = { en: 'RK3576 Tools', 'zh-CN': 'RK3576 工具' };

const DOCS = 'https://github.com/gahingwoo/maskrom-studio/blob/main/docs';
const WOA_DOCS = 'https://github.com/gahingwoo/woa-rk3576/blob/main/docs';

export interface DesktopEntry {
  id: 'selftest' | 'monitor' | 'drivers' | 'diag' | 'ssh' | 'docs';
  name: Record<ToolsLang, string>;
  desc: Record<ToolsLang, string>;
  /** A .lnk (target and arguments are PowerShell expressions) or a .url. */
  kind: 'lnk' | 'url';
  target?: string;
  args?: string;
  url?: Record<ToolsLang, string>;
  /** A PowerShell condition; the shortcut is made only when it holds. */
  when?: string;
}

const psFile = (file: string, extra = '') => `('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Scripts '${file}') + '"${extra}')`;

/** The folder's contents, in the order they are made. */
export const DESKTOP_ENTRIES: DesktopEntry[] = [
  {
    id: 'selftest', kind: 'lnk',
    name: { en: 'Self-test', 'zh-CN': '自检' },
    desc: { en: 'Run the RK3576 self-test again and show the report', 'zh-CN': '重新运行 RK3576 自检并显示报告' },
    target: '$Ps', args: psFile('woa-selftest.ps1', ' -Now'),
    when: "Test-Path (Join-Path $Scripts 'woa-selftest.ps1')",
  },
  {
    id: 'monitor', kind: 'lnk',
    name: { en: 'RK3576 Monitor', 'zh-CN': 'RK3576 监视器' },
    desc: { en: 'CPU, GPU and NPU use and the temperatures', 'zh-CN': 'CPU、GPU、NPU 占用和温度' },
    target: "(Join-Path $Rk 'rk-monitor.exe')",
    when: "Test-Path (Join-Path $Rk 'rk-monitor.exe')",
  },
  {
    // Neither the RK3576 tools nor the driver package leave an installer on
    // the board (the package is added with DISM in WinPE), so: the guide.
    id: 'drivers', kind: 'url',
    name: { en: 'Drivers, install and update', 'zh-CN': '驱动安装与更新' },
    desc: { en: 'How to add or update a driver', 'zh-CN': '如何安装或更新驱动' },
    url: { en: `${WOA_DOCS}/drivers.md`, 'zh-CN': `${WOA_DOCS}/drivers.zh-CN.md` },
  },
  {
    id: 'diag', kind: 'lnk',
    name: { en: 'Collect diagnostics', 'zh-CN': '收集诊断信息' },
    desc: { en: 'Write a diagnostics report to the desktop (changes nothing)', 'zh-CN': '把诊断报告写到桌面（不做任何修改）' },
    target: '$Ps', args: psFile(DIAG_FILE),
    when: `Test-Path (Join-Path $Scripts '${DIAG_FILE}')`,
  },
  {
    id: 'ssh', kind: 'lnk',
    name: { en: 'Fix SSH', 'zh-CN': '修复 SSH' },
    desc: { en: 'Register and start the OpenSSH server, open port 22 on every network', 'zh-CN': '注册并启动 OpenSSH 服务器，在所有网络上开放 22 端口' },
    target: '$Ps', args: psFile(SSH_FIX_FILE),
    when: `(Test-Path (Join-Path $Ssh 'install-sshd.ps1')) -and (Test-Path (Join-Path $Scripts '${SSH_FIX_FILE}'))`,
  },
  {
    id: 'docs', kind: 'url',
    name: { en: 'User guide', 'zh-CN': '使用说明' },
    desc: { en: 'Maskrom Studio user guide', 'zh-CN': 'Maskrom Studio 使用说明' },
    url: { en: `${DOCS}/use.md`, 'zh-CN': `${DOCS}/zh-CN/use.md` },
  },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** What the folder gets in one language: [file name, what it opens]. For the tests and the docs. */
export function desktopListing(lang: ToolsLang): Array<{ file: string; opens: string }> {
  return DESKTOP_ENTRIES.map((e) => ({
    file: `${e.name[lang]}.${e.kind}`,
    opens: e.kind === 'url' ? e.url![lang] : `${e.target}${e.args ? ` ${e.args}` : ''}`,
  }));
}

function entryLines(lang: ToolsLang): string[] {
  return DESKTOP_ENTRIES.map((e) => {
    const make = e.kind === 'url'
      ? `Url ${q(e.name[lang])} ${q(e.url![lang])}`
      : `Lnk ${q(e.name[lang])} ${e.target} ${e.args ?? "''"} ${q(e.desc[lang])}`;
    return e.when ? `  if (${e.when}) { ${make} }` : `  ${make}`;
  });
}

const BOM = '﻿';

/** The admin check and the UAC relaunch, for the scripts that need it. $Extra: more arguments for the relaunch. */
const ELEVATE = String.raw`function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Invoke-Elevated([string]$Extra) {
  $a = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' + $Extra
  try { Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $a -ErrorAction Stop }
  catch { Write-Host (T 'Administrator rights were not given; nothing was done.' '没有获得管理员权限，未做任何操作。'); Start-Sleep -Seconds 5 }
  exit
}`;

const LANG = String.raw`$zh = (Get-UICulture).Name -like 'zh*'
function T($en, $cn) { if ($zh) { $cn } else { $en } }`;

/** woa-desktop-tools.ps1: makes the folder. Run once as SYSTEM by SetupComplete.cmd. */
export function desktopToolsScript(): string {
  return `${BOM}# Written by Maskrom Studio (src/woa/desktop-tools.ts). SetupComplete.cmd runs it
# once as SYSTEM; an administrator may run it again to bring the folder back.
# It makes the "${DESKTOP_FOLDER.en}" folder on the Public Desktop, shortcuts only.
param([string]$Lang = '')
$ErrorActionPreference = 'Continue'
if ($Lang -ne 'en' -and $Lang -ne 'zh-CN') { if ((Get-UICulture).Name -like 'zh*') { $Lang = 'zh-CN' } else { $Lang = 'en' } }
$Scripts = Join-Path $env:WINDIR 'Setup\\Scripts'
$Rk = Join-Path $env:ProgramFiles 'RK3576'
$Ssh = Join-Path $env:ProgramFiles 'OpenSSH'
$Ps = Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$Desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
if ($Lang -eq 'zh-CN') { $Name = ${q(DESKTOP_FOLDER['zh-CN'])} } else { $Name = ${q(DESKTOP_FOLDER.en)} }
$Folder = Join-Path $Desktop $Name
New-Item -ItemType Directory -Force -Path $Folder | Out-Null
$Shell = New-Object -ComObject WScript.Shell
function Lnk([string]$name, [string]$target, [string]$arguments, [string]$desc) {
  $s = $Shell.CreateShortcut((Join-Path $Folder ($name + '.lnk')))
  $s.TargetPath = $target
  if ($arguments) { $s.Arguments = $arguments }
  $s.WorkingDirectory = Split-Path -Parent $target
  $s.Description = $desc
  $s.Save()
  Write-Output "shortcut: $name"
}
function Url([string]$name, [string]$url) {
  Set-Content -LiteralPath (Join-Path $Folder ($name + '.url')) -Value @('[InternetShortcut]', ('URL=' + $url)) -Encoding ASCII
  Write-Output "link: $name"
}
if ($Lang -eq 'zh-CN') {
${entryLines('zh-CN').join('\n')}
} else {
${entryLines('en').join('\n')}
}
Write-Output "desktop folder: $Folder"
`;
}

/** woa-diag.ps1: read-only diagnostics into RK3576-diag-<time>.txt on the desktop. */
export function diagScript(): string {
  return `${BOM}# Written by Maskrom Studio (src/woa/desktop-tools.ts). Collects diagnostics and
# writes them to RK3576-diag-<date>-<time>.txt on the desktop. It changes nothing.
# It asks for administrator rights (bcdedit and the driver list need them).
param([string]$OutDir = '')
$ErrorActionPreference = 'Continue'
${LANG}
${ELEVATE}
if (-not $OutDir) { $OutDir = [Environment]::GetFolderPath('Desktop') }
if (-not (Test-Admin)) { Invoke-Elevated (' -OutDir "' + $OutDir + '"') }
Write-Host (T 'Collecting diagnostics, about a minute...' '正在收集诊断信息，大约一分钟...')
$out = New-Object System.Collections.Generic.List[string]
function Section([string]$title, [scriptblock]$what) {
  Write-Host "  $title"
  $out.Add('')
  $out.Add("===== $title")
  try { $out.Add((& $what 2>&1 | Out-String -Width 220).TrimEnd()) }
  catch { $out.Add("(failed: $($_.Exception.Message))") }
}
Section 'System' {
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $bios = Get-CimInstance Win32_BIOS
  "Time: $(Get-Date -Format s)"
  "Board: $($cs.Manufacturer) $($cs.Model)"
  "Firmware: $($bios.SMBIOSBIOSVersion)"
  "Windows: $($os.Caption) $($os.Version) build $($os.BuildNumber)"
  "Memory: $([math]::Round($cs.TotalPhysicalMemory / 1MB)) MB"
  "Up since: $($os.LastBootUpTime)"
}
Section 'Network adapters' { Get-NetAdapter | Format-Table -AutoSize Name, InterfaceDescription, Status, LinkSpeed, MediaConnectionState, DriverVersion }
Section 'Network profiles (Public blocks what only Private and Domain allow)' { Get-NetConnectionProfile | Format-Table -AutoSize Name, InterfaceAlias, NetworkCategory, IPv4Connectivity }
Section 'ipconfig /all' { ipconfig.exe /all }
Section 'Network statistics' { Get-NetAdapterStatistics | Format-Table -AutoSize Name, ReceivedBytes, ReceivedUnicastPackets, SentBytes, SentUnicastPackets, ReceivedDiscardedPackets, OutboundDiscardedPackets }
Section 'Devices with a problem' {
  Get-PnpDevice -PresentOnly | Where-Object { $_.ConfigManagerErrorCode -ne 0 -or $_.Status -eq 'Error' -or $_.Status -eq 'Degraded' } | Format-Table -AutoSize Status, Class, FriendlyName, ConfigManagerErrorCode, InstanceId
}
Section 'Third-party drivers (pnputil /enum-drivers)' { pnputil.exe /enum-drivers }
Section 'Display adapters' { Get-CimInstance Win32_VideoController | Format-List Name, Status, DriverVersion, DriverDate, VideoModeDescription, PNPDeviceID }
Section 'Thermal zones' {
  # The performance counter class, not MSAcpi_ThermalZoneTemperature, which stays at its first value on these boards.
  Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object { '{0}: {1:N1} C' -f $_.Name, ($_.HighPrecisionTemperature / 10 - 273.15) }
}
Section 'OpenSSH server' {
  Get-Service sshd, ssh-agent -ErrorAction SilentlyContinue | Format-Table -AutoSize Name, Status, StartType
  sc.exe qc sshd
  'Listening on port 22:'
  Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | Format-Table -AutoSize LocalAddress, LocalPort, OwningProcess
  'Inbound firewall rules for TCP 22:'
  Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | Where-Object { $_.Protocol -eq 'TCP' -and $_.LocalPort -contains '22' } | Get-NetFirewallRule | Format-Table -AutoSize Name, DisplayName, Enabled, Direction, Action, Profile
}
Section 'bcdedit /enum all' { bcdedit.exe /enum all }
Section 'First start log (woa-setupcomplete.log)' {
  $f = Join-Path $env:WINDIR 'Logs\\woa-setupcomplete.log'
  if (Test-Path $f) { Get-Content $f } else { "no $f" }
}
$file = Join-Path $OutDir ('RK3576-diag-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$header = @('RK3576 diagnostics, written by Maskrom Studio''s ' + $MyInvocation.MyCommand.Name + '.', 'It holds this board''s addresses and device IDs: check it before you post it anywhere.')
Set-Content -LiteralPath $file -Value ($header + $out) -Encoding UTF8
Write-Host (T "Saved: $file" "已保存：$file")
Start-Process explorer.exe -ArgumentList ('/select,"' + $file + '"')
Start-Sleep -Seconds 3
`;
}

/** woa-ssh-fix.ps1: sshd registered, automatic, running, and TCP 22 open on every profile. */
export function sshFixScript(): string {
  return `${BOM}# Written by Maskrom Studio (src/woa/desktop-tools.ts). Makes the OpenSSH server work:
# registers sshd from Program Files\\OpenSSH when it is missing, sets it to start
# automatically, starts it, and opens TCP 22 on every network profile (a first
# network is often Public, which a Private/Domain rule does not cover).
# Log: %WINDIR%\\Logs\\woa-ssh-fix.log
$ErrorActionPreference = 'Continue'
${LANG}
${ELEVATE}
if (-not (Test-Admin)) { Invoke-Elevated '' }
$Rule = ${q(SSH_RULE)}
$Dir = Join-Path $env:ProgramFiles 'OpenSSH'
Start-Transcript -Path (Join-Path $env:WINDIR 'Logs\\woa-ssh-fix.log') -Append | Out-Null
$msg = New-Object System.Collections.Generic.List[string]
if (-not (Test-Path (Join-Path $Dir 'install-sshd.ps1'))) {
  $msg.Add((T "OpenSSH is not installed ($Dir\\install-sshd.ps1 is missing). It is installed only when SSH was on in Maskrom Studio." "没有安装 OpenSSH（缺少 $Dir\\install-sshd.ps1）。只有在 Maskrom Studio 中打开 SSH 时才会安装。"))
} else {
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Write-Output 'sshd is not registered: running install-sshd.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'install-sshd.ps1')
    $msg.Add((T 'sshd was not registered: registered it.' 'sshd 未注册：已注册。'))
  }
  try {
    Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
    if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd -ErrorAction Stop; $msg.Add((T 'sshd was stopped: started it.' 'sshd 未运行：已启动。')) }
  } catch { $msg.Add((T "sshd could not be started: $($_.Exception.Message)" "无法启动 sshd：$($_.Exception.Message)")) }
  # Our rule (SetupComplete.cmd), and Microsoft's name for it should one be there.
  $rules = @(Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $Rule -or $_.Name -eq 'OpenSSH-Server-In-TCP' })
  if ($rules.Count) {
    foreach ($r in $rules) {
      if ($r.Profile -ne 'Any' -or $r.Enabled -ne 'True' -or $r.Action -ne 'Allow') {
        $msg.Add((T "Firewall rule '$($r.DisplayName)' was profile $($r.Profile), enabled $($r.Enabled): now every profile, enabled." "防火墙规则 '$($r.DisplayName)' 原为配置文件 $($r.Profile)、启用 $($r.Enabled)：现已对所有配置文件启用。"))
      }
      $r | Set-NetFirewallRule -Profile Any -Enabled True -Action Allow
    }
  } else {
    New-NetFirewallRule -DisplayName $Rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -Profile Any | Out-Null
    $msg.Add((T 'There was no firewall rule for SSH: added one for TCP 22 on every profile.' '没有 SSH 的防火墙规则：已为所有配置文件添加 TCP 22 规则。'))
  }
}
$svc = Get-Service sshd -ErrorAction SilentlyContinue
$listen = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
$status = @(
  ((T 'sshd: ' 'sshd：') + $(if ($svc) { "$($svc.Status), $($svc.StartType)" } else { T 'not registered' '未注册' })),
  ((T 'Listening on port 22: ' '正在监听 22 端口：') + $(if ($listen) { T 'yes' '是' } else { T 'no' '否' })),
  ((T 'Networks: ' '网络：') + ((Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { "$($_.InterfaceAlias) $($_.NetworkCategory)" }) -join ', '))
)
if (-not $msg.Count) { $msg.Add((T 'Nothing needed fixing.' '没有需要修复的地方。')) }
$text = ((@($msg) + @('') + $status) -join "\`r\`n")
Write-Output $text
Stop-Transcript | Out-Null
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($text, (T 'Fix SSH' '修复 SSH'), 'OK', 'Information') | Out-Null
`;
}

/** Every script, by file name, for the staging volume. */
export function desktopScripts(): Array<{ name: string; text: string }> {
  return [
    { name: DESKTOP_TOOLS_FILE, text: desktopToolsScript() },
    { name: DIAG_FILE, text: diagScript() },
    { name: SSH_FIX_FILE, text: sshFixScript() },
  ];
}

/** SetupComplete.cmd lines: make the folder, after the RK3576 tools and the browser switch cleanup. */
export function desktopToolsFirstStart(): string[] {
  const ps = `%WINDIR%\\Setup\\Scripts\\${DESKTOP_TOOLS_FILE}`;
  return [
    'rem The "RK3576 Tools" folder on the Public Desktop, shortcuts only (desktop-tools.ts).',
    `if exist "${ps}" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps}" >> "%LOG%" 2>&1`,
  ];
}
