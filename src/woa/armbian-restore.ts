// Armbian onto the whole eMMC (replacing Windows and the UEFI firmware) or
// onto an SD card or USB drive: which images exist, where they come from,
// and the key they are signed with.
//
// Which images Armbian publishes for a board comes from Armbian's own index,
// github.armbian.com/armbian-images.json (the "data" branch of
// armbian/armbian.github.io, rebuilt by Armbian's CI; the same data as the
// board pages on armbian.com). Each entry names a redirect,
// dl.armbian.com/<board>/<Distro>_<branch>_<variant>, which answers with a
// redirect to the current file (GitHub releases of armbian/community, or a
// mirror); <redirect>.sha and <redirect>.asc are the SHA-256 line and the
// detached OpenPGP signature. The index only says what to offer: what is
// downloaded must match the .sha and Igor Pecovnik's signature (key
// DF00FAF1C577104B50BF1D0093D6889F9F0E78D5, docs.armbian.com "Verify image"),
// whose public key packet is pinned here.
// (all-images.json, the older index, stopped being updated in 2025-12.)
// Some boards' images are only nightly builds (armbian/ci releases), behind
// dl.armbian.com/nightly/<board>/...: on 2026-11-26 the ROCK 4D's vendor
// images (26.11.0-trunk.140; its edge images are the 26.8.2 release). They
// are signed with the same key, so they are offered too, marked nightly.
// Seen 2026-11-24 for both boards, Armbian 26.11.0-trunk.137: Debian trixie
// minimal (vendor, edge), Ubuntu resolute minimal, GNOME and KDE Plasma
// (vendor, edge); Armbian promotes trixie vendor minimal and resolute vendor GNOME.

import type { BoardId } from './boards';

/** Armbian's kernel branch: vendor (the board maker's kernel), current, edge (newest mainline). */
export type ArmbianBranch = string;

export interface ArmbianBoard {
  /** Armbian's board id (BOARD=), and the path on dl.armbian.com. */
  slug: string;
  /** The board's page on armbian.com. */
  page: string;
}

export const ARMBIAN_RESTORE: Partial<Record<BoardId, ArmbianBoard>> = {
  tspi3m: { slug: 'lckfb-taishanpi-3m', page: 'https://www.armbian.com/boards/lckfb-taishanpi-3m' },
  cm5io: { slug: 'armsom-cm5-io', page: 'https://www.armbian.com/boards/armsom-cm5-io' },
  // Images with mainline U-Boot (v2026.04, FIT at sector 16384) for vendor and edge, checked 2026-11-26.
  rock4d: { slug: 'radxa-rock-4d', page: 'https://www.armbian.com/boards/radxa-rock-4d' },
};

export const ARMBIAN_INDEX = 'https://github.armbian.com/armbian-images.json';

/** One image Armbian publishes for a board: one line of the index. */
export interface ArmbianOffer {
  /** The redirect's name, "Resolute_vendor_gnome": what is looked up and downloaded. */
  id: string;
  /** Debian or Ubuntu codename: "trixie", "resolute". */
  distro: string;
  branch: ArmbianBranch;
  /** "minimal", "server", or a desktop: "gnome", "kde-plasma", "xfce", "cinnamon"... */
  variant: string;
  desktop: boolean;
  version: string;
  kernel: string;
  /** Size of the .img.xz. */
  size: number;
  /** When the file was built, "2026-11-20". */
  date: string;
  /** Armbian marks the images it recommends for the board. */
  promoted: boolean;
  /** A nightly build (dl.armbian.com/nightly/), not a release. */
  nightly: boolean;
}

const NAME_PART = /^[a-z0-9][a-z0-9-]*$/;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The variants without a desktop. Everything else Armbian names in this field is a desktop. */
const NO_DESKTOP = new Set(['minimal', 'server']);
export const isDesktop = (variant: string): boolean => !NO_DESKTOP.has(variant);

/**
 * The plain Armbian images of one board from armbian-images.json: .img.xz
 * files with no preinstalled application (Home Assistant, OMV and the like are
 * left out), the newest build of each distro, branch and variant.
 */
