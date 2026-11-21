// The macOS in-app update from a DMG, with the real hdiutil, ditto and
// xattr, for CI on macOS (no sudo).
//
//   node test/e2e/update-dmg-mac.mjs
//
// Builds a DMG holding a small stand-in "WoA RK3576 Imager.app" (version "new",
// with the quarantine mark set on it), and runs swapAppFromDmg()
// (src/main/update-mac.ts) against a stand-in for the running app in a
// temporary "Applications" folder. Checks:
//   1. the new app is in place of the old one, complete, executable bit kept;
//   2. the old bundle is put aside until the restart, then removed;
//   3. the new bundle carries no quarantine mark;
//   4. the DMG is detached again and nothing else is left behind;
//   5. a folder that cannot be written sends the app to ~/Applications and
//      leaves the old one alone;
//   6. a file that is not a DMG fails with the old app untouched;
//   7. the version of the swapped bundle can be read the way the app reads
//      it (defaults read .../Contents/Info CFBundleShortVersionString).
// What it cannot check: a real, running Electron app being replaced and
// restarted, and Gatekeeper's verdict on the real app.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
mkdirSync(join(root, 'build/e2e'), { recursive: true });
const bundle = join(root, 'build/e2e/update-mac.cjs');
await build({ entryPoints: ['src/main/update-mac.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'warning' });
const { swapAppFromDmg, removeOldBundle, oldName } = createRequire(import.meta.url)(bundle);

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failures++; };
const work = mkdtempSync(join(tmpdir(), 'update-dmg-'));

function makeApp(dir, version) {
  const app = join(dir, 'WoA RK3576 Imager.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>WoA RK3576 Imager</string>
<key>CFBundleExecutable</key><string>WoA RK3576 Imager</string>
<key>CFBundleIdentifier</key><string>io.github.gahingwoo.woa-rk3576-imager.test</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`);
  const exe = join(app, 'Contents', 'MacOS', 'WoA RK3576 Imager');
  writeFileSync(exe, `#!/bin/sh\necho ${version}\n`);
  chmodSync(exe, 0o755);
  writeFileSync(join(app, 'Contents', 'Resources', 'app.asar'), `resources of ${version}`);
  return app;
}
const versionOf = (app) => sh('/usr/bin/defaults', ['read', join(app, 'Contents', 'Info'), 'CFBundleShortVersionString']);
const quarantined = (path) => { try { sh('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path]); return true; } catch { return false; } };
const mounts = () => sh('/usr/bin/hdiutil', ['info']).split('\n').filter((l) => l.includes('woa-rk3576-imager-dmg-')).length;

try {
  // The DMG of the "new version", its app marked as downloaded.
  const src = join(work, 'dmg-src');
  mkdirSync(src);
  const newApp = makeApp(src, '9.9.9');
  sh('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', join(newApp, 'Contents', 'MacOS', 'WoA RK3576 Imager')]);
  sh('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', newApp]);
  const dmg = join(work, 'woa-rk3576-imager-9.9.9-macos-arm64.dmg');
  sh('/usr/bin/hdiutil', ['create', '-volname', 'WoA RK3576 Imager', '-srcfolder', src, '-format', 'UDZO', dmg]);
  console.log(`DMG ${dmg}, ${statSync(dmg).size} bytes`);
  // The mark must be inside the DMG, or check 3 would prove nothing.
  const probe = join(work, 'probe');
  mkdirSync(probe);
  sh('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', probe, dmg]);
  const marked = quarantined(join(probe, 'WoA RK3576 Imager.app'));
  sh('/usr/bin/hdiutil', ['detach', probe]);
  check(marked, 'the app inside the DMG carries the quarantine mark, as a downloaded one does');

  const apps = join(work, 'Applications');
  const home = join(work, 'home');
  mkdirSync(apps);
  mkdirSync(home);
  const running = makeApp(apps, '0.1.5');
  let log = '';

  const at = await swapAppFromDmg({ dmg, appPath: running, home, onLog: (t) => { log += t; } });
  console.log(log.trim());
  check(at === running, 'the new app is where the old one was');
  check(versionOf(running) === '9.9.9', `the bundle now has version ${versionOf(running)}, read as the app reads it`);
  check(sh(join(running, 'Contents', 'MacOS', 'WoA RK3576 Imager'), []) === '9.9.9', 'its program runs and is the new one');
  check(readFileSync(join(running, 'Contents', 'Resources', 'app.asar'), 'utf8') === 'resources of 9.9.9', 'its resources are the new ones');
  check(!quarantined(running) && !quarantined(join(running, 'Contents', 'MacOS', 'WoA RK3576 Imager')), 'the new bundle carries no quarantine mark');
  check(existsSync(oldName(running)) && versionOf(oldName(running)) === '0.1.5', 'the old bundle is kept aside until the restart');
  check(readdirSync(apps).sort().join() === '.WoA RK3576 Imager.app.old,WoA RK3576 Imager.app', `nothing else is left in the folder (${readdirSync(apps).join(', ')})`);
  check(mounts() === 0, 'the DMG is detached again');
  removeOldBundle(running);
  check(readdirSync(apps).join() === 'WoA RK3576 Imager.app', 'the old bundle is removed at the next start');

  // A folder the user cannot write: the app goes to ~/Applications.
  const locked = join(work, 'Locked');
  mkdirSync(locked);
  const lockedApp = makeApp(locked, '0.1.5');
  chmodSync(locked, 0o555);
  const at2 = await swapAppFromDmg({ dmg, appPath: lockedApp, home });
  chmodSync(locked, 0o755);
  check(at2 === join(home, 'Applications', 'WoA RK3576 Imager.app') && versionOf(at2) === '9.9.9', `a folder that cannot be written: installed at ${at2}`);
  check(versionOf(lockedApp) === '0.1.5' && readdirSync(locked).join() === 'WoA RK3576 Imager.app', 'and the old app there is untouched');

  // Not a DMG: nothing changes.
  const junk = join(work, 'junk.dmg');
  writeFileSync(junk, 'this is not a disk image');
  mkdirSync(join(work, 'Again'));
  const again = makeApp(join(work, 'Again'), '0.1.5');
  let err = '';
  try { await swapAppFromDmg({ dmg: junk, appPath: again, home }); } catch (e) { err = e.message; }
  console.log(`not a DMG: ${err}`);
  check(/Opening the DMG failed/.test(err) && versionOf(again) === '0.1.5' && readdirSync(join(work, 'Again')).join() === 'WoA RK3576 Imager.app', 'a file that is not a DMG fails and leaves the old app untouched');
  check(mounts() === 0, 'nothing is left mounted');
} finally {
  try { chmodSync(join(work, 'Locked'), 0o755); } catch { /* not made */ }
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
