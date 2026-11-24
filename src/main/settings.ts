// Settings, stored as JSON in the user data folder.
import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRelease } from '../shared/update';
import { isChannel, type Channel } from '../shared/channel';

export interface Settings {
  /** Look for a newer version of the app, at most once a day. */
  updateCheck: boolean;
  /** When the last check ran, ms since the epoch. */
  lastUpdateCheck: number;
  /** Reset the board after a Maskrom write. */
  resetAfterMaskrom: boolean;
  /** Which releases of the app are offered as updates (channel.ts); was betaUpdates. */
  appChannel: Channel;
  /** Which releases of edk2-rk3576 and woa-rk3576 the writes use. */
  firmwareChannel: Channel;
  /** Simple: four steps with the recommended choices; Advanced: every option. */
  uiMode: 'simple' | 'advanced';
  /** The newer release the last check found, repeated at the next start. */
  knownRelease: AppRelease | null;
}

const DEFAULTS: Settings = { updateCheck: true, lastUpdateCheck: 0, resetAfterMaskrom: true, appChannel: 'stable', firmwareChannel: 'stable', uiMode: 'simple', knownRelease: null };

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    return {
      updateCheck: typeof raw.updateCheck === 'boolean' ? raw.updateCheck : DEFAULTS.updateCheck,
      lastUpdateCheck: Number.isFinite(raw.lastUpdateCheck) ? raw.lastUpdateCheck : 0,
      resetAfterMaskrom: typeof raw.resetAfterMaskrom === 'boolean' ? raw.resetAfterMaskrom : DEFAULTS.resetAfterMaskrom,
      // The earlier on/off for betas is the Prerelease tier.
      appChannel: isChannel(raw.appChannel) ? raw.appChannel : raw.betaUpdates === true ? 'prerelease' : 'stable',
      firmwareChannel: isChannel(raw.firmwareChannel) ? raw.firmwareChannel : 'stable',
      // New installs start Simple; an install from before the two modes keeps the page it knew.
      uiMode: raw.uiMode === 'simple' || raw.uiMode === 'advanced' ? raw.uiMode : 'advanced',
      knownRelease: raw.knownRelease && typeof raw.knownRelease.tag_name === 'string' && typeof raw.knownRelease.html_url === 'string'
        && Array.isArray(raw.knownRelease.assets) ? raw.knownRelease : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
}
