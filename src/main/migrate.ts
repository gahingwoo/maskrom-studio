// Earlier versions were called "WoA RK3576 Imager" (appId
// io.github.gahingwoo.woa-rk3576-imager), so Electron kept their data in a
// folder of that name. On the first start under the new name the small
// things are copied over: the settings, the page's choices (theme,
// language: Local Storage) and the saved copies of boards' UEFI settings.
// The image cache is left where it is: it is only a cache. No Electron
// here beyond the two paths main.ts passes in.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OLD_PRODUCT_NAME = 'WoA RK3576 Imager';
const CARRIED = ['settings.json', 'Local Storage', 'nvdata-backups'];
const MARK = 'migrated-from-woa-rk3576-imager';

/** Copy what is worth keeping from the old data folder; returns what was copied. */
export function migrateOldData(appData: string, userData: string): string[] {
  const old = join(appData, OLD_PRODUCT_NAME);
  if (old === userData || !existsSync(old) || existsSync(join(userData, MARK))) return [];
  mkdirSync(userData, { recursive: true });
  const copied: string[] = [];
  for (const name of CARRIED) {
    const from = join(old, name);
    const to = join(userData, name);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
      copied.push(name);
    } catch { /* a copy that fails leaves the default in place */ }
  }
  writeFileSync(join(userData, MARK), `${old}\n${copied.join('\n')}\n`);
  return copied;
}
