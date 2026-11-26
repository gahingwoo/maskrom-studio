// How the installed Windows comes out: the first-start choice (Windows'
// own setup, or none at all with a local administrator made from what the
// user typed), and the OpenSSH server for debugging.
//
// Skipping setup uses an answer file at \Windows\Panther\unattend.xml, which
// Windows reads on its first start (the "implicit" location). It has only an
// oobeSystem and a specialize pass: the OOBE pages hidden (HideEULAPage,
// HideLocalAccountScreen, HideOnlineAccountScreens, HideWirelessSetupInOOBE,
// HideOEMRegistrationScreen, ProtectYourPC 3; SkipMachineOOBE and
// SkipUserOOBE are deprecated and not used), one local account in
// Administrators, AutoLogon once (or on every start, if asked), and the
// optional computer name, languages and time zone. Components carry
// processorArchitecture="arm64", without which an ARM64 Windows ignores them.
//
// Signing in automatically on every start ("Sign in automatically"): the
// answer file's AutoLogon keeps LogonCount 1 either way (Microsoft's
// reference says LogonCount must be given with AutoLogon). LogonCount
// becomes Winlogon's AutoLogonCount, which Winlogon counts down at each
// automatic sign-in and, when it runs out, sets AutoAdminLogon to 0 and
// drops the stored password. So the lasting setting is written after the
// first sign-in, when Setup is done with Winlogon: SetupComplete.cmd makes
// a SYSTEM scheduled task that runs woa-autologon.ps1 once at that sign-in.
// The script deletes AutoLogonCount (nothing counts down any more), stores
// the password as the LSA secret DefaultPassword (LsaStorePrivateData, as
// Sysinternals Autologon does) instead of the plain-text Winlogon
// DefaultPassword value, which it deletes, sets AutoAdminLogon 1,
// DefaultUserName and DefaultDomainName ".", and turns off Windows 11's
// "only Windows Hello for Microsoft accounts" (DevicePasswordLessBuildVersion
// 0), which hides password sign-in. An empty password needs no secret:
// DefaultPassword is then an empty value, since Winlogon turns
// AutoAdminLogon off when it finds no password at all. Then the script
// deletes its task and itself.
//
// Passwords are written as Windows' own answer file tools write them:
// PlainText false, the value base64 of UTF-16LE (password + "Password").
// That is an encoding, not encryption, so SetupComplete.cmd deletes the
// answer file once setup is done, and the install script zeroes it on the
// staging volume.
//
// OpenSSH: the Win32-OpenSSH release zip (pinned below), unpacked by the
// install script straight into \Program Files\OpenSSH of the new Windows so
// the files inherit that folder's permissions (moving them from %TEMP% kept
// Temp's ACL and broke sshd's privilege-separated child on this board), then
// registered on the first start by SetupComplete.cmd with the release's
// install-sshd.ps1. Add-WindowsCapability OpenSSH.Server hung for over 20
// minutes on a fresh install here and is not used. The default shell stays
// sshd's default, cmd.exe.

import { selfTestRunOnce } from './selftest';
import type { LayoutChoice } from './windows-layout';
import { chromeFirstStart, type TrimOptions } from './trim';
import { browserGpuFirstStart } from './browser-gpu';

export const OPENSSH = {
  version: '9.5.0.0p1-Beta',
  file: 'OpenSSH-ARM64.zip',
  url: 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/v9.5.0.0p1-Beta/OpenSSH-ARM64.zip',
  size: 4090699,
  sha256: 'e6a7e39266485eb98ce5396c61a9931e7826502c71bf5234dfdda5bee3882f23',
  /** The folder the zip holds its files in. */
  root: 'OpenSSH-ARM64/',
};

export interface Account {
  user: string;
  password: string;
  computerName: string;
  /** A language tag such as en-US or zh-CN; empty keeps the image's. */
  locale: string;
  /** Input locale, such as en-US or 0409:00000409; empty follows `locale`. */
  keyboard: string;
  /** A Windows time zone ID such as "China Standard Time"; empty keeps the image's. */
  timeZone: string;
  /** Sign in automatically on every start, not only the first. */
  autoLogonAlways: boolean;
}

export interface SetupOptions {
  /** null: Windows' own setup on the first start (BypassNRO lets it finish offline). */
  skipSetup: Account | null;
  ssh: boolean;
  /** An OpenSSH public key line for administrators_authorized_keys, or empty. */
  sshKey: string;
  /** How the disk is shared after a staged install (windows-layout.ts); absent: Windows takes all of it. */
  layout?: LayoutChoice;
  /** What is trimmed while Windows is installed (trim.ts); absent: nothing. */
  trim?: TrimOptions;
  /** Install the RK3576 tools bundle (rk-monitor, NPU tools) from the woa-rk3576 release. */
  rkTools?: boolean;
  /**
   * Edge, Chrome and WebView2 on the GPU at WDDM 2.x (browser-gpu.ts): on
   * unless false. Turned off on the board, not here: the script's Mode switch.
   */
  browserGpu?: boolean;
  /**
   * Armbian goes onto an SD card in the same job (WoaBoard.hybrid 'nvme-and-sd'):
   * WinPE says at the end how to start it. Nothing else changes.
   */
  armbianOnSd?: boolean;
}

