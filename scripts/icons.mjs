// Lay out the app icon for the packagers. The icon files in resources/icons/
// are made by scripts/make-icons.mjs from woa-rk3576-imager.svg and
// committed; nothing is rendered here. Writes build-res/ (not committed):
//   icon.icns, icon.ico, icon.png        electron-builder (macOS, Windows, Linux)
//   linux-icons/<n>x<n>.png              electron-builder's AppImage icon set
//   hicolor/...                          what the .deb and .rpm install, named
//                                        after the app ID
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const APP_ID = 'io.github.gahingwoo.woa_rk3576_imager';
const SRC = 'resources/icons';
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

rmSync('build-res/hicolor', { recursive: true, force: true });
rmSync('build-res/linux-icons', { recursive: true, force: true });
mkdirSync('build-res/linux-icons', { recursive: true });
copyFileSync(`${SRC}/woa-rk3576-imager.icns`, 'build-res/icon.icns');
copyFileSync(`${SRC}/woa-rk3576-imager.ico`, 'build-res/icon.ico');
copyFileSync(`${SRC}/png/woa-rk3576-imager-512.png`, 'build-res/icon.png');
for (const s of SIZES) {
  copyFileSync(`${SRC}/png/woa-rk3576-imager-${s}.png`, `build-res/linux-icons/${s}x${s}.png`);
  mkdirSync(`build-res/hicolor/${s}x${s}/apps`, { recursive: true });
  copyFileSync(`${SRC}/png/woa-rk3576-imager-${s}.png`, `build-res/hicolor/${s}x${s}/apps/${APP_ID}.png`);
}
mkdirSync('build-res/hicolor/scalable/apps', { recursive: true });
copyFileSync(`${SRC}/woa-rk3576-imager.svg`, `build-res/hicolor/scalable/apps/${APP_ID}.svg`);
mkdirSync('build-res/hicolor/symbolic/apps', { recursive: true });
copyFileSync(`${SRC}/woa-rk3576-imager-symbolic.svg`, `build-res/hicolor/symbolic/apps/${APP_ID}-symbolic.svg`);
console.log('icons in build-res/');
