// What a Windows image holds, read from its header and XML data: the
// editions, their architecture and build. This is what the deploy script
// learns from dism /Get-ImageInfo, asked before anything is written, so a
// 24H2 or an x64 image is refused on this computer instead of on the board.
//
// WIM and ESD share the header (wimlib's documentation of the format,
// "MSWIM\0\0\0", 208 bytes). The XML data is a UTF-16 document that is never
// compressed, also in solid ESD files.

import type { ByteSource } from './pieces';
import { NEWEST_BUILD, OLDEST_BUILD, windowsVersion } from '../shared/windows-version';

/** Build 26100 is 24H2: it needs ARMv8.1 atomics, which RK3576 lacks. Previews below it are refused too. */
export const MAX_BUILD = NEWEST_BUILD;
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
  /** VERSION/MAJOR: 10 for Windows 10 and 11 alike. */
  major: number | null;
  totalBytes: number;
  /** Language tags from the XML (en-US), the default one first. */
  languages: string[];
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

function languagesOf(win: string): string[] {
  const block = /<LANGUAGES>([\s\S]*?)<\/LANGUAGES>/i.exec(win)?.[1] ?? '';
  const all = [...block.matchAll(/<LANGUAGE>([^<]*)<\/LANGUAGE>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const def = tag(block, 'DEFAULT');
  return def && all.includes(def) ? [def, ...all.filter((l) => l !== def)] : all;
}

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
      major: num(tag(ver, 'MAJOR')),
      totalBytes: num(tag(body, 'TOTALBYTES')) ?? 0,
      languages: languagesOf(win),
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

/** PROCESSOR_ARCHITECTURE_* values that can appear in the XML's ARCH element. */
export function archName(arch: number | null): string {
  if (arch === ARCH_ARM64) return 'ARM64';
  if (arch === 9) return 'x64';
  if (arch === 0) return 'x86';
  if (arch === 5) return 'ARM (32 bit)';
  return arch === null ? 'unknown' : `architecture ${arch}`;
}

/** Windows 10 2004 (build 19041), the oldest release installed (KMDF 1.31). */
export const MIN_BUILD = OLDEST_BUILD;

const RELEASES: Record<number, string> = {
  17763: 'Windows 10 1809', 18362: 'Windows 10 1903', 18363: 'Windows 10 1909',
  26100: 'Windows 11 24H2', 26200: 'Windows 11 25H2',
};

/** The Windows release a build number is, as Microsoft names it, or null for a preview build. */
export function releaseName(build: number | null): string | null {
  if (build === null) return null;
  return windowsVersion(build)?.name ?? RELEASES[build] ?? (build >= 26100 ? 'Windows 11 24H2 or later' : null);
}

const USE = 'Use Windows 10 2004 to 22H2 (builds 19041 to 19045) or Windows 11 21H2, 22H2 or 23H2 (builds 22000, 22621, 22631).';

/**
 * What the imager says about one edition, from the XML's ARCH, BUILD and
 * MAJOR (the edition's name is only shown):
 * - "ok": ARM64 and a release in shared/windows-version.ts (Windows 10
 *   19041 to 19045, Windows 11 22000, 22621, 22631); what a release still
 *   lacks on these boards is said by versionNotes there, not here;
 * - "refuse": not ARM64; no build number; older than 19041 (tooold); 24H2
 *   (26100) and later, which need ARMv8.1 atomics (new); any other build,
 *   a preview or a server build (preview).
 * `code` and `vars` let the page show the same sentence in its own language.
 */
export interface EditionCheck {
  level: 'ok' | 'refuse';
  code: 'ok' | 'arch' | 'nobuild' | 'new' | 'tooold' | 'preview';
  vars: Record<string, string>;
  text: string | null;
}

export function checkEdition(img: Pick<WimImage, 'arch' | 'build'> & { major?: number | null }): EditionCheck {
  const r = (level: EditionCheck['level'], code: EditionCheck['code'], text: string | null, vars: Record<string, string> = {}): EditionCheck => ({ level, code, vars, text });
  if (img.arch !== ARCH_ARM64) {
    const a = archName(img.arch);
    return r('refuse', 'arch', `This edition is for ${a}, not ARM64. Use an ARM64 image of Windows 10 or Windows 11.`, { arch: a });
  }
  const b = img.build;
  if (b === null) return r('refuse', 'nobuild', 'The image does not say its build number.');
  const build = String(b);
  if (b >= 26000) {
    return r('refuse', 'new', `This is build ${b}. Windows 11 24H2 (build 26100) and later need the ARMv8.1 atomic instructions, which the RK3576's Cortex-A72 and Cortex-A53 cores do not have, so they cannot run on it. Use Windows 11 23H2 (build 22631) or older.`, { build });
  }
  if (b < MIN_BUILD || (img.major != null && img.major < 10)) {
    return r('refuse', 'tooold', `Build ${b} is older than Windows 10 2004 (build 19041), the oldest release the RK3576 drivers are built for. ${USE}`, { build });
  }
  if (windowsVersion(b)) return r('ok', 'ok', null, { build });
  return r('refuse', 'preview', `Build ${b} is a preview (Insider) or server build, not a Windows release this app installs. ${USE}`, { build });
}

/** Why this edition cannot go on an RK3576 board, or null when it can. */
export function refuseReason(img: Pick<WimImage, 'arch' | 'build'> & { major?: number | null }): string | null {
  const c = checkEdition(img);
  return c.level === 'refuse' ? c.text : null;
}

/**
 * Which CPUs an ISO starts, from the names in its efi\boot folder. Microsoft's
 * ARM64 ISOs have bootaa64.efi, the PC ones bootx64.efi (and bootia32.efi).
 */
export interface BootFiles { arm64: boolean; x64: boolean; x86: boolean }

export function bootFilesFrom(names: string[]): BootFiles {
  const has = (n: string) => names.some((x) => x.toLowerCase() === n);
  return { arm64: has('bootaa64.efi'), x64: has('bootx64.efi'), x86: has('bootia32.efi') };
}

/** Why an ISO with these boot files and editions must be refused as a whole, or null. */
export function bootFilesProblem(boot: BootFiles | null, editions: Array<Pick<WimImage, 'arch'>>): string | null {
  if (!boot) return null;
  const pc = boot.x64 || boot.x86;
  if (pc && !boot.arm64) {
    return 'This ISO starts PCs (its efi\\boot folder has bootx64.efi, not bootaa64.efi): it is an x64 Windows ISO. Use an ARM64 Windows ISO.';
  }
  if (boot.arm64 && editions.length > 0 && editions.every((e) => e.arch !== null && e.arch !== ARCH_ARM64)) {
    return 'This ISO starts ARM64 computers but its install image holds no ARM64 edition. It was put together by hand; use an ISO from Microsoft or UUP dump.';
  }
  return null;
}

export function whyNotWholeImage(info: WimInfo): string | null {
  if (info.totalParts > 1) return 'This is one part of a split image (.swm). Use the whole install.wim or install.esd.';
  if (info.writeInProgress) return 'The image was not finished when it was saved (its header says a write was in progress).';
  return null;
}
