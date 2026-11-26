// The restores: Armbian's names, .sha and signature; a factory update.img;
// what is written where. The OpenPGP fixtures were made with gpg (a
// throwaway RSA 2048 key, SHA-512 detached signature); the Armbian .asc is
// the one published for trunk.137's TaishanPi 3M vendor minimal image.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublicKey, readSignature, signatureVerifier } from '../src/shared/openpgp';
import { ARMBIAN_RESTORE, ARMBIAN_SIGNING_KEY, armbianRedirect, minimumDiskBytes, parseArmbianFileName, parseArmbianIndex, parseShaLine, simpleOffers, xzUncompressedSize } from '../src/woa/armbian-restore';
import { chipName, parseParameter, readUpdateImage, RK3576 } from '../src/woa/rkfw';
import { BACKUP_GPT_SECTORS, planFactoryRegions, planWhole } from '../src/woa/restore-plan';
import { bytesSource } from '../src/woa/pieces';
import { checkArmbianSignature, checkFactoryMd5, findArmbian, inspectFactory, listArmbian } from '../src/main/restore';

const fx = (n: string) => join(__dirname, 'fixtures', 'openpgp', n);
const ARMBIAN_ASC = 'Armbian_community_26.11.0-trunk.137_Lckfb-taishanpi-3m_trixie_vendor_6.1.172_minimal.img.xz.asc';

describe('OpenPGP detached signatures', () => {
  const key = readPublicKey(readFileSync(fx('key.asc'), 'utf8'));
  const data = readFileSync(fx('data.bin'));
  const sig = readSignature(readFileSync(fx('data.bin.asc'), 'utf8'));

  it('reads the key and its fingerprint as gpg shows it', () => {
    expect(key.fingerprint).toBe('E40E9FAFD97233A44FDEE793A20D086EE3FC5149');
    expect(sig.hash).toBe('sha512');
    expect(sig.issuerFingerprint).toBe(key.fingerprint);
  });
  it('accepts the signed data, in pieces', () => {
    const v = signatureVerifier(sig, key);
    v.update(data.subarray(0, 100));
    v.update(data.subarray(100));
    expect(v.verify()).toBeNull();
  });
  it('refuses one changed byte', () => {
    const bad = Buffer.from(data);
    bad[500] ^= 1;
    const v = signatureVerifier(sig, key);
    v.update(bad);
    expect(v.verify()).toMatch(/does not match/);
  });
  it('refuses a signature by another key', () => {
    const armbian = readPublicKey(Uint8Array.from(Buffer.from(ARMBIAN_SIGNING_KEY.packet, 'base64')));
    const v = signatureVerifier(sig, armbian);
    v.update(data);
    expect(v.verify()).toMatch(/made with key E40E9FAF/);
  });
  it('pins Armbian\'s key, and Armbian\'s .asc names it', () => {
    const armbian = readPublicKey(Uint8Array.from(Buffer.from(ARMBIAN_SIGNING_KEY.packet, 'base64')));
    expect(armbian.fingerprint).toBe(ARMBIAN_SIGNING_KEY.fingerprint);
    const s = readSignature(readFileSync(fx(ARMBIAN_ASC), 'utf8'));
    expect(s.issuerFingerprint).toBe(ARMBIAN_SIGNING_KEY.fingerprint);
    expect(s.created?.toISOString().slice(0, 10)).toBe('2026-11-20');
  });
  // The real 353 MB image, when it is on this computer: ARMBIAN_IMAGE=/path/to/that .img.xz
  it.skipIf(!process.env.ARMBIAN_IMAGE)('checks the real Armbian image', async () => {
    const asc = readFileSync(fx(ARMBIAN_ASC), 'utf8');
    expect(await checkArmbianSignature(process.env.ARMBIAN_IMAGE!, asc)).toBeNull();
  }, 120000);
});

