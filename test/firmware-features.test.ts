import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { builtinFeatures, checkedFeatures, featuresName, hasFeature, parseFeatures } from '../src/woa/firmware-features';
import { firmwareRelease, loadFirmwareFeatures, parseSums, type GithubRelease } from '../src/woa/releases';

// FEATURES.json of an edk2-rk3576 build (scripts/features.py release, the build workflow's dry run).
const fixture = readFileSync(join(__dirname, 'fixtures', 'edk2-features.json'));
const fixtureSum = bytesToHex(sha256(new Uint8Array(fixture)));

const imgs = ['CM5IO-emmc-edk2-ci-abc1234.img', 'TaishanPi3M-emmc-edk2-ci-abc1234.img', 'ROCK4D-spi-edk2-ci-abc1234.img'];
const release = (withFeatures: boolean, digest?: string): GithubRelease => ({
  tag_name: 'ci',
  assets: [...imgs, ...(withFeatures ? ['FEATURES.json'] : [])].map((n) => ({
    name: n, size: 1, browser_download_url: `https://x/${n}`, ...(n === 'FEATURES.json' && digest ? { digest } : {}),
  })),
});
const sumsWith = (sum: string | null) => new Map([...imgs.map((n): [string, string] => [n, 'a'.repeat(64)]), ...(sum ? [['FEATURES.json', sum] as [string, string]] : [])]);
const fetchOf = (body: Uint8Array, status = 200) => async () => new Response((status === 200 ? body : null) as BodyInit | null, { status });

