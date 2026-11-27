// The Stable tier against the releases as GitHub published them on
// 2026-11-27: edk2-rk3576 0.5.0 (with FEATURES.json) and woa-rk3576 0.5.0.
// test/fixtures/releases-0.5.0.json has the fields the app reads, recorded
// with `gh api repos/gahingwoo/<repo>/releases/tags/0.5.0`.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firmwareRelease, FIRMWARE_REPO, loadFirmwareFeatures, parseSums, tierRelease, WINPE_REPO, winpeRelease, type GithubRelease } from '../src/woa/releases';
import { hasFeature } from '../src/woa/firmware-features';
import { woaBoard } from '../src/woa/boards';
import type { Channel } from '../src/shared/channel';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'releases-0.5.0.json'), 'utf8')) as {
  edk2: GithubRelease; edk2Sums: string; woa: GithubRelease; woaSums: string;
};
const features = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'edk2-0.5.0-features.json')));

const ci: GithubRelease = { tag_name: 'ci', name: 'CI build 1a2b3c4 2026-11-27', prerelease: true, assets: [] };
const older = (tag_name: string, prerelease = false): GithubRelease => ({ tag_name, prerelease, assets: [] });
// As GitHub lists them: by date, the rolling ci release among them, older releases and a pre-release.
const lists: Record<string, GithubRelease[]> = {
  [FIRMWARE_REPO]: [fx.edk2, ci, older('0.4.1'), older('0.4.0'), older('0.3.0-tspi3m.1', true), older('0.2.1')],
  [WINPE_REPO]: [fx.woa, ci, older('0.1.1'), older('0.1.0')],
};
const sums: Record<string, string> = { [FIRMWARE_REPO]: fx.edk2Sums, [WINPE_REPO]: fx.woaSums };

/** GitHub for one repository: the release list, its SHA256SUMS.txt and FEATURES.json. */
const github = (repo: string) => async (url: string) => {
  if (url === `https://api.github.com/repos/${repo}/releases?per_page=50`) return new Response(JSON.stringify(lists[repo]));
  if (url.endsWith('/SHA256SUMS.txt')) return new Response(sums[repo]);
  if (url.endsWith('/FEATURES.json')) return new Response(features as BodyInit);
  return new Response(null, { status: 404 });
};

async function firmwareFor(channel: Channel) {
  const { rel, sums: s } = await tierRelease(FIRMWARE_REPO, channel, github(FIRMWARE_REPO));
  return loadFirmwareFeatures(firmwareRelease(rel, s), rel, s, github(FIRMWARE_REPO));
}

describe('the Stable tier picks the 0.5.0 releases', () => {
  it('edk2-rk3576 0.5.0: an image for every board, checked, and its FEATURES.json read', async () => {
    const fw = await firmwareFor('stable');
    expect(fw.tag).toBe('0.5.0');
    expect(fw.problems).toEqual([]);
    expect(fw.images.tspi3m).toMatchObject({ file: 'TaishanPi3M-emmc-edk2-0.5.0.img', size: 33554432, sha256: 'b7598aa4704a7cb44234eba027824c1820b62ce1fca3bfeddf8cfaa3bc7459b3' });
    expect(fw.images.cm5io?.file).toBe('CM5IO-emmc-edk2-0.5.0.img');
    expect(fw.images.rock4d).toMatchObject({ file: 'ROCK4D-spi-edk2-0.5.0.img', size: 16777216 });
    expect(Object.keys(fw.sdcard).sort()).toEqual(['cm5io', 'tspi3m']);
    expect(fw.features.from).toBe('release');
  });

  it('allows Windows on the ROCK 4D: its 0.5.0 image has ACPI tables', async () => {
    const fw = await firmwareFor('stable');
    // App.tsx refuses Windows only when the release says the image cannot start it.
    expect(hasFeature(fw.features, 'rock4d', 'windows')).toBe(true);
    expect(fw.features.boards.rock4d?.firmwareVersion).toBe('rk3576-ROCK4D-0.5.0');
    expect(woaBoard('rock4d')!.windowsTargets).toContain('nvme');
    for (const b of ['tspi3m', 'cm5io', 'rock4d'] as const) {
      expect(hasFeature(fw.features, b, 'windows'), b).toBe(true);
      expect(hasFeature(fw.features, b, 'armbianOnce'), b).toBe(true);
    }
  });

  it('woa-rk3576 0.5.0: the WinPE image, the driver package and the RK3576 tools, each checked', async () => {
    const { rel, sums: s } = await tierRelease(WINPE_REPO, 'stable', github(WINPE_REPO));
    const pe = winpeRelease(rel, s);
    expect(pe.tag).toBe('0.5.0');
    expect(pe.problems).toEqual([]);
    expect(pe.image).toMatchObject({ file: 'woa-rk3576-winpe-0.5.0.img.xz', size: 353217592, sha256: '0f7b12da0e154474e5a086608ff190d376173c0985057f95ab69013d82320ec5' });
    expect(pe.drivers).toMatchObject({ file: 'rk3576-drivers-arm64-0.5.0.zip', sha256: 'ef1af94b823396a9a982b9d0a91f8e1a995d4320543bd8f009b161ae5863a9a0' });
    expect(pe.tools).toMatchObject({ file: 'rk3576-tools-arm64-0.5.0.zip', sha256: '65093e01b939979f08e2c284f7a9d12c0f540cd4b9f8995eaff3bd58c140ef08' });
  });

  it('Prerelease picks 0.5.0 too, and CI the ci release', async () => {
    expect((await tierRelease(FIRMWARE_REPO, 'prerelease', github(FIRMWARE_REPO))).rel.tag_name).toBe('0.5.0');
    expect((await tierRelease(WINPE_REPO, 'prerelease', github(WINPE_REPO))).rel.tag_name).toBe('0.5.0');
    expect((await tierRelease(FIRMWARE_REPO, 'ci', github(FIRMWARE_REPO))).rel.tag_name).toBe('ci');
  });

  it('refuses a 0.5.0 file whose SHA256SUMS.txt line and GitHub digest disagree', async () => {
    const bad = fx.edk2Sums.replace(/^b7598aa4\S+/m, 'f'.repeat(64));
    const fw = firmwareRelease(fx.edk2, parseSums(bad));
    expect(fw.images.tspi3m).toBeUndefined();
    expect(fw.problems.join('\n')).toMatch(/disagree about TaishanPi3M-emmc-edk2-0\.5\.0\.img/);
  });
});