export const DEFAULT_SETUP: SetupOptions = { skipSetup: null, ssh: true, sshKey: '' };

/** Why an account cannot be used, or null. Messages are keys for the page's translations. */
export function accountProblem(a: Account): string | null {
  if (!a.user) return 'account.user.empty';
  if (a.user.length > 20 || /["/\\[\]:;|=,+*?<>@%]/.test(a.user) || /^\.+$|^\s|\s$/.test(a.user)) return 'account.user.bad';
  if (/^(administrator|guest|defaultaccount|wdagutilityaccount|system)$/i.test(a.user)) return 'account.user.reserved';
  if (!a.password) return 'account.password.empty';
  if (a.password.length > 127 || /[\r\n]/.test(a.password)) return 'account.password.bad';
  if (a.computerName && (!/^[A-Za-z0-9-]{1,15}$/.test(a.computerName) || /^\d+$/.test(a.computerName))) return 'account.computer.bad';
  if (a.locale && !/^[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Z]{2})?$/.test(a.locale)) return 'account.locale.bad';
  if (a.keyboard && !/^([a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Z]{2})?|[0-9a-fA-F]{4}:[0-9a-fA-F]{8})$/.test(a.keyboard)) return 'account.keyboard.bad';
  if (a.timeZone && !/^[A-Za-z0-9 ().+-]{2,64}$/.test(a.timeZone)) return 'account.timezone.bad';
  return null;
}

export function sshKeyProblem(k: string): string | null {
  if (!k.trim()) return null;
  if (/[\r\n]/.test(k.trim())) return 'ssh.key.oneline';
  if (!/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/.test(k.trim())) return 'ssh.key.bad';
  return null;
}

export const AUTOLOGON_FILE = 'woa-autologon.ps1';
export const AUTOLOGON_TASK = 'Maskrom Studio automatic sign-in';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The answer file's password encoding (what Windows SIM writes with "Hide sensitive data"). */
export function encodePassword(password: string, suffix = 'Password'): string {
  const s = password + suffix;
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 0xff; b[i * 2 + 1] = s.charCodeAt(i) >> 8; }
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

const COMPONENT = (name: string) => `<component name="${name}" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;

export function unattendXml(a: Account): string {
  const pw = encodePassword(a.password);
  const kb = a.keyboard || a.locale;
  const specialize = a.computerName
    ? `  <settings pass="specialize">
    ${COMPONENT('Microsoft-Windows-Shell-Setup')}
      <ComputerName>${xml(a.computerName)}</ComputerName>
    </component>
  </settings>
` : '';
  const intl = a.locale || kb ? `    ${COMPONENT('Microsoft-Windows-International-Core')}
${kb ? `      <InputLocale>${xml(kb)}</InputLocale>\n` : ''}${a.locale ? `      <SystemLocale>${xml(a.locale)}</SystemLocale>
      <UILanguage>${xml(a.locale)}</UILanguage>
      <UserLocale>${xml(a.locale)}</UserLocale>
` : ''}    </component>
` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by Maskrom Studio. SetupComplete.cmd deletes this file when setup is done. -->
<unattend xmlns="urn:schemas-microsoft-com:unattend">
${specialize}  <settings pass="oobeSystem">
${intl}    ${COMPONENT('Microsoft-Windows-Shell-Setup')}
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>${xml(a.user)}</Username>
        <LogonCount>1</LogonCount>
        <Password>
          <Value>${pw}</Value>
          <PlainText>false</PlainText>
        </Password>
      </AutoLogon>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
${a.timeZone ? `      <TimeZone>${xml(a.timeZone)}</TimeZone>\n` : ''}      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${xml(a.user)}</Name>
            <DisplayName>${xml(a.user)}</DisplayName>
            <Group>Administrators</Group>
            <Password>
              <Value>${pw}</Value>
              <PlainText>false</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
    </component>
  </settings>
</unattend>
`;
}