describe('firmware features', () => {
  it('names boards by their image prefix', () => {
    expect(featuresName('rock4d')).toBe('ROCK4D');
    expect(featuresName('cm5io')).toBe('CM5IO');
    expect(featuresName('tspi3m')).toBe('TaishanPi3M');
  });

  it('reads every board of a FEATURES.json', () => {
    const b = parseFeatures(fixture.toString('utf8'));
    expect(Object.keys(b).sort()).toEqual(['cm5io', 'rock4d', 'tspi3m']);
    expect(b.rock4d!.features.windows).toEqual({ built: true });
    expect(b.tspi3m!.features.dsi!.built).toBe(true);
    expect(b.cm5io!.features.dsi!.built).toBe(false);
    expect(b.cm5io!.features.usbcDp).toEqual({ built: true, default: 'off' });
    expect(b.tspi3m!.firmwareVersion).toMatch(/^rk3576-TaishanPi3M-/);
    expect(b.tspi3m!.settings).toMatchObject({ schema: 1 });
  });

  it('refuses what is not a FEATURES.json', () => {
    expect(() => parseFeatures('not json')).toThrow(/not JSON/);
    expect(() => parseFeatures('{"boards":{}}')).toThrow(/schema/);
    expect(() => parseFeatures('{"schema":1}')).toThrow(/no boards/);
  });

  it('skips fields it does not know and boards that are not there', () => {
    const b = parseFeatures(JSON.stringify({ schema: 2, boards: { ROCK4D: { features: { windows: { built: false, default: 'on' }, laser: { built: true }, hdmi: { built: 'yes' } } } } }));
    expect(b.rock4d!.features).toEqual({ windows: { built: false } });
    expect(b.cm5io).toBeUndefined();
  });

  it('checks the bytes against their SHA-256', () => {
    expect(() => checkedFeatures(new Uint8Array(fixture), '0'.repeat(64))).toThrow(/SHA-256/);
    expect(Object.keys(checkedFeatures(new Uint8Array(fixture), fixtureSum.toUpperCase()))).toHaveLength(3);
  });

  it('knows 0.4.x without FEATURES.json: the ROCK 4D image cannot start Windows', () => {
    const r = firmwareRelease({ tag_name: '0.4.1', assets: imgs.map((n) => ({ name: n.replace('ci-abc1234', '0.4.1'), size: 1, browser_download_url: n })) },
      new Map(imgs.map((n) => [n.replace('ci-abc1234', '0.4.1'), 'a'.repeat(64)])));
    expect(r.features.from).toBe('builtin');
    expect(hasFeature(r.features, 'rock4d', 'windows')).toBe(false);
    expect(hasFeature(r.features, 'cm5io', 'windows')).toBe(true);
    expect(hasFeature(r.features, 'tspi3m', 'dsi')).toBe(true);
    expect(hasFeature(r.features, 'tspi3m', 'armbianOnce')).toBe(false);
  });

  it('offers Windows and Armbian on the CM5-IO only from 0.5.0 on (Armbian once in its SPL, request on the eMMC)', () => {
    const b = parseFeatures(readFileSync(join(__dirname, 'fixtures', 'edk2-0.5.0-features.json'), 'utf8'));
    expect(hasFeature({ from: 'release', boards: b }, 'cm5io', 'armbianOnce')).toBe(true);
    expect(hasFeature(builtinFeatures('0.4.1'), 'cm5io', 'armbianOnce')).toBe(false);
  });

  it('knows nothing about a release it has no table for', () => {
    expect(builtinFeatures('0.2.0')).toEqual({ from: null, boards: {} });
    expect(hasFeature(builtinFeatures('0.2.0'), 'rock4d', 'windows')).toBeNull();
  });

  it('loads FEATURES.json from a release, checked by SHA256SUMS.txt', async () => {
    const rel = release(true);
    const fw = await loadFirmwareFeatures(firmwareRelease(rel, sumsWith(fixtureSum)), rel, sumsWith(fixtureSum), fetchOf(new Uint8Array(fixture)));
    expect(fw.problems).toEqual([]);
    expect(fw.features.from).toBe('release');
    expect(hasFeature(fw.features, 'rock4d', 'windows')).toBe(true);
  });

  it('keeps the built-in table and says why when FEATURES.json does not match', async () => {
    const rel = release(true);
    const fw = await loadFirmwareFeatures(firmwareRelease(rel, sumsWith('1'.repeat(64))), rel, sumsWith('1'.repeat(64)), fetchOf(new Uint8Array(fixture)));
    expect(fw.features.from).toBeNull();
    expect(fw.problems.join(' ')).toMatch(/FEATURES\.json.*SHA-256/);
  });

  it('refuses FEATURES.json when SHA256SUMS.txt and GitHub disagree, or neither gives a SHA-256', async () => {
    const rel = release(true, `sha256:${'2'.repeat(64)}`);
    const a = await loadFirmwareFeatures(firmwareRelease(rel, sumsWith(fixtureSum)), rel, sumsWith(fixtureSum), fetchOf(new Uint8Array(fixture)));
    expect(a.problems.join(' ')).toMatch(/disagree about FEATURES\.json/);
    const none = await loadFirmwareFeatures(firmwareRelease(release(true), sumsWith(null)), release(true), sumsWith(null), fetchOf(new Uint8Array(fixture)));
    expect(none.problems.join(' ')).toMatch(/no SHA-256 for FEATURES\.json/);
  });

  it('takes GitHub\'s digest when SHA256SUMS.txt does not list it', async () => {
    const rel = release(true, `sha256:${fixtureSum}`);
    const fw = await loadFirmwareFeatures(firmwareRelease(rel, sumsWith(null)), rel, sumsWith(null), fetchOf(new Uint8Array(fixture)));
    expect(fw.problems).toEqual([]);
    expect(fw.features.from).toBe('release');
  });

  it('is optional: a release without it keeps the built-in table, a failed download is a problem', async () => {
    const rel = release(false);
    let fetched = false;
    const fw = await loadFirmwareFeatures(firmwareRelease(rel, sumsWith(null)), rel, sumsWith(null), async () => { fetched = true; return new Response(''); });
    expect(fetched).toBe(false);
    expect(fw.problems).toEqual([]);
    const relF = release(true);
    const bad = await loadFirmwareFeatures(firmwareRelease(relF, sumsWith(fixtureSum)), relF, sumsWith(fixtureSum), fetchOf(new Uint8Array(), 404));
    expect(bad.problems.join(' ')).toMatch(/HTTP 404/);
  });

  it('reads SHA256SUMS.txt lines for FEATURES.json', () => {
    expect(parseSums(`${fixtureSum}  FEATURES.json\n`).get('FEATURES.json')).toBe(fixtureSum);
  });
});
