// What a Windows image holds, read from its header and XML data: the
// editions, their architecture and build. This is what the deploy script
// learns from dism /Get-ImageInfo, asked before anything is written, so a
// 24H2 or an x64 image is refused on this computer instead of on the board.
//
// WIM and ESD share the header (wimlib's documentation of the format,
// "MSWIM\0\0\0", 208 bytes). The XML data is a UTF-16 document that is never
// compressed, also in solid ESD files.

import type { ByteSource } from './pieces';

/** Build 26100 is 24H2. RK3576 is ARMv8.0 and cannot run it or anything later. */
export const MAX_BUILD = 25999;
/** PROCESSOR_ARCHITECTURE_ARM64 in the XML's ARCH element. */
const ARCH_ARM64 = 12;

export interface WimImage {
  index: number;
  name: string;
  displayName: string;
  editionId: string;
  installationType: string;
  arch: number | null;
  build: number | null;
  spBuild: number | null;
  totalBytes: number;
}

export interface WimInfo {
  kind: 'wim' | 'esd';
  partNumber: number;
  totalParts: number;
  images: WimImage[];
  /** Header flag: the file was being written and is not finished. */
  writeInProgress: boolean;
  solid: boolean;
}

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le64 = (b: Uint8Array, o: number) => le32(b, o) + le32(b, o + 4) * 2 ** 32;

function resHdr(b: Uint8Array, o: number) {
  const size = le32(b, o) + b[o + 4] * 2 ** 32 + b[o + 5] * 2 ** 40 + b[o + 6] * 2 ** 48;
  return { size, flags: b[o + 7], offset: le64(b, o + 8), originalSize: le64(b, o + 16) };
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
}

const decodeEntities = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseWimXml(xml: string): WimImage[] {
  const out: WimImage[] = [];
  const re = /<IMAGE\s+INDEX="(\d+)"[^>]*>([\s\S]*?)<\/IMAGE>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const win = /<WINDOWS>([\s\S]*?)<\/WINDOWS>/i.exec(body)?.[1] ?? '';
    const ver = /<VERSION>([\s\S]*?)<\/VERSION>/i.exec(win)?.[1] ?? '';
    const num = (s: string | null) => (s !== null && /^\d+$/.test(s) ? Number(s) : null);
    out.push({
      index: Number(m[1]),
      name: decodeEntities(tag(body, 'NAME') ?? ''),
      displayName: decodeEntities(tag(body, 'DISPLAYNAME') ?? tag(body, 'NAME') ?? ''),
      editionId: tag(win, 'EDITIONID') ?? '',
      installationType: tag(win, 'INSTALLATIONTYPE') ?? '',
      arch: num(tag(win, 'ARCH')),
      build: num(tag(ver, 'BUILD')),
      spBuild: num(tag(ver, 'SPBUILD')),
      totalBytes: num(tag(body, 'TOTALBYTES')) ?? 0,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function readWimInfo(src: ByteSource): WimInfo {
  if (src.size < 208) throw new Error('The file is too small to be a Windows image.');
  const h = src.read(0, 208);
  if (new TextDecoder('latin1').decode(h.subarray(0, 8)) !== 'MSWIM\0\0\0') {
    throw new Error('The file is not a Windows image (.wim or .esd).');
  }
  const flags = le32(h, 16);
  const xml = resHdr(h, 72);
  if (xml.flags & 0x04) throw new Error('The image\'s XML data is compressed, which no Windows image does.');
  if (xml.offset + xml.size > src.size || xml.size > 64 << 20 || xml.size < 2) {
    throw new Error('The image is incomplete: its XML data is missing. Was the download cut short?');
  }
  const raw = src.read(xml.offset, xml.size);
  let text = '';
  const start = raw[0] === 0xff && raw[1] === 0xfe ? 2 : 0;
  for (let i = start; i + 1 < raw.length; i += 2) text += String.fromCharCode(le16(raw, i));
  const version = le32(h, 12);
  return {
    kind: version === 0x00000e00 ? 'esd' : 'wim',
    partNumber: le16(h, 40),
    totalParts: le16(h, 42),
    images: parseWimXml(text),
    writeInProgress: (flags & 0x00000040) !== 0,
    solid: version === 0x00000e00,
  };
}

/** Editions that can be installed (not the setup and WinPE images an ESD from Microsoft also holds). */
export function installable(info: WimInfo): WimImage[] {
  return info.images.filter((i) => i.installationType.toLowerCase() === 'client' || (i.editionId !== '' && i.installationType === ''));
}

/** Why this edition cannot go on an RK3576 board, or null when it can. */
export function refuseReason(img: WimImage): string | null {
  if (img.arch !== ARCH_ARM64) {
    const a = img.arch === 9 ? 'x64' : img.arch === 0 ? 'x86' : img.arch === null ? 'an unknown architecture' : `architecture ${img.arch}`;
    return `This edition is for ${a}, not ARM64. Use a Windows 11 23H2 ARM64 image.`;
  }
  if (img.build === null) return 'The image does not say its build number.';
  if (img.build > MAX_BUILD) {
    return `This is build ${img.build}. RK3576 is ARMv8.0, and Windows 11 24H2 (build 26100) and later cannot run on it. Use Windows 11 23H2 (build 22631).`;
  }
  if (img.build < 19041) return `Build ${img.build} is older than anything tried on these boards. Use Windows 11 23H2 (build 22631).`;
  return null;
}

export function whyNotWholeImage(info: WimInfo): string | null {
  if (info.totalParts > 1) return 'This is one part of a split image (.swm). Use the whole install.wim or install.esd.';
  if (info.writeInProgress) return 'The image was not finished when it was saved (its header says a write was in progress).';
  return null;
}
