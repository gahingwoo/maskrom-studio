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
  /** Sign in by itself on every start, not only the first. */
  autoLogonAlways: boolean;
}

export interface SetupOptions {
  /** null: Windows' own setup on the first start (BypassNRO lets it finish offline). */
  skipSetup: Account | null;
  ssh: boolean;
  /** An OpenSSH public key line for administrators_authorized_keys, or empty. */
  sshKey: string;
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
${a.autoLogonAlways ? '' : '        <LogonCount>1</LogonCount>\n'}        <Password>
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
      'netsh advfirewall firewall add rule name="OpenSSH Server (sshd)" dir=in action=allow protocol=TCP localport=22 profile=any >> "%LOG%" 2>&1',
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
  l.push(
    'rem The answer file holds the password (encoded, not encrypted): remove every copy.',
    'del /f /q "%WINDIR%\\Panther\\unattend.xml" 2>nul',
    'del /f /q "%WINDIR%\\Panther\\Unattend\\unattend.xml" 2>nul',
    'del /f /q "%WINDIR%\\System32\\Sysprep\\unattend.xml" 2>nul',
    'echo done >> "%LOG%"',
  );
  return `${l.join('\n')}\n`;
}