describe('Armbian images', () => {
  it('reads the names the redirector answers with', () => {
    expect(parseArmbianFileName('Armbian_community_26.11.0-trunk.137_Lckfb-taishanpi-3m_trixie_vendor_6.1.172_minimal.img.xz')).toMatchObject({
      channel: 'community', version: '26.11.0-trunk.137', board: 'Lckfb-taishanpi-3m', distro: 'trixie', branch: 'vendor', kernel: '6.1.172', variant: 'minimal',
    });
    expect(parseArmbianFileName('Armbian_community_26.11.0-trunk.137_Armsom-cm5-io_trixie_edge_7.3.5_minimal.img.xz')).toMatchObject({ branch: 'edge', kernel: '7.3.5' });
    expect(parseArmbianFileName('Armbian_26.8.1_Armsom-cm5-io_noble_vendor_6.1.115_gnome_desktop.img.xz')).toMatchObject({ channel: '', variant: 'gnome_desktop' });
    expect(parseArmbianFileName('something.img.xz')).toBeNull();
  });
  it('reads a .sha line', () => {
    expect(parseShaLine('311f796a0e3320284bedcdc8aec85dd9917e0acaa4f764af88c176384aa62947 Armbian_x.img.xz\n'))
      .toEqual({ sha256: '311f796a0e3320284bedcdc8aec85dd9917e0acaa4f764af88c176384aa62947', file: 'Armbian_x.img.xz' });
  });
  it('asks the redirector for the image an offer names', () => {
    expect(armbianRedirect(ARMBIAN_RESTORE.tspi3m!, 'Trixie_vendor_minimal')).toBe('https://dl.armbian.com/lckfb-taishanpi-3m/Trixie_vendor_minimal');
    expect(armbianRedirect(ARMBIAN_RESTORE.cm5io!, 'Resolute_edge_kde-plasma')).toBe('https://dl.armbian.com/armsom-cm5-io/Resolute_edge_kde-plasma');
    expect(() => armbianRedirect(ARMBIAN_RESTORE.cm5io!, '../x')).toThrow(/Not an Armbian image name/);
    expect(armbianRedirect(ARMBIAN_RESTORE.rock4d!, 'Trixie_vendor_minimal', true)).toBe('https://dl.armbian.com/nightly/radxa-rock-4d/Trixie_vendor_minimal');
    expect(armbianRedirect(ARMBIAN_RESTORE.rock4d!, 'Trixie_edge_minimal')).toBe('https://dl.armbian.com/radxa-rock-4d/Trixie_edge_minimal');
  });
  // As armbian-images.json had the ROCK 4D on 2026-11-26: vendor only as nightly builds, edge from the 26.8.2 release.
  it('offers nightly builds where Armbian has nothing else, and a release before a nightly build of the same image', () => {
    const row = (distro: string, branch: string, variant: string, redirect: string, date: string, version: string) => ({
      board_slug: 'radxa-rock-4d', file_extension: 'img.xz', file_application: '', distro, branch, variant, redi_url: redirect,
      file_size: '400000000', file_date: date, promoted: 'false', armbian_version: version, kernel_version: branch === 'edge' ? '7.1.8' : '6.1.172',
    });
    const offers = parseArmbianIndex({ assets: [
      row('trixie', 'vendor', 'minimal', 'https://dl.armbian.com/nightly/radxa-rock-4d/Trixie_vendor_minimal', '2026-11-23T06:32:28Z', '26.11.0-trunk.140'),
      row('trixie', 'edge', 'minimal', 'https://dl.armbian.com/radxa-rock-4d/Trixie_edge_minimal', '2026-08-17T10:51:04Z', '26.8.2'),
      row('trixie', 'edge', 'minimal', 'https://dl.armbian.com/nightly/radxa-rock-4d/Trixie_edge_minimal', '2026-11-23T06:00:00Z', '26.11.0-trunk.140'),
      row('trixie', 'edge', 'gnome', 'https://dl.armbian.com/elsewhere/radxa-rock-4d/Trixie_edge_gnome', '2026-11-23T06:00:00Z', '26.11.0-trunk.140'),
    ] }, 'radxa-rock-4d');
    expect(offers.map((o) => [o.id, o.nightly, o.version])).toEqual([
      ['Trixie_vendor_minimal', true, '26.11.0-trunk.140'], ['Trixie_edge_minimal', false, '26.8.2'],
    ]);
  });

  const index = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'armbian-images.json'), 'utf8'));
  it('offers every plain image Armbian\'s index lists for the board, newest build of each', () => {
    const offers = parseArmbianIndex(index, 'lckfb-taishanpi-3m');
    expect(offers.map((o) => o.id)).toEqual([
      'Trixie_vendor_minimal', 'Resolute_vendor_minimal', 'Resolute_edge_minimal', 'Trixie_edge_minimal',
      'Resolute_vendor_gnome', 'Resolute_edge_gnome', 'Resolute_vendor_kde-plasma', 'Resolute_edge_kde-plasma',
    ]);
    expect(offers.find((o) => o.id === 'Trixie_vendor_minimal')).toMatchObject({ size: 352968008, version: '26.11.0-trunk.137', promoted: true, desktop: false, date: '2026-11-20' });
    // An application image (Home Assistant), another file type and a redirect elsewhere are left out.
    const cm5 = parseArmbianIndex(index, 'armsom-cm5-io');
    expect(cm5).toHaveLength(8);
    expect(cm5.every((o) => o.id.split('_').length === 3)).toBe(true);
    expect(() => parseArmbianIndex({}, 'x')).toThrow(/no list/);
  });
  it('gives Simple mode one card per desktop and one without, on the board maker\'s kernel', () => {
    const s = simpleOffers(parseArmbianIndex(index, 'armsom-cm5-io'));
    expect(s.desktops.map((o) => o.id)).toEqual(['Resolute_vendor_gnome', 'Resolute_vendor_kde-plasma']);
    expect(s.cli?.id).toBe('Trixie_vendor_minimal');
    expect(s.recommended).toBe('Resolute_vendor_gnome');
    expect(simpleOffers([])).toEqual({ desktops: [], cli: null, recommended: null });
  });
  it('reads the decompressed size from the end of an .xz file', () => {
    const data = Buffer.alloc(3 << 20);
    for (let i = 0; i < data.length; i += 4096) data[i] = i & 0xff;
    const xz = execFileSync('xz', ['-c', '-T2', '--block-size=1MiB'], { input: data });
    expect(xzUncompressedSize(new Uint8Array(xz))).toBe(data.length);
    expect(xzUncompressedSize(new Uint8Array(xz.subarray(xz.length - 20)))).toBeNull();
    expect(xzUncompressedSize(new Uint8Array(64))).toBeNull();
    expect(minimumDiskBytes(2059403264, false)).toBe(2059403264 + 1024 ** 3);
    expect(minimumDiskBytes(6e9, true)).toBe(6e9 + 4 * 1024 ** 3);
  });
  it('lists the board\'s images from the index', async () => {
    const offers = await listArmbian('cm5io', async (url) => { expect(url).toBe('https://github.armbian.com/armbian-images.json'); return new Response(JSON.stringify(index)); });
    expect(offers.length).toBe(8);
    await expect(listArmbian('tspi3m', async () => new Response('{"assets":[]}'))).rejects.toThrow(/lists no image/);
  });
  it('finds the image through the redirector, its decompressed size, and refuses a name for another board or variant', async () => {
    const file = 'Armbian_community_26.11.0-trunk.137_Lckfb-taishanpi-3m_resolute_vendor_6.1.172_gnome_desktop.img.xz';
    const asc = readFileSync(fx(ARMBIAN_ASC), 'utf8');
    const data = Buffer.alloc(1 << 20, 7);
    const xz = execFileSync('xz', ['-c'], { input: data });
    const answer = (name: string, ranged = true) => async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      if (url.endsWith('.sha')) return new Response(`${'a'.repeat(64)} ${name}\n`);
      if (url.endsWith('.asc')) return new Response(asc);
      if (init?.headers?.Range) {
        expect(init.headers.Range).toBe(`bytes=0-${xz.length - 1}`);
        return ranged ? new Response(xz, { status: 206 }) : new Response(xz);
      }
      expect(init?.method).toBe('HEAD');
      const r = new Response(null, { headers: { 'content-length': String(xz.length) } });
      Object.defineProperty(r, 'url', { value: `https://github.com/armbian/community/releases/download/26.11.0-trunk.137/${name}` });
      return r;
    };
    const a = await findArmbian('tspi3m', 'Resolute_vendor_gnome', answer(file));
    expect(a).toMatchObject({ file, kernel: '6.1.172', version: '26.11.0-trunk.137', signed: '2026-11-20', desktop: true, variant: 'gnome',
      imageBytes: data.length, minBytes: data.length + 4 * 1024 ** 3 });
    expect(a.url).toMatch(/^https:\/\/github\.com\/armbian\//);
    expect((await findArmbian('tspi3m', 'Resolute_vendor_gnome', answer(file, false))).imageBytes).toBeNull();
    await expect(findArmbian('tspi3m', 'Resolute_vendor_gnome', answer(file.replace('Lckfb-taishanpi-3m', 'Armsom-cm5-io')))).rejects.toThrow(/not the Resolute_vendor_gnome image/);
    await expect(findArmbian('tspi3m', 'Resolute_edge_gnome', answer(file))).rejects.toThrow(/not the Resolute_edge_gnome image/);
    await expect(findArmbian('tspi3m', 'Resolute_vendor_kde-plasma', answer(file))).rejects.toThrow(/not the Resolute_vendor_kde-plasma image/);
    await expect(findArmbian('tspi3m', 'Trixie_vendor_gnome', answer(file))).rejects.toThrow(/not the Trixie_vendor_gnome/);
  });
  it('asks the nightly redirector for a nightly offer', async () => {
    const file = 'Armbian_26.11.0-trunk.140_Radxa-rock-4d_trixie_vendor_6.1.172_minimal.img.xz';
    const asc = readFileSync(fx(ARMBIAN_ASC), 'utf8');
    const asked: string[] = [];
    const answer = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      asked.push(url);
      if (url.endsWith('.sha')) return new Response(`${'b'.repeat(64)} ${file}\n`);
      if (url.endsWith('.asc')) return new Response(asc);
      if (init?.headers?.Range) return new Response(null, { status: 416 });
      const r = new Response(null, { headers: { 'content-length': '1000' } });
      Object.defineProperty(r, 'url', { value: `https://github.com/armbian/ci/releases/download/26.11.0-trunk.140/${file}` });
      return r;
    };
    const a = await findArmbian('rock4d', 'Trixie_vendor_minimal', answer, undefined, true);
    expect(a).toMatchObject({ file, version: '26.11.0-trunk.140', branch: 'vendor', kernel: '6.1.172', imageBytes: null });
    expect(asked.slice(0, 3)).toEqual(['sha', 'asc', ''].map((x) => `https://dl.armbian.com/nightly/radxa-rock-4d/Trixie_vendor_minimal${x ? `.${x}` : ''}`));
  });
});

