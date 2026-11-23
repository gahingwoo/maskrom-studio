// Armbian onto the whole eMMC, replacing Windows and the UEFI firmware:
// which images, where they come from, and the key they are signed with.
//
// Images come from Armbian's own redirector, dl.armbian.com/<board>/<name>,
// which answers with a redirect to the current file (GitHub releases of
// armbian/community, or a mirror); <name>.sha and <name>.asc next to it are
// the SHA-256 line and the detached OpenPGP signature. Armbian signs images
// with Igor Pecovnik's key DF00FAF1C577104B50BF1D0093D6889F9F0E78D5
// (docs.armbian.com, "Verify image"); its public key packet is pinned here.
// Checked 2026-11-23: both boards have vendor and edge images, minimal
// (CLI, no desktop) on Debian trixie, e.g. Trixie_vendor_minimal ->
// Armbian_community_26.11.0-trunk.137_Lckfb-taishanpi-3m_trixie_vendor_6.1.172_minimal.img.xz

import type { BoardId } from './boards';

export type ArmbianBranch = 'vendor' | 'edge';

export interface ArmbianBoard {
  /** Armbian's board id (BOARD=), and the path on dl.armbian.com. */
  slug: string;
  /** The board's page on armbian.com. */
  page: string;
}

export const ARMBIAN_RESTORE: Partial<Record<BoardId, ArmbianBoard>> = {
  tspi3m: { slug: 'lckfb-taishanpi-3m', page: 'https://www.armbian.com/boards/lckfb-taishanpi-3m' },
  cm5io: { slug: 'armsom-cm5-io', page: 'https://www.armbian.com/boards/armsom-cm5-io' },
};

/** The minimal (command line) image: smallest, and what a restore needs. */
export const ARMBIAN_FLAVOUR = 'Trixie_{branch}_minimal';

export function armbianRedirect(board: ArmbianBoard, branch: ArmbianBranch): string {
  return `https://dl.armbian.com/${board.slug}/${ARMBIAN_FLAVOUR.replace('{branch}', branch)}`;
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