export function parseArmbianIndex(json: unknown, slug: string): ArmbianOffer[] {
  const assets = (json as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) throw new Error('Armbian\'s image index has no list of images.');
  const best = new Map<string, ArmbianOffer>();
  for (const a of assets as Array<Record<string, unknown>>) {
    if (str(a.board_slug) !== slug || str(a.file_extension) !== 'img.xz' || str(a.file_application) !== '') continue;
    const distro = str(a.distro); const branch = str(a.branch); const variant = str(a.variant);
    if (![distro, branch, variant].every((x) => NAME_PART.test(x)) || variant.endsWith('-grub')) continue;
    const redirect = str(a.redi_url);
    const id = redirect.slice(redirect.lastIndexOf('/') + 1);
    const want = `${distro[0].toUpperCase()}${distro.slice(1)}_${branch}_${variant}`;
    const nightly = redirect === `https://dl.armbian.com/nightly/${slug}/${want}`;
    if ((redirect !== `https://dl.armbian.com/${slug}/${want}` && !nightly) || id !== want) continue;
    const size = Number(str(a.file_size));
    if (!Number.isFinite(size) || size <= 0) continue;
    const offer: ArmbianOffer = {
      id, distro, branch, variant, desktop: !NO_DESKTOP.has(variant), version: str(a.armbian_version), kernel: str(a.kernel_version),
      size, date: str(a.file_date).slice(0, 10), promoted: str(a.promoted) === 'true', nightly,
    };
    // A release wins over a nightly build of the same image; else the newer one.
    const had = best.get(id);
    if (!had || (had.nightly && !nightly) || (had.nightly === nightly && offer.date > had.date)) best.set(id, offer);
  }
  // Without a desktop first, then the desktops; Armbian's recommended one of each first.
  return [...best.values()].sort((x, y) => Number(x.desktop) - Number(y.desktop) || x.variant.localeCompare(y.variant)
    || Number(y.promoted) - Number(x.promoted) || BRANCH_ORDER.indexOf(x.branch) - BRANCH_ORDER.indexOf(y.branch) || x.distro.localeCompare(y.distro));
}

const BRANCH_ORDER = ['vendor', 'current', 'edge', 'legacy'];

/** Codenames Armbian builds on, in words; an unknown one stays a codename. */
export const DISTROS: Record<string, string> = {
  bookworm: 'Debian 12 (bookworm)', trixie: 'Debian 13 (trixie)', forky: 'Debian 14 (forky)', sid: 'Debian unstable (sid)',
  jammy: 'Ubuntu 22.04 (jammy)', noble: 'Ubuntu 24.04 (noble)', plucky: 'Ubuntu 25.04 (plucky)', questing: 'Ubuntu 25.10 (questing)',
  resolute: 'Ubuntu 26.04 (resolute)',
};
export const distroWords = (codename: string): string => DISTROS[codename] ?? codename;

/** Desktops by Armbian's variant name: the name to show and the picture in resources/desktops (none: a plain card). */
export const DESKTOPS: Record<string, { name: string; picture?: string }> = {
  gnome: { name: 'GNOME', picture: 'gnome.webp' },
  'kde-plasma': { name: 'KDE Plasma', picture: 'kde-plasma.webp' },
  xfce: { name: 'Xfce' },
  cinnamon: { name: 'Cinnamon' },
  mate: { name: 'MATE' },
  'i3-wm': { name: 'i3' },
};
export const variantWords = (variant: string): string => DESKTOPS[variant]?.name ?? variant;

/**
 * Simple mode's choices: one card per desktop and one without a desktop, all on
 * the board maker's kernel (vendor) as the boards ship it. Armbian's promoted
 * desktop is the recommended one; each other desktop comes on the same distro
 * when Armbian builds it there.
 */
export function simpleOffers(offers: ArmbianOffer[]): { desktops: ArmbianOffer[]; cli: ArmbianOffer | null; recommended: string | null } {
  const vendor = offers.filter((o) => o.branch === 'vendor');
  const pool = vendor.length ? vendor : offers;
  const promotedDesktop = pool.find((o) => o.desktop && o.promoted) ?? null;
  const distro = promotedDesktop?.distro;
  const desktops: ArmbianOffer[] = [];
  for (const variant of [...new Set(pool.filter((o) => o.desktop).map((o) => o.variant))]) {
    const same = pool.filter((o) => o.desktop && o.variant === variant);
    desktops.push(same.find((o) => o.promoted) ?? same.find((o) => o.distro === distro) ?? same[0]);
  }
  // Armbian's promoted desktop first, then as the index orders them.
  desktops.sort((x, y) => Number(y.id === promotedDesktop?.id) - Number(x.id === promotedDesktop?.id));
  const minimal = pool.filter((o) => o.variant === 'minimal');
  const cli = minimal.find((o) => o.promoted) ?? minimal[0] ?? pool.find((o) => !o.desktop) ?? null;
  return { desktops, cli, recommended: desktops[0]?.id ?? cli?.id ?? null };
}

const GiB = 1024 ** 3;
/**
 * The smallest disk an image is written to: the image itself, and room to
 * grow into, since Armbian enlarges its root file system on the first boot.
 * A desktop gets 4 GiB more (updates and the first programs), a system
 * without one 1 GiB.
 */
export function minimumDiskBytes(imageBytes: number, desktop: boolean): number {
  return imageBytes + (desktop ? 4 : 1) * GiB;
}

/** The redirect's name in an offer: Distro_branch_variant, no path. */
export const OFFER_ID = /^[A-Z][a-z0-9]*_[a-z0-9-]+_[a-z0-9-]+$/;

export function armbianRedirect(board: ArmbianBoard, id: string, nightly = false): string {
  if (!OFFER_ID.test(id)) throw new Error(`Not an Armbian image name: ${id}`);
  return `https://dl.armbian.com/${nightly ? 'nightly/' : ''}${board.slug}/${id}`;
}

