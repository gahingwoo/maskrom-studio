// Checking a detached OpenPGP signature (an .asc beside a download) against
// one pinned public key, in Node.js without gpg: version 4 signatures over
// binary data (signature type 0x00) made with an RSA key, which is what
// Armbian publishes next to every image. RFC 4880 sections 4, 5.2 and 12.2.
// Anything else is refused with a sentence, never accepted on a guess.
//
// Written to be shared with Roxora Imager: no Electron, no dependencies.

import { createHash, createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export interface PgpPublicKey {
  /** v4 fingerprint, 40 upper-case hex digits. */
  fingerprint: string;
  key: KeyObject;
}

export interface PgpSignature {
  /** Long key id of the signer (issuer subpacket, or the fingerprint's last 16 digits). */
  issuer: string | null;
  issuerFingerprint: string | null;
  created: Date | null;
  /** Node's name for the hash ('sha256', 'sha512', ...). */
  hash: string;
  /** What is hashed after the data: the hashed part of the packet and its trailer. */
  trailer: Uint8Array;
  left16: number;
  value: Uint8Array;
}

const HASHES: Record<number, string> = { 2: 'sha1', 8: 'sha256', 9: 'sha384', 10: 'sha512', 11: 'sha224' };

/** The bytes inside "-----BEGIN PGP ...-----" armor (the CRC line is not needed: the signature checks the content). */
export function dearmor(text: string): Uint8Array {
  const m = /-----BEGIN PGP [A-Z ]+-----\r?\n([\s\S]*?)-----END PGP [A-Z ]+-----/.exec(text);
  if (!m) throw new Error('The signature file is not ASCII-armored OpenPGP data.');
  const lines = m[1].split(/\r?\n/);
  // Armor headers (Version: ..., Comment: ...) end at the first empty line.
  const blank = lines.findIndex((l) => l.trim() === '');
  const body = (blank >= 0 && lines.slice(0, blank).every((l) => /^[\w-]+: /.test(l)) ? lines.slice(blank + 1) : lines)
    .filter((l) => l.trim() !== '' && !l.startsWith('='))
    .join('');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

interface Packet { tag: number; body: Uint8Array }

export function packets(data: Uint8Array): Packet[] {
  const out: Packet[] = [];
  let o = 0;
  while (o < data.length) {
    const ctb = data[o++];
    if (!(ctb & 0x80)) throw new Error('Malformed OpenPGP data.');
    let tag: number;
    let len: number;
    if (ctb & 0x40) {
      tag = ctb & 0x3f;
      const a = data[o++];
      if (a < 192) len = a;
      else if (a < 224) len = ((a - 192) << 8) + data[o++] + 192;
      else if (a === 255) { len = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0; o += 4; }
      else throw new Error('Partial-length OpenPGP packets are not handled.');
    } else {
      tag = (ctb >> 2) & 0x0f;
      const lt = ctb & 3;
      if (lt === 0) len = data[o++];
      else if (lt === 1) { len = (data[o] << 8) | data[o + 1]; o += 2; }
      else if (lt === 2) { len = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0; o += 4; }
      else throw new Error('Indeterminate-length OpenPGP packets are not handled.');
    }
    if (o + len > data.length) throw new Error('The OpenPGP data is cut short.');
    out.push({ tag, body: data.subarray(o, o + len) });
    o += len;
  }
  return out;
}

function mpi(b: Uint8Array, o: number): { value: Uint8Array; next: number } {
  const bits = (b[o] << 8) | b[o + 1];
  const n = (bits + 7) >> 3;
  if (o + 2 + n > b.length) throw new Error('The OpenPGP data is cut short.');
  return { value: b.subarray(o + 2, o + 2 + n), next: o + 2 + n };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** The primary key of an armored public key block (or of the raw key packet). */
export function readPublicKey(armoredOrPacket: string | Uint8Array): PgpPublicKey {
  const data = typeof armoredOrPacket === 'string' ? dearmor(armoredOrPacket) : armoredOrPacket;
  const p = packets(data).find((x) => x.tag === 6);
  if (!p) throw new Error('No public key in the key data.');
  const b = p.body;
  if (b[0] !== 4) throw new Error(`OpenPGP key version ${b[0]} is not handled.`);
  if (b[5] !== 1 && b[5] !== 3) throw new Error('Only RSA keys are handled.');
  const n = mpi(b, 6);
  const e = mpi(b, n.next);
  const fp = createHash('sha1').update(Uint8Array.of(0x99, b.length >> 8, b.length & 0xff)).update(b).digest();
  const key = createPublicKey({ key: { kty: 'RSA', n: b64url(n.value), e: b64url(e.value) }, format: 'jwk' });
  return { fingerprint: hex(fp), key };
}

/** The one signature packet of a detached signature. */
export function readSignature(armoredOrPacket: string | Uint8Array): PgpSignature {
  const data = typeof armoredOrPacket === 'string' ? dearmor(armoredOrPacket) : armoredOrPacket;
  const sigs = packets(data).filter((x) => x.tag === 2);
  if (sigs.length !== 1) throw new Error(`Expected one signature, found ${sigs.length}.`);
  const b = sigs[0].body;
  if (b[0] !== 4) throw new Error(`OpenPGP signature version ${b[0]} is not handled.`);
  if (b[1] !== 0x00) throw new Error('The signature is not over binary data.');
  if (b[2] !== 1 && b[2] !== 3) throw new Error('Only RSA signatures are handled.');
  const hash = HASHES[b[3]];
  if (!hash || hash === 'sha1') throw new Error(`The signature uses hash algorithm ${b[3]}, which is not accepted.`);
  const hashedLen = (b[4] << 8) | b[5];
  const hashedEnd = 6 + hashedLen;
  const unhashedLen = (b[hashedEnd] << 8) | b[hashedEnd + 1];
  const unhashedEnd = hashedEnd + 2 + unhashedLen;
  if (unhashedEnd + 2 > b.length) throw new Error('The signature is cut short.');
  let issuer: string | null = null;
  let issuerFingerprint: string | null = null;
  let created: Date | null = null;
  const sub = (from: number, to: number, hashed: boolean) => {
    let o = from;
    while (o < to) {
      let len = b[o++];
      if (len >= 192 && len < 255) len = ((len - 192) << 8) + b[o++] + 192;
      else if (len === 255) { len = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; o += 4; }
      const type = b[o] & 0x7f;
      const d = b.subarray(o + 1, o + len);
      // Only what is hashed counts as said by the signer; the unhashed issuer is a hint.
      if (type === 2 && hashed && d.length === 4) created = new Date((((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0) * 1000);
      if (type === 16 && d.length === 8 && !issuer) issuer = hex(d);
      if (type === 33 && hashed && d[0] === 4 && d.length === 21) issuerFingerprint = hex(d.subarray(1));
      o += len;
    }
  };
  sub(6, hashedEnd, true);
  sub(hashedEnd + 2, unhashedEnd, false);
  if (!issuer && issuerFingerprint) issuer = (issuerFingerprint as string).slice(-16);
  const hashedPart = b.subarray(0, hashedEnd);
  const trailer = new Uint8Array(hashedPart.length + 6);
  trailer.set(hashedPart, 0);
  trailer.set([0x04, 0xff, (hashedPart.length >>> 24) & 0xff, (hashedPart.length >>> 16) & 0xff, (hashedPart.length >>> 8) & 0xff, hashedPart.length & 0xff], hashedPart.length);
  const left16 = (b[unhashedEnd] << 8) | b[unhashedEnd + 1];
  const value = mpi(b, unhashedEnd + 2).value;
  return { issuer, issuerFingerprint, created, hash, trailer, left16, value };
}

/**
 * A verifier fed with the signed data in pieces (a download as it arrives,
 * a file as it is read); `verify()` says whether `sig` was made over exactly
 * those bytes by `key`, or why not.
 */
export function signatureVerifier(sig: PgpSignature, key: PgpPublicKey) {
  const v = createVerify(sig.hash);
  const h = createHash(sig.hash);
  return {
    update(chunk: Uint8Array) { v.update(chunk); h.update(chunk); },
    verify(): string | null {
      if (sig.issuerFingerprint && sig.issuerFingerprint !== key.fingerprint) {
        return `The signature was made with key ${sig.issuerFingerprint}, not ${key.fingerprint}.`;
      }
      if (!sig.issuerFingerprint && sig.issuer && !key.fingerprint.endsWith(sig.issuer)) {
        return `The signature was made with key ${sig.issuer}, not ${key.fingerprint}.`;
      }
      v.update(sig.trailer);
      h.update(sig.trailer);
      const digest = h.digest();
      if (((digest[0] << 8) | digest[1]) !== sig.left16) return 'The signature does not match the file.';
      // RSA PKCS #1 v1.5 over the digest; the signature value may be shorter than the modulus.
      const size = Math.ceil(((key.key.asymmetricKeyDetails?.modulusLength) ?? sig.value.length * 8) / 8);
      const s = new Uint8Array(size);
      s.set(sig.value, size - sig.value.length);
      return v.verify(key.key, s) ? null : 'The signature does not match the file.';
    },
  };
}
