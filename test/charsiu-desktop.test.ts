// Charsiu Desktop on the installed Windows (src/woa/charsiu-desktop.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CHARSIU_DESKTOP, CHARSIU_FILE, CHARSIU_PINNED, CHARSIU_REPO, CHARSIU_SETUP_ASSET, CHARSIU_SETUP_PATH, charsiuFromRelease, charsiuGenerated, charsiuRunOnce, charsiuScript, chooseCharsiu } from '../src/woa/charsiu-desktop';
import { parseSums, releaseAsset, type GithubRelease } from '../src/woa/releases';
import { pickRelease } from '../src/shared/channel';
import { DEFAULT_SETUP, setupComplete } from '../src/woa/setup-files';
import { CONFIGURE } from '../src/woa/stage-scripts';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'releases-0.5.0.json'), 'utf8')) as { charsiu: GithubRelease; charsiuSums: string };
// The ci pre-release, recorded: named and checksummed the way every release from v0.3.1 on is.
const ci = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'charsiu-desktop-ci.json'), 'utf8')) as { release: GithubRelease; sums: string };
/** That record as the stable v0.3.1 would look: the same files under the tag's names (derived, not recorded). */
function asStable(tag: string): GithubRelease {
  const v = tag.slice(1);
  const ren = (n: string) => n.replace(/_0\.3\.0_/, `_${v}_`);
  return {
    ...ci.release, tag_name: tag, name: `Charsiu Desktop ${v}`, prerelease: false,
    html_url: `https://github.com/${CHARSIU_REPO}/releases/tag/${tag}`,
    assets: ci.release.assets.map((a) => ({ ...a, name: ren(a.name), browser_download_url: `https://github.com/${CHARSIU_REPO}/releases/download/${tag}/${ren(a.name)}` })),
  };
}
const stableSums = (v: string) => parseSums(ci.sums.replace(/_0\.3\.0_/g, `_${v}_`));

