// What each board's image in an edk2-rk3576 release supports.
//
// New releases carry FEATURES.json (edk2-rk3576 scripts/features.py,
// docs/dev/features-json.md): made from the build of each image, keyed by the
// image name prefix ("ROCK4D", "CM5IO", "TaishanPi3M"). It is checked against
// SHA256SUMS.txt and GitHub's digest like the images. Releases from before it
// (0.4.1 and older) get the small table below instead.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BoardId } from './boards';
import { WOA_BOARDS } from './boards';

export const FEATURES_ASSET = 'FEATURES.json';
/** The FEATURES.json schema this reads. A newer one is still read for the fields below. */
export const FEATURES_SCHEMA = 1;

/** The features the app looks at, in the order they are listed on the page. */
export const FEATURE_KEYS = ['windows', 'armbianOnce', 'hdmi', 'dsi', 'usbcDp', 'cpuIdle', 'fanControl', 'networkBoot', 'httpBoot', 'secureBoot'] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export interface Feature {
  built: boolean;
  /** "on" / "off", or a mode ("always-on"), for a runtime option; none when not built or not known. */
  default?: string;
}

export interface BoardFeatures {
  features: Partial<Record<FeatureKey, Feature>>;
  /** The firmware's version string ("rk3576-ROCK4D-0.4.1-231-g245a450"), when the release says. */
  firmwareVersion: string | null;
  /** The setup options section of FEATURES.json, kept as it is for the settings editor. */
  settings?: unknown;
}

export interface ReleaseFeatures {
  /** "release": the release's FEATURES.json; "builtin": the table below; null: neither knows this release. */
  from: 'release' | 'builtin' | null;
  boards: Partial<Record<BoardId, BoardFeatures>>;
}

/** FEATURES.json's name for a board: its image prefix ("TaishanPi3M-emmc-edk2-" -> "TaishanPi3M"). */
export function featuresName(id: BoardId): string {
  const b = WOA_BOARDS.find((x) => x.id === id);
  return b ? b.firmwareAsset.split('-')[0] : id;
}

/** Parse FEATURES.json. Throws with a sentence when it is not one. */
export function parseFeatures(text: string): ReleaseFeatures['boards'] {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new Error(`${FEATURES_ASSET} is not JSON`); }
  if (!doc || typeof doc !== 'object') throw new Error(`${FEATURES_ASSET} is not an object`);
  const d = doc as { schema?: unknown; boards?: unknown };
  if (typeof d.schema !== 'number' || d.schema < 1) throw new Error(`${FEATURES_ASSET} has no schema version`);
  if (!d.boards || typeof d.boards !== 'object') throw new Error(`${FEATURES_ASSET} has no boards`);
  const raw = d.boards as Record<string, unknown>;
  const out: ReleaseFeatures['boards'] = {};
  for (const b of WOA_BOARDS) {
    const e = raw[featuresName(b.id)] as { features?: Record<string, unknown>; firmwareVersion?: unknown; settings?: unknown } | undefined;
    if (!e || typeof e !== 'object' || !e.features || typeof e.features !== 'object') continue;
    const features: BoardFeatures['features'] = {};
    for (const k of FEATURE_KEYS) {
      const f = e.features[k] as { built?: unknown; default?: unknown } | undefined;
      if (!f || typeof f.built !== 'boolean') continue;
      features[k] = typeof f.default === 'string' && f.built ? { built: f.built, default: f.default } : { built: f.built };
    }
    out[b.id] = { features, firmwareVersion: typeof e.firmwareVersion === 'string' ? e.firmwareVersion : null, ...(e.settings !== undefined ? { settings: e.settings } : {}) };
  }
  return out;
}

/** Check downloaded FEATURES.json bytes against the SHA-256 the release gives for it, then parse them. */
export function checkedFeatures(bytes: Uint8Array, want: string): ReleaseFeatures['boards'] {
  const got = bytesToHex(sha256(bytes));
  if (got !== want.toLowerCase()) throw new Error(`${FEATURES_ASSET} does not match its SHA-256`);
  return parseFeatures(new TextDecoder().decode(bytes));
}

// Releases without FEATURES.json, read from the edk2-rk3576 tags (the DSC
// defines and the board FDF includes at 0.4.0 and 0.4.1): the ROCK 4D image
// has no ACPI tables, so Windows cannot start from it; no image has the
// "Armbian (U-Boot)" one-shot, USB-C DisplayPort or the CPU idle option.
const f = (built: boolean): Feature => ({ built });
const V04: Partial<Record<BoardId, BoardFeatures>> = {
  rock4d: { firmwareVersion: null, features: { windows: f(false), armbianOnce: f(false), hdmi: f(true), dsi: f(false), usbcDp: f(false), cpuIdle: f(false), fanControl: f(false), networkBoot: f(true), httpBoot: f(true), secureBoot: f(true) } },
  cm5io: { firmwareVersion: null, features: { windows: f(true), armbianOnce: f(false), hdmi: f(true), dsi: f(false), usbcDp: f(false), cpuIdle: f(false), fanControl: f(false), networkBoot: f(true), httpBoot: f(false), secureBoot: f(true) } },
  tspi3m: { firmwareVersion: null, features: { windows: f(true), armbianOnce: f(false), hdmi: f(true), dsi: f(true), usbcDp: f(false), cpuIdle: f(false), fanControl: f(true), networkBoot: f(true), httpBoot: f(false), secureBoot: f(true) } },
};

/** The built-in table for a release without FEATURES.json, or null when it does not know the tag. */
export function builtinFeatures(tag: string): ReleaseFeatures {
  if (/^0\.4\.\d+$/.test(tag)) return { from: 'builtin', boards: V04 };
  return { from: null, boards: {} };
}

/** true / false when the release says, null when nothing is known. */
export function hasFeature(rf: ReleaseFeatures | null | undefined, board: BoardId, key: FeatureKey): boolean | null {
  const v = rf?.boards[board]?.features[key];
  return v ? v.built : null;
}