/**
 * The uncompressed size of an .xz file from its last bytes (the stream footer
 * and the index before it: each block's uncompressed size), or null when the
 * tail given does not hold the whole index. One stream; padding allowed.
 */
export function xzUncompressedSize(tail: Uint8Array): number | null {
  let end = tail.length;
  while (end >= 4 && tail[end - 1] === 0 && tail[end - 2] === 0 && tail[end - 3] === 0 && tail[end - 4] === 0) end -= 4;
  if (end < 12 || tail[end - 2] !== 0x59 || tail[end - 1] !== 0x5a) return null;
  const backward = ((tail[end - 8] | (tail[end - 7] << 8) | (tail[end - 6] << 16) | (tail[end - 5] << 24)) >>> 0) + 1;
  const indexStart = end - 12 - backward * 4;
  if (indexStart < 0 || tail[indexStart] !== 0) return null;
  let p = indexStart + 1;
  const vli = (): number => {
    let v = 0; let mul = 1;
    for (let i = 0; i < 9; i++) {
      const c = tail[p++];
      v += (c & 0x7f) * mul; mul *= 128;
      if (c < 0x80) return v;
    }
    throw new Error('bad xz index');
  };
  try {
    const records = vli();
    let total = 0;
    for (let i = 0; i < records; i++) { vli(); total += vli(); }
    return p <= end - 12 ? total : null;
  } catch { return null; }
}

// The redirect may lead to any mirror Armbian picks for the user's region
// (GitHub, mirror.twds.com.tw, Chinese university mirrors...). The host is
// not what makes the file trustworthy: the SHA-256 and the signature are.

export interface ArmbianFileName {
  file: string;
  /** "26.11.0-trunk.137" */
  version: string;
  /** "community" or "" for a stable release name. */
  channel: string;
  board: string;
  /** Debian or Ubuntu codename: "trixie". */
  distro: string;
  branch: string;
  /** Linux version: "6.1.172". */
  kernel: string;
  variant: string;
}

/** Armbian_community_26.11.0-trunk.137_Lckfb-taishanpi-3m_trixie_vendor_6.1.172_minimal.img.xz */
export function parseArmbianFileName(file: string): ArmbianFileName | null {
  const m = /^Armbian(?:_([a-z]+))?_(\d+\.\d+\.\d+(?:-[\w.]+)?)_([A-Za-z0-9-]+)_([a-z]+)_([a-z]+)_(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)_([\w-]+?)\.img\.xz$/.exec(file);
  if (!m) return null;
  return { file, channel: m[1] ?? '', version: m[2], board: m[3], distro: m[4], branch: m[5], kernel: m[6], variant: m[7] };
}

/** "<sha256> <file name>" (sha256sum format, one line). */
export function parseShaLine(text: string): { sha256: string; file: string } | null {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/im.exec(text.trim());
  return m ? { sha256: m[1].toLowerCase(), file: m[2] } : null;
}

/** Igor Pecovnik's public key, the primary key packet only (gpg --export-options export-minimal). */
export const ARMBIAN_SIGNING_KEY = {
  fingerprint: 'DF00FAF1C577104B50BF1D0093D6889F9F0E78D5',
  packet: 'mQINBFUG8p4BEADGlseGFmdjjfmoXtHpZxqgYHGweCnGZ05LiGgEVgbv5SrTsJsyO8H8RyBPxgbpKEY+JCV1IlYQPaE3Til1+kqmR4XNKbufjEuqAV4VJW3267tYRuJ308E70q7kpQSsEAWLVY+xV/l5stAupp4/wF5BPdAjW7gLuicPnqoKK0jcfrjuvd45WFhpjL1Sdd0PnILehz0to6R2H9MsW+VYYPFztdjBM/78UD8grMcCm/7Mz8ENRKCnTKrgj4bpWA0kPEHNBfaoQQUk5fCJYNMLvLMIGZcWeGOPo+yFnl4C6qTEgs0g7/0E56ycaQDJ+gBCH9YNa8j3eH/t1vMN0ERXiOQf6WXgRihOD1fcnZFmczQFT3GGhv3y+/cUpsUlmhhJ6tetiuXNuTfrl3M+99qUq5/8iiq292MCmn5s0BEOiyfQ2l2uZmjyDUO+4lL9o3MX0W5Xp1puE2p42b+w458aDKuuFvBzVMiU51Js6DZnahxu2s+NDztDgut7p+P60UBCbltXEB0ZIyWTAkKCwIlapZ9yDiHqXiNluTdBiFWGyU3xlb4fuQzwlwvmS3yz4Ak5GCdDpiLmJoHOKV6q85VaI4T3gixx4JwEfdincOGfepSWFmbEsDuVx5vbDV5Dwb3oAg80zp3W/uNyX7G41uIGDNzZL82p2XtgGzkjhEbKAnNavwARAQAB',
};
