import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { certBlob, certsCmd, isSelfSigned, pkcs7Certificates, trustedCerts } from '../src/woa/certs';
import { accountProblem, AUTOLOGON_FILE, AUTOLOGON_TASK, autoLogonScript, encodePassword, setupComplete, sshKeyProblem, unattendXml, type Account } from '../src/woa/setup-files';
import { unzip } from '../src/woa/zip';
import { CONFIGURE } from '../src/woa/stage-scripts';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)));

describe('driver certificates', () => {
  it('takes the self-signed test certificate out of a woa-rk3576 driver catalog', () => {
    const certs = trustedCerts([fx('woa-rk3576-0.1.1-dwcsdhc.cat'), fx('woa-rk3576-0.1.1-dwcsdhc.cat')]);
    expect(certs.map((c) => c.thumbprint)).toEqual(['FE74B735711614F79FDC6A0F58348419522857F3']);
    const cmd = certsCmd(certs);
    expect(cmd).toContain('SystemCertificates\\ROOT\\Certificates\\FE74B735711614F79FDC6A0F58348419522857F3');
    expect(cmd).toContain('TrustedPublisher\\Certificates\\FE74B735711614F79FDC6A0F58348419522857F3" /v Blob /t REG_BINARY /d 20000000010000');
  });
  it('reads an openssl PKCS #7 and the blob holds the certificate as property 32', () => {
    const [c] = pkcs7Certificates(fx('self-signed.p7b'));
    expect(isSelfSigned(c)).toBe(true);
    const b = certBlob(c);
    expect(new DataView(b.buffer).getUint32(8, true)).toBe(c.length);
    expect(trustedCerts([fx('self-signed.p7b')])[0].thumbprint).toBe('7017B01308158347BE5C4A213529EF328DD899C5');
  });
  it('skips what does not parse', () => {
    expect(trustedCerts([new Uint8Array([1, 2, 3])])).toEqual([]);
  });
});

describe('the answer file', () => {
  const a: Account = { user: 'woa', password: 'pässword & <x>', computerName: 'TSPI3M', locale: 'zh-CN', keyboard: '', timeZone: 'China Standard Time', autoLogonAlways: false };
  it('encodes the password as Windows SIM does', () => {
    // base64 of UTF-16LE "secretPassword"
    expect(encodePassword('secret')).toBe(Buffer.from('secretPassword', 'utf16le').toString('base64'));
  });
  it('is well-formed, ARM64, has no plain password and hides every OOBE page', () => {
    const x = unattendXml(a);
    expect(x).not.toContain('pässword');
    expect(x).toContain(encodePassword(a.password));
    expect(x.match(/processorArchitecture="arm64"/g)!.length).toBe(3);
    expect(x).toMatch(/<LogonCount>1<\/LogonCount>/);
    expect(x).not.toMatch(/SkipMachineOOBE|SkipUserOOBE|<PlainText>true/);
    for (const h of ['HideEULAPage', 'HideLocalAccountScreen', 'HideOnlineAccountScreens', 'HideWirelessSetupInOOBE', 'HideOEMRegistrationScreen']) expect(x).toContain(`<${h}>true</${h}>`);
    if (spawnSync('python3', ['--version']).status === 0) {
      const out = execFileSync('python3', ['-I', '-c', 'import sys,xml.dom.minidom as m; d=m.parseString(sys.stdin.read()); print(len(d.getElementsByTagName("component")))'], { input: x, encoding: 'utf8' });
      expect(out.trim()).toBe('3');
    }
  });
  it('refuses accounts Windows would not take', () => {
    expect(accountProblem({ ...a, user: 'Administrator' })).toBe('account.user.reserved');
    expect(accountProblem({ ...a, user: 'a/b' })).toBe('account.user.bad');
    expect(accountProblem({ ...a, password: '' })).toBe('account.password.empty');
    expect(accountProblem({ ...a, computerName: 'this-name-is-too-long' })).toBe('account.computer.bad');
    expect(accountProblem(a)).toBeNull();
  });
});

