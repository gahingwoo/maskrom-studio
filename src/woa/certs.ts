// The test certificates the drivers are signed with, so the installed
// Windows trusts them from its first boot.
//
// woa-rk3576's WinPE workflow signs every driver catalog (.cat) with a new
// self-signed test certificate per run, and other driver packages
// (wddm-mali-g52) bring their own. Test signing lets the kernel load such a
// driver, but Plug and Play only installs it without asking when its
// publisher is trusted (woa-rk3576 docs/INSTALL.md: certutil -addstore Root
// and TrustedPublisher). Here the certificates are taken out of the
// catalogs on this computer, and the install script writes them into the
// offline SOFTWARE hive, where certutil would have put them:
// HKLM\SOFTWARE\Microsoft\SystemCertificates\{ROOT,TrustedPublisher}\
// Certificates\<SHA-1 thumbprint>, value Blob, holding the certificate as a
// serialized property (CERT_CERT_PROP_ID, 32). Only self-signed
// certificates are taken: nothing here adds an intermediate or someone
// else's root.

import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface Tlv { tag: number; start: number; header: number; length: number; end: number }

function tlv(b: Uint8Array, at: number): Tlv {
  const tag = b[at];
  let len = b[at + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER length form not handled');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i];
    header += n;
  }
  const end = at + header + len;
  if (end > b.length) throw new Error('DER element runs past the end');
  return { tag, start: at, header, length: len, end };
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let at = t.start + t.header;
  while (at < t.end) { const c = tlv(b, at); out.push(c); at = c.end; }
  return out;
}

/** The certificates (DER) in a PKCS #7 SignedData, such as a driver catalog. */
export function pkcs7Certificates(der: Uint8Array): Uint8Array[] {
  const ci = tlv(der, 0);
  const [, content] = children(der, ci);
  if (!content || content.tag !== 0xa0) throw new Error('not a PKCS #7 SignedData');
  const sd = children(der, content)[0];
  const certSet = children(der, sd).find((x) => x.tag === 0xa0);
  if (!certSet) return [];
  return children(der, certSet).filter((x) => x.tag === 0x30).map((x) => der.slice(x.start, x.end));
}

/** Issuer and subject of a certificate, as DER, to tell a self-signed one. */
function issuerSubject(cert: Uint8Array): { issuer: Uint8Array; subject: Uint8Array } {
  const c = tlv(cert, 0);
  const tbs = children(cert, c)[0];
  const f = children(cert, tbs);
  const i = f[0].tag === 0xa0 ? 1 : 0; // [0] version is optional
  const issuer = f[i + 2];
  const subject = f[i + 4];
  return { issuer: cert.subarray(issuer.start, issuer.end), subject: cert.subarray(subject.start, subject.end) };
}

export function isSelfSigned(cert: Uint8Array): boolean {
  const { issuer, subject } = issuerSubject(cert);
  return issuer.length === subject.length && issuer.every((x, k) => x === subject[k]);
}

export interface TrustedCert {
  thumbprint: string;
  /** The registry Blob value. */
  blob: Uint8Array;
}

export function certBlob(cert: Uint8Array): Uint8Array {
  const b = new Uint8Array(12 + cert.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 32, true); // CERT_CERT_PROP_ID
  dv.setUint32(4, 1, true);
  dv.setUint32(8, cert.length, true);
  b.set(cert, 12);
  return b;
}

/** The self-signed certificates of these catalogs, once each. Catalogs that do not parse are skipped. */
export function trustedCerts(catalogs: Uint8Array[]): TrustedCert[] {
  const seen = new Map<string, TrustedCert>();
  for (const cat of catalogs) {
    let certs: Uint8Array[] = [];
    try { certs = pkcs7Certificates(cat); } catch { continue; }
    for (const c of certs) {
      try { if (!isSelfSigned(c)) continue; } catch { continue; }
      const thumbprint = bytesToHex(sha1(c)).toUpperCase();
      if (!seen.has(thumbprint)) seen.set(thumbprint, { thumbprint, blob: certBlob(c) });
    }
  }
  return [...seen.values()];
}

/** cmd lines that add the certificates to the offline SOFTWARE hive loaded at HKLM\WOAOFF. */
export function certsCmd(certs: TrustedCert[]): string {
  const lines = ['@echo off', 'rem Written by Maskrom Studio: trust the drivers\' test certificates (Root, TrustedPublisher).'];
  for (const c of certs) {
    const hex = bytesToHex(c.blob).toUpperCase();
    for (const store of ['ROOT', 'TrustedPublisher']) {
      lines.push(`reg add "HKLM\\WOAOFF\\Microsoft\\SystemCertificates\\${store}\\Certificates\\${c.thumbprint}" /v Blob /t REG_BINARY /d ${hex} /f`);
    }
  }
  return `${lines.join('\n')}\n`;
}