/** A small update.img as afptool and rkImageMaker lay it out. */
function synthUpdateImg(opts: { chip?: number; loaderChip?: number; bigBoot?: boolean } = {}): Uint8Array {
  const parameter = 'FIRMWARE_VER: 14.0\nMACHINE_MODEL: TaishanPi3M\nCMDLINE: mtdparts=:0x00002000@0x00004000(uboot),0x00000800@0x00006000(misc),0x00020000@0x00006800(boot),-@0x00026800(userdata:grow)\n';
  const parm = new Uint8Array(8 + parameter.length + 4);
  parm.set(new TextEncoder().encode('PARM'), 0);
  new DataView(parm.buffer).setUint32(4, parameter.length, true);
  parm.set(new TextEncoder().encode(parameter), 8);
  const uboot = new Uint8Array(4096).fill(0x55);
  const boot = new Uint8Array(opts.bigBoot ? 0x20001 * 512 : 6000).fill(0xbb);
  const sparse = new Uint8Array(64);
  new DataView(sparse.buffer).setUint32(0, 0xed26ff3a, true);
  const parts: Array<[string, string, Uint8Array]> = [['parameter', 'parameter.txt', parm], ['uboot', 'Image/uboot.img', uboot], ['boot', 'Image/boot.img', boot], ['userdata', 'Image/userdata.img', sparse]];
  const header = 2048;
  let pos = header;
  const placed = parts.map(([n, f, d]) => { const at = pos; pos += Math.ceil(d.length / 2048) * 2048; return { n, f, d, at }; });
  const rkaf = new Uint8Array(pos);
  const dv = new DataView(rkaf.buffer);
  rkaf.set(new TextEncoder().encode('RKAF'), 0);
  dv.setUint32(4, pos, true);
  rkaf.set(new TextEncoder().encode('TaishanPi3M'), 8);
  rkaf.set(new TextEncoder().encode('LCKFB'), 72);
  dv.setUint32(136, placed.length, true);
  placed.forEach((p, i) => {
    const o = 140 + i * 112;
    rkaf.set(new TextEncoder().encode(p.n), o);
    rkaf.set(new TextEncoder().encode(p.f), o + 32);
    dv.setUint32(o + 96, p.at, true);
    dv.setUint32(o + 108, p.d.length, true);
    rkaf.set(p.d, p.at);
  });
  const loader = new Uint8Array(4096);
  loader.set(new TextEncoder().encode('LDR '), 0);
  new DataView(loader.buffer).setUint32(0x15, opts.loaderChip ?? RK3576, true);
  const head = new Uint8Array(0x66);
  const hv = new DataView(head.buffer);
  head.set(new TextEncoder().encode('RKFW'), 0);
  hv.setUint16(4, 0x66, true);
  hv.setUint32(6, 0x0e000000, true);
  hv.setUint16(0x0e, 2026, true); head[0x10] = 11; head[0x11] = 2;
  hv.setUint32(0x15, opts.chip ?? RK3576, true);
  hv.setUint32(0x19, 0x66, true);
  hv.setUint32(0x1d, loader.length, true);
  hv.setUint32(0x21, 0x66 + loader.length, true);
  hv.setUint32(0x25, rkaf.length, true);
  const body = new Uint8Array(0x66 + loader.length + rkaf.length);
  body.set(head, 0); body.set(loader, 0x66); body.set(rkaf, 0x66 + loader.length);
  const md5 = new TextEncoder().encode(createHash('md5').update(body).digest('hex'));
  const out = new Uint8Array(body.length + 32);
  out.set(body, 0); out.set(md5, body.length);
  return out;
}