describe('signing in automatically', () => {
  const a: Account = { user: 'woa', password: 'pässword & <x>', computerName: '', locale: '', keyboard: '', timeZone: '', autoLogonAlways: true };
  const utf16 = (s: string) => Buffer.from(s, 'utf16le').toString('base64');
  it('keeps LogonCount 1 in the answer file, so Setup only signs in for the first start', () => {
    expect(unattendXml(a)).toMatch(/<LogonCount>1<\/LogonCount>/);
  });
  it('stores the password as the LSA secret, not in plain text, and turns automatic sign-in on for good', () => {
    const s = autoLogonScript(a);
    expect(s).not.toContain(a.password);
    expect(s).toContain(`FromBase64String('${utf16(a.password)}')`);
    expect(s).toContain('LsaStorePrivateData');
    expect(s).toContain("[WoaLsa]::Store('DefaultPassword', $Password)");
    expect(s).toMatch(/Remove-ItemProperty -Path \$Winlogon -Name AutoLogonCount/);
    expect(s).toMatch(/Remove-ItemProperty -Path \$Winlogon -Name DefaultPassword/);
    expect(s).toContain("-Name AutoAdminLogon -Value '1' -PropertyType String");
    expect(s).toContain("-Name DefaultUserName -Value $User");
    expect(s).toContain("$User = 'woa'");
    expect(s).toContain("-Name DefaultDomainName -Value '.'");
    expect(s).toContain('PasswordLess\\Device');
    expect(s).toContain('-Name DevicePasswordLessBuildVersion -Value 0 -PropertyType DWord');
    // The cleanup cannot be skipped: it is in finally, after errors are made non-fatal.
    const fin = s.slice(s.indexOf('} finally {'));
    expect(fin).toContain("$ErrorActionPreference = 'Continue'");
    expect(fin).toContain('Remove-Item -LiteralPath $PSCommandPath -Force');
    expect(fin).toContain(`schtasks.exe /delete /tn "${AUTOLOGON_TASK}" /f`);
  });
  it('works with an empty password: no secret, an empty DefaultPassword', () => {
    const s = autoLogonScript({ ...a, password: '' });
    expect(s).toContain("FromBase64String('')");
    expect(s).toContain("[WoaLsa]::Store('DefaultPassword', $null)");
    expect(s).toContain("-Name DefaultPassword -Value '' -PropertyType String");
  });
  it('quotes the user name for PowerShell', () => {
    expect(autoLogonScript({ ...a, user: "o'neil" })).toContain("$User = 'o''neil'");
  });
  it('SetupComplete.cmd locks the script down and runs it as SYSTEM after the first sign-in, before the answer file goes', () => {
    const s = setupComplete({ skipSetup: a, ssh: false, sshKey: '' });
    const ps = `%WINDIR%\\Setup\\Scripts\\${AUTOLOGON_FILE}`;
    expect(s).toContain(`icacls "${ps}" /inheritance:r /grant "*S-1-5-18:F" /grant "*S-1-5-32-544:F"`);
    expect(s).toContain(`schtasks.exe /create /f /tn "${AUTOLOGON_TASK}" /sc onlogon /delay 0000:30 /ru SYSTEM /rl highest`);
    expect(s).toContain(`-File ${ps}"`);
    expect(s).toContain(`if errorlevel 1 del /f /q "${ps}"`);
    expect(s).toContain('DevicePasswordLessBuildVersion /t REG_DWORD /d 0');
    expect(s.indexOf(AUTOLOGON_TASK)).toBeLessThan(s.indexOf('del /f /q "%WINDIR%\\Panther\\unattend.xml"'));
    expect(s).toMatch(/RunOnce" \/v WoaUnattendCleanup .*Panther\\unattend\.xml/);
    // A parenthesis in a line inside the if block would end the block early.
    const block = s.slice(s.indexOf(`if exist "${ps}" (`), s.indexOf('\n)\n', s.indexOf(`if exist "${ps}" (`)));
    for (const line of block.split('\n').slice(1)) expect(line).not.toMatch(/[()]/);
  });
  it('the install script copies the script into the new Windows and zeroes the staging copy', () => {
    expect(CONFIGURE).toContain(`copy /y "%STAGE%\\${AUTOLOGON_FILE}" W:\\Windows\\Setup\\Scripts\\${AUTOLOGON_FILE}`);
    expect(CONFIGURE).toContain(`fsutil file setzerodata offset=0 length=1048576 "%STAGE%\\${AUTOLOGON_FILE}"`);
  });
  it('leaves it all out when the option is off', () => {
    expect(setupComplete({ skipSetup: { ...a, autoLogonAlways: false }, ssh: false, sshKey: '' })).not.toContain(AUTOLOGON_FILE);
    expect(setupComplete({ skipSetup: null, ssh: false, sshKey: '' })).not.toContain(AUTOLOGON_TASK);
  });
});

describe('SetupComplete.cmd and SSH', () => {
  it('registers sshd from Program Files, opens port 22 on every profile, locks the key file down, removes the answer file', () => {
    const s = setupComplete({ skipSetup: null, ssh: true, sshKey: '' });
    expect(s).toContain('install-sshd.ps1');
    // A first network is often Public: a Private/Domain rule left port 22 shut on a ROCK 4D (2026-11-26).
    expect(s).toContain('localport=22 profile=any');
    expect(s).not.toMatch(/profile=(private|domain|public)/);
    // A rule of that name from an earlier run is replaced, not doubled, and before the new one is added.
    const del = s.indexOf('netsh advfirewall firewall delete rule name="OpenSSH Server (sshd)"');
    expect(del).toBeGreaterThan(0);
    expect(del).toBeLessThan(s.indexOf('netsh advfirewall firewall add rule name="OpenSSH Server (sshd)"'));
    expect(s).toContain('echo [ssh] firewall rule');
    expect(s).toMatch(/RunOnce" \/v WoaUnattendCleanup .*Panther\\unattend\.xml/);
    expect(s).toContain('/inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F"');
    expect(s).toContain('Panther\\unattend.xml');
    expect(s).not.toMatch(/Add-WindowsCapability/);
    expect(setupComplete({ skipSetup: null, ssh: false, sshKey: '' })).not.toContain('sshd');
  });
  it('syncs the clock at first start and a minute after every start', () => {
    for (const ssh of [true, false]) {
      const s = setupComplete({ skipSetup: null, ssh, sshKey: '' });
      expect(s).toContain('/sc onstart /delay 0001:00 /ru SYSTEM');
      expect(s).toContain('w32tm.exe /resync /force');
    }
  });
  it('reads the RTC as UTC and starts the Windows Time service on its own', () => {
    expect(CONFIGURE).toContain('TimeZoneInformation" /v RealTimeIsUniversal /t REG_DWORD /d 1');
    expect(CONFIGURE).toContain('Services\\W32Time /v Start /t REG_DWORD /d 2');
  });
  it('checks a public key', () => {
    expect(sshKeyProblem('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq user@host')).toBeNull();
    expect(sshKeyProblem('hello')).toBe('ssh.key.bad');
    expect(sshKeyProblem('')).toBeNull();
  });
});

describe('zip', () => {
  it('reads stored and deflated entries', () => {
    // A zip made here with two entries: one stored, one deflated.
    const name = (s: string) => Buffer.from(s);
    const entries = [{ n: 'OpenSSH-ARM64/a.txt', d: Buffer.from('hello'), m: 0 }, { n: 'OpenSSH-ARM64/b.bin', d: Buffer.alloc(5000, 7), m: 8 }];
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let off = 0;
    for (const e of entries) {
      const data = e.m === 8 ? deflateRawSync(e.d) : e.d;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(e.m, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.d.length, 22); lh.writeUInt16LE(e.n.length, 26);
      parts.push(lh, name(e.n), data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.m, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.d.length, 24); ch.writeUInt16LE(e.n.length, 28); ch.writeUInt32LE(off, 42);
      central.push(ch, name(e.n));
      off += 30 + e.n.length + data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    const z = new Uint8Array(Buffer.concat([...parts, cd, end]));
    const got = unzip(z, (d) => new Uint8Array(inflateRawSync(d)));
    expect(got.map((g) => [g.path, g.data.length])).toEqual([['OpenSSH-ARM64/a.txt', 5], ['OpenSSH-ARM64/b.bin', 5000]]);
  });
});
