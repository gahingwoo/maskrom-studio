import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { certBlob, certsCmd, isSelfSigned, pkcs7Certificates, trustedCerts } from '../src/woa/certs';
import { accountProblem, encodePassword, setupComplete, sshKeyProblem, unattendXml, type Account } from '../src/woa/setup-files';
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

describe('SetupComplete.cmd and SSH', () => {
  it('registers sshd from Program Files, opens port 22 on the private and domain profiles, locks the key file down, removes the answer file', () => {
    const s = setupComplete({ skipSetup: null, ssh: true, sshKey: '' });
    expect(s).toContain('install-sshd.ps1');
    expect(s).toContain('localport=22 profile=private,domain');
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