describe('Charsiu Desktop', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETUP.charsiuDesktop).toBe(true);
  });

  it('pins the arm64 installer of the stable release as GitHub publishes it', () => {
    expect(fx.charsiu.prerelease).toBe(false);
    expect(fx.charsiu.tag_name).toBe(CHARSIU_DESKTOP.tag);
    const a = fx.charsiu.assets.find((x) => x.name === CHARSIU_DESKTOP.file)!;
    expect(a.browser_download_url).toBe(CHARSIU_DESKTOP.url);
    expect(a.size).toBe(CHARSIU_DESKTOP.size);
    expect(a.digest).toBe(`sha256:${CHARSIU_DESKTOP.sha256}`);
    expect(CHARSIU_DESKTOP.url.startsWith(`https://github.com/${CHARSIU_REPO}/releases/download/${CHARSIU_DESKTOP.tag}/`)).toBe(true);
    // Only the desktop app: no CLI, no model.
    expect(CHARSIU_DESKTOP.file).toMatch(/^Charsiu\.Desktop_[\d.]+_arm64-setup\.exe$/);
  });

  it('is pinned because the release\'s SHA256SUMS.txt is older than its files', () => {
    // If this starts passing, the release was fixed and the installer could be read from it like the others.
    expect(releaseAsset(fx.charsiu, parseSums(fx.charsiuSums), CHARSIU_DESKTOP.file)).toMatch(/disagree/);
  });

  it('reads the installer from a release named and checksummed by package.sh (recorded ci release)', () => {
    const got = charsiuFromRelease(ci.release, parseSums(ci.sums));
    expect(typeof got).not.toBe('string');
    const a = ci.release.assets.find((x) => CHARSIU_SETUP_ASSET.test(x.name))!;
    expect(got).toEqual({ tag: 'ci', file: a.name, url: a.browser_download_url, size: a.size, sha256: a.digest!.slice(7), from: 'release' });
    expect(a.name).toBe('charsiu-desktop_0.3.0_arm64-setup.exe');
  });

  it('refuses a release whose checksums are missing or disagree', () => {
    expect(charsiuFromRelease(ci.release, new Map())).toMatch(/SHA256SUMS\.txt does not list/);
    const name = ci.release.assets.find((x) => CHARSIU_SETUP_ASSET.test(x.name))!.name;
    expect(charsiuFromRelease(ci.release, new Map([[name, '0'.repeat(64)]]))).toMatch(/disagree/);
    // v0.3.0: Charsiu.Desktop_ names and a stale SHA256SUMS.txt
    expect(charsiuFromRelease(fx.charsiu, parseSums(fx.charsiuSums))).toMatch(/has no charsiu-desktop_/);
  });

  it('uses the pin until a stable release checks out, then the release', () => {
    // today: the stable tier is v0.3.0, which is refused, so the pin
    const now = [fx.charsiu, ci.release];
    const rel = pickRelease(now, 'stable')!;
    expect(rel.tag_name).toBe('v0.3.0');
    const today = chooseCharsiu(charsiuFromRelease(rel, parseSums(fx.charsiuSums)));
    expect(today.installer).toEqual(CHARSIU_PINNED);
    expect(today.installer.url).toBe(CHARSIU_DESKTOP.url);
    expect(today.why).toMatch(/v0\.3\.0/);
    expect(chooseCharsiu(null).installer).toEqual(CHARSIU_PINNED);
    expect(chooseCharsiu('GitHub answered 403').why).toBe('GitHub answered 403');
    // once v0.3.1 is out: the stable tier picks it and its installer is used
    const later = [fx.charsiu, ci.release, asStable('v0.3.1')];
    const r2 = pickRelease(later, 'stable')!;
    expect(r2.tag_name).toBe('v0.3.1');
    const next = chooseCharsiu(charsiuFromRelease(r2, stableSums('0.3.1')));
    expect(next.why).toBeNull();
    expect(next.installer).toMatchObject({ tag: 'v0.3.1', file: 'charsiu-desktop_0.3.1_arm64-setup.exe', from: 'release',
      url: `https://github.com/${CHARSIU_REPO}/releases/download/v0.3.1/charsiu-desktop_0.3.1_arm64-setup.exe` });
  });

  it('runs at the first sign-in, not in SetupComplete.cmd: it installs per user', () => {
    const sc = setupComplete({ skipSetup: null, ssh: false, sshKey: '', charsiuDesktop: true });
    expect(sc).toContain(charsiuRunOnce()[1]);
    expect(sc).toContain(`\\CurrentVersion\\RunOnce" /v WoaCharsiuDesktop /t REG_SZ /d "cmd.exe /c if exist %WINDIR%\\Sysnative\\cmd.exe (%WINDIR%\\Sysnative\\cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File %WINDIR%\\Setup\\Scripts\\${CHARSIU_FILE}) else (powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File %WINDIR%\\Setup\\Scripts\\${CHARSIU_FILE})"`);
    expect(sc).not.toMatch(/charsiu-desktop-setup\.exe/);
    expect(setupComplete({ skipSetup: null, ssh: false, sshKey: '' })).not.toMatch(/Charsiu/i);
  });

  it('is copied into the new Windows by the install script, after the hives are unloaded', () => {
    const at = (s: string) => CONFIGURE.indexOf(s);
    const copy = 'copy /y "%STAGE%\\charsiu\\charsiu-desktop-setup.exe" "W:\\ProgramData\\Maskrom Studio\\charsiu-desktop-setup.exe"';
    expect(at(copy)).toBeGreaterThan(at('reg unload HKLM\\WOAOFF'));
    expect(CONFIGURE).toContain(`copy /y "%STAGE%\\${CHARSIU_FILE}" W:\\Windows\\Setup\\Scripts\\${CHARSIU_FILE}`);
    expect(CHARSIU_SETUP_PATH).toBe('charsiu/charsiu-desktop-setup.exe');
  });

  it('checks the installer\'s SHA-256 on the board, runs it silently and cleans up', () => {
    const s = charsiuScript('AB'.repeat(32));
    expect(s).toContain(`$Want = '${'ab'.repeat(32)}'`);
    expect(s).toContain("Get-FileHash -LiteralPath $Setup -Algorithm SHA256");
    expect(s).toContain("-ArgumentList '/S' -Wait");
    expect(s).toContain('Remove-Item -LiteralPath $Setup');
    expect(s).toContain('Remove-Item -LiteralPath $PSCommandPath');
    // "$name:" in a PowerShell string is a drive-qualified variable, an error; only $env: is meant.
    expect(s.replace(/\$env:/g, '')).not.toMatch(/\$\w+:/);
    expect(s).not.toMatch(/[\u2013\u2014]/);
  });

  it('writes the script for the installer that is staged, with that file\'s SHA-256', () => {
    expect(charsiuGenerated([])).toEqual([]);
    expect(charsiuGenerated([{ path: CHARSIU_SETUP_PATH, data: new Uint8Array(0) }])).toEqual([]);
    const data = new Uint8Array(4096).fill(7);
    const g = charsiuGenerated([{ path: 'openssh/sshd.exe', data: new Uint8Array(1) }, { path: CHARSIU_SETUP_PATH, data }]);
    expect(g.map((f) => f.name)).toEqual([CHARSIU_FILE]);
    expect(g[0].text).toContain(bytesToHex(sha256(data)));
  });
});