const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const utf16Base64 = (s: string) => {
  let bin = '';
  for (let i = 0; i < s.length; i++) bin += String.fromCharCode(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  return btoa(bin);
};

/**
 * \Windows\Setup\Scripts\woa-autologon.ps1: automatic sign-in on every
 * start, run once as SYSTEM after the first sign-in (see the top of this
 * file). It holds the password, base64 of UTF-16LE (an encoding, like the
 * answer file's), and deletes itself whatever happens.
 */
export function autoLogonScript(a: Account): string {
  return String.raw`# Written by Maskrom Studio (src/woa/setup-files.ts). Run once as SYSTEM by the
# scheduled task "${AUTOLOGON_TASK}" after the first sign-in.
# It turns on automatic sign-in for good, then deletes the task and itself.
$ErrorActionPreference = 'Stop'
$Log = Join-Path $env:WINDIR 'Logs\woa-autologon.log'
function Log($m) { Add-Content -Path $Log -Value "$(Get-Date -Format s) $m" }
$User = ${psString(a.user)}
$Password = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16Base64(a.password)}'))
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class WoaLsa {
  [StructLayout(LayoutKind.Sequential)]
  struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref LSA_UNICODE_STRING keyName, IntPtr privateData);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const uint POLICY_ALL_ACCESS = 0x000F0FFF;
  const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;
  static LSA_UNICODE_STRING Str(string s) {
    LSA_UNICODE_STRING u = new LSA_UNICODE_STRING();
    u.Buffer = Marshal.StringToHGlobalUni(s);
    u.Length = (ushort)(s.Length * 2);
    u.MaximumLength = (ushort)(s.Length * 2 + 2);
    return u;
  }
  // value null deletes the secret.
  public static void Store(string name, string value) {
    LSA_OBJECT_ATTRIBUTES oa = new LSA_OBJECT_ATTRIBUTES();
    oa.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
    IntPtr policy;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, POLICY_ALL_ACCESS, out policy);
    if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
    LSA_UNICODE_STRING key = Str(name);
    LSA_UNICODE_STRING data = new LSA_UNICODE_STRING();
    IntPtr pData = IntPtr.Zero;
    try {
      if (value != null) {
        data = Str(value);
        pData = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(LSA_UNICODE_STRING)));
        Marshal.StructureToPtr(data, pData, false);
      }
      st = LsaStorePrivateData(policy, ref key, pData);
      if (st != 0 && !(value == null && st == STATUS_OBJECT_NAME_NOT_FOUND)) throw new Win32Exception(LsaNtStatusToWinError(st));
    } finally {
      if (pData != IntPtr.Zero) Marshal.FreeHGlobal(pData);
      if (data.Buffer != IntPtr.Zero) {
        for (int i = 0; i < data.MaximumLength; i++) Marshal.WriteByte(data.Buffer, i, 0);
        Marshal.FreeHGlobal(data.Buffer);
      }
      Marshal.FreeHGlobal(key.Buffer);
      LsaClose(policy);
    }
  }
}
'@
  $Winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  # The answer file's LogonCount: Winlogon would turn automatic sign-in off when it runs out.
  Remove-ItemProperty -Path $Winlogon -Name AutoLogonCount -ErrorAction SilentlyContinue
  if ($Password.Length -gt 0) {
    # The password as the LSA secret DefaultPassword, and not in plain text in the registry.
    [WoaLsa]::Store('DefaultPassword', $Password)
    Remove-ItemProperty -Path $Winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
  } else {
    # No password: no secret, and an empty DefaultPassword so Winlogon keeps AutoAdminLogon on.
    [WoaLsa]::Store('DefaultPassword', $null)
    New-ItemProperty -Path $Winlogon -Name DefaultPassword -Value '' -PropertyType String -Force | Out-Null
  }
  New-ItemProperty -Path $Winlogon -Name DefaultUserName -Value $User -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Winlogon -Name DefaultDomainName -Value '.' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Winlogon -Name AutoAdminLogon -Value '1' -PropertyType String -Force | Out-Null
  # Windows 11 hides password sign-in, and with it automatic sign-in, unless this is 0.
  $Device = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device'
  if (-not (Test-Path $Device)) { New-Item -Path $Device -Force | Out-Null }
  New-ItemProperty -Path $Device -Name DevicePasswordLessBuildVersion -Value 0 -PropertyType DWord -Force | Out-Null
  Log 'automatic sign-in is on for every start'
} catch {
  Log "automatic sign-in could not be set: $($_.Exception.Message)"
} finally {
  # Nothing here may stop the cleanup. No 2>&1 on schtasks: PowerShell 5.1 turns its stderr into errors.
  $ErrorActionPreference = 'Continue'
  $Password = $null
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  schtasks.exe /delete /tn "${AUTOLOGON_TASK}" /f | Out-Null
  Log "script deleted: $(-not (Test-Path -LiteralPath $PSCommandPath)), task deleted: $($LASTEXITCODE -eq 0)"
}
`;
}

/** \Windows\Setup\Scripts\SetupComplete.cmd: runs once as SYSTEM when Windows Setup has finished. */
export function setupComplete(o: SetupOptions): string {
  const l: string[] = [
    '@echo off',
    'rem Written by Maskrom Studio. Windows runs this once, as SYSTEM, when setup is done.',
    'set LOG=%WINDIR%\\Logs\\woa-setupcomplete.log',
    'echo Maskrom Studio first start, %DATE% %TIME% > "%LOG%"',
  ];
  if (o.ssh) {
    l.push(
      'rem OpenSSH server: the release files are already in Program Files\\OpenSSH.',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ProgramFiles%\\OpenSSH\\install-sshd.ps1" >> "%LOG%" 2>&1',
      'sc.exe config sshd start= auto >> "%LOG%" 2>&1',
      'netsh advfirewall firewall add rule name="OpenSSH Server (sshd)" dir=in action=allow protocol=TCP localport=22 profile=private,domain >> "%LOG%" 2>&1',
      'if exist "%ProgramFiles%\\OpenSSH\\administrators_authorized_keys" (',
      '  mkdir "%ProgramData%\\ssh" 2>nul',
      '  move /y "%ProgramFiles%\\OpenSSH\\administrators_authorized_keys" "%ProgramData%\\ssh\\administrators_authorized_keys" >> "%LOG%" 2>&1',
      '  rem Only SYSTEM and Administrators, or sshd ignores the file.',
      '  icacls "%ProgramData%\\ssh\\administrators_authorized_keys" /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F" >> "%LOG%" 2>&1',
      ')',
      'net start sshd >> "%LOG%" 2>&1',
      'sc.exe query sshd >> "%LOG%" 2>&1',
    );
  }
  l.push(
    'rem The clock: the RTC is not to be trusted, so sync over the network a minute',
    'rem after every start. Test-signed drivers are refused while the clock is behind.',
    'schtasks.exe /create /f /tn "WoA RK3576 time sync" /sc onstart /delay 0001:00 /ru SYSTEM /tr "%WINDIR%\\System32\\w32tm.exe /resync /force" >> "%LOG%" 2>&1',
    'w32tm.exe /resync /force >> "%LOG%" 2>&1',
  );
  if (o.trim?.chrome) l.push(...chromeFirstStart());
  if (o.rkTools) {
    l.push(
      'rem The RK3576 tools (woa-rk3576 tools/rk3576-tools): shortcuts, the counters task, counter registration.',
      'if exist "%ProgramFiles%\\RK3576\\setup\\firstboot.cmd" call "%ProgramFiles%\\RK3576\\setup\\firstboot.cmd" >> "%LOG%" 2>&1',
    );
  }
  if (o.browserGpu !== false) l.push(...browserGpuFirstStart());
  l.push(...selfTestRunOnce());
  if (o.skipSetup?.autoLogonAlways) {
    const ps = `%WINDIR%\\Setup\\Scripts\\${AUTOLOGON_FILE}`;
    l.push(
      'rem Automatic sign-in on every start: a task runs the script once, as SYSTEM, half a',
      'rem minute after the first sign-in, when the answer file\'s LogonCount is used up.',
      `if exist "${ps}" (`,
      '  rem It holds the password: only SYSTEM and Administrators may read it.',
      `  icacls "${ps}" /inheritance:r /grant "*S-1-5-18:F" /grant "*S-1-5-32-544:F" >> "%LOG%" 2>&1`,
      '  reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\PasswordLess\\Device" /v DevicePasswordLessBuildVersion /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1',
      `  schtasks.exe /create /f /tn "${AUTOLOGON_TASK}" /sc onlogon /delay 0000:30 /ru SYSTEM /rl highest /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${ps}" >> "%LOG%" 2>&1`,
      '  rem Without the task nothing would delete the script, so delete it now.',
      `  if errorlevel 1 del /f /q "${ps}"`,
      ')',
    );
  }
  l.push(
    'rem The answer file holds the password (encoded, not encrypted): remove every copy.',
    'del /f /q "%WINDIR%\\Panther\\unattend.xml" 2>nul',
    'del /f /q "%WINDIR%\\Panther\\Unattend\\unattend.xml" 2>nul',
    'del /f /q "%WINDIR%\\System32\\Sysprep\\unattend.xml" 2>nul',
    'rem And once more after the first sign-in, in case setup left a copy under Panther after this ran.',
    'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce" /v WoaUnattendCleanup /t REG_SZ /d "cmd.exe /c del /f /q %WINDIR%\\Panther\\unattend.xml %WINDIR%\\Panther\\Unattend\\unattend.xml %WINDIR%\\Panther\\unattend-original.xml %WINDIR%\\System32\\Sysprep\\unattend.xml" /f >> "%LOG%" 2>&1',
    'echo done >> "%LOG%"',
  );
  return `${l.join('\n')}\n`;
}