describe('a factory update.img', () => {
  it('names the chip as the header spells it', () => {
    expect(chipName(RK3576)).toBe('RK3576');
    expect(chipName(0x33353838)).toBe('RK3588');
  });
  it('reads parameter.txt partitions', () => {
    expect(parseParameter('CMDLINE: console=ttyFIQ0 mtdparts=rk29xxnand:0x2000@0x4000(uboot),-@0x26800(userdata:grow)')).toEqual([
      { name: 'uboot', lba: 0x4000, sectors: 0x2000, grow: false }, { name: 'userdata', lba: 0x26800, sectors: null, grow: true },
    ]);
  });
  it('lists what it holds and plans the writes where parameter.txt says', () => {
    const file = synthUpdateImg();
    const img = readUpdateImage(bytesSource(file));
    expect(img).toMatchObject({ chip: 'RK3576', model: 'TaishanPi3M', manufacturer: 'LCKFB', released: '2026-11-02', loader: { chip: 'RK3576' } });
    expect(img.parts.map((p) => [p.name, p.lba, p.sparse])).toEqual([['parameter', null, false], ['uboot', 0x4000, false], ['boot', 0x6800, false], ['userdata', 0x26800, true]]);
    const plan = planFactoryRegions(bytesSource(file), img, 32e9);
    if ('stop' in plan) throw new Error(plan.stop);
    expect(plan.regions.map((r) => [r.lba, r.source.size])).toEqual([[0x4000, 4096], [0x6800, 6000], [0x26800, 64]]);
    expect(plan.regions[0].source.read(0, 4)).toEqual(Uint8Array.of(0x55, 0x55, 0x55, 0x55));
    expect(new TextDecoder().decode(plan.parameter)).toMatch(/^FIRMWARE_VER/);
    expect(plan.loader.subarray(0, 4)).toEqual(new TextEncoder().encode('LDR '));
  });
  it('refuses another chip, another chip\'s loader, a partition image too large for its place, an RKAF alone', () => {
    const other = readUpdateImage(bytesSource(synthUpdateImg({ chip: 0x33353838 })));
    expect(planFactoryRegions(bytesSource(new Uint8Array(1)), other, null)).toEqual({ stop: 'This update.img is for RK3588, not RK3576.' });
    const loader = readUpdateImage(bytesSource(synthUpdateImg({ loaderChip: 0x33353838 })));
    expect(planFactoryRegions(bytesSource(new Uint8Array(1)), loader, null)).toMatchObject({ stop: expect.stringMatching(/loader .* RK3588/) });
    const big = synthUpdateImg({ bigBoot: true });
    expect(planFactoryRegions(bytesSource(big), readUpdateImage(bytesSource(big)), null)).toMatchObject({ stop: expect.stringMatching(/boot .* larger than its partition/) });
    const file = synthUpdateImg();
    expect(() => readUpdateImage(bytesSource(file.slice(0x66 + 4096)))).toThrow(/RKAF archive without its RKFW header/);
    expect(() => readUpdateImage(bytesSource(file.slice(0, 5000)))).toThrow(/incomplete/);
  });
  it('checks the MD5 at its end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rkfw-'));
    const p = join(dir, 'update.img');
    writeFileSync(p, synthUpdateImg());
    expect(await checkFactoryMd5(inspectFactory(p))).toBeNull();
    const bad = synthUpdateImg();
    bad[0x66 + 4096 + 2048 + 10] ^= 1;
    writeFileSync(p, bad);
    expect(await checkFactoryMd5(inspectFactory(p))).toMatch(/does not match the MD5/);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('a whole-disk image', () => {
  it('goes from sector 0 and clears the old backup partition table', () => {
    const p = planWhole(bytesSource(new Uint8Array(1 << 20)), 'Armbian', 31272730624);
    if ('stop' in p) throw new Error(p.stop);
    expect(p.regions.map((r) => [r.lba, r.source.size])).toEqual([[0, 1 << 20], [31272730624 / 512 - BACKUP_GPT_SECTORS, BACKUP_GPT_SECTORS * 512]]);
    expect(p.summary).toMatchObject({ kind: 'whole', clearsBackupGpt: true });
  });
  it('refuses an image larger than the eMMC, or not whole sectors', () => {
    expect(planWhole(bytesSource(new Uint8Array(4096)), 'Armbian', 2048)).toMatchObject({ stop: expect.stringMatching(/larger than the eMMC/) });
    expect(planWhole(bytesSource(new Uint8Array(1000)), 'Armbian', null)).toMatchObject({ stop: expect.stringMatching(/whole number of sectors/) });
  });
});
