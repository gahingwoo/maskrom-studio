// The restores: Armbian's names, .sha and signature; a factory update.img;
// what is written where. The OpenPGP fixtures were made with gpg (a
// throwaway RSA 2048 key, SHA-512 detached signature); the Armbian .asc is
// the one published for trunk.137's TaishanPi 3M vendor minimal image.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublicKey, readSignature, signatureVerifier } from '../src/shared/openpgp';
import { ARMBIAN_RESTORE, ARMBIAN_SIGNING_KEY, armbianRedirect, parseArmbianFileName, parseShaLine } from '../src/woa/armbian-restore';
import { chipName, parseParameter, readUpdateImage, RK3576 } from '../src/woa/rkfw';
import { BACKUP_GPT_SECTORS, planFactoryRegions, planWhole } from '../src/woa/restore-plan';
import { bytesSource } from '../src/woa/pieces';
import { checkArmbianSignature, checkFactoryMd5, findArmbian, inspectFactory } from '../src/main/restore';

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
  it('asks the redirector for the minimal image of both boards', () => {
    expect(armbianRedirect(ARMBIAN_RESTORE.tspi3m!, 'vendor')).toBe('https://dl.armbian.com/lckfb-taishanpi-3m/Trixie_vendor_minimal');
    expect(armbianRedirect(ARMBIAN_RESTORE.cm5io!, 'edge')).toBe('https://dl.armbian.com/armsom-cm5-io/Trixie_edge_minimal');
    expect(ARMBIAN_RESTORE.rock4d).toBeUndefined();
  });
  it('finds the image through the redirector, and refuses a name for another board', async () => {
    const file = 'Armbian_community_26.11.0-trunk.137_Lckfb-taishanpi-3m_trixie_vendor_6.1.172_minimal.img.xz';
    const asc = readFileSync(fx(ARMBIAN_ASC), 'utf8');
    const answer = (name: string) => async (url: string, init?: { method?: string }) => {
      if (url.endsWith('.sha')) return new Response(`${'a'.repeat(64)} ${name}\n`);
      if (url.endsWith('.asc')) return new Response(asc);
      expect(init?.method).toBe('HEAD');
      const r = new Response(null, { headers: { 'content-length': '352968008' } });
      Object.defineProperty(r, 'url', { value: `https://github.com/armbian/community/releases/download/26.11.0-trunk.137/${name}` });
      return r;
    };
    const a = await findArmbian('tspi3m', 'vendor', answer(file));
    expect(a).toMatchObject({ file, size: 352968008, kernel: '6.1.172', version: '26.11.0-trunk.137', signed: '2026-11-20' });
    expect(a.url).toMatch(/^https:\/\/github\.com\/armbian\//);
    await expect(findArmbian('tspi3m', 'vendor', answer(file.replace('Lckfb-taishanpi-3m', 'Armsom-cm5-io')))).rejects.toThrow(/not the vendor image/);
    await expect(findArmbian('tspi3m', 'edge', answer(file))).rejects.toThrow(/not the edge image/);
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
