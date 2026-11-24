// The screenshots of README.md and docs/screenshots.md, from the built app,
// hidden, at 1100x780: made-up releases (no network but the MaskROM loader
// pieces), the Windows image of test/fixtures, a made-up x64 install.wim,
// a made-up firmware image, and for the firmware upgrade a pretend
// TaishanPi 3M running edk2-rk3576 0.4.1 (test/electron/fake-board-worker.ts).
// Paths show a neutral profile, not the machine's.
//   npm run build && node scripts/readme-shots.mjs [OUT_DIR]
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/imgs';
// SHOT_SIZE=900x600 for a check at a smaller window; the README set is 1100x780.
const [W, H] = (process.env.SHOT_SIZE ?? '1100x780').split('x').map(Number);
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'readme-shots-'));
await build({ entryPoints: ['test/electron/fake-board-worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'chrome130',
  outfile: 'build/renderer/fake-board-worker.js', loader: { '.bin': 'binary' }, logLevel: 'warning' });
await build({ entryPoints: ['test/edk2-fixture.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(tmp, 'fixture.mjs'), logLevel: 'warning' });
const { edk2Image } = await import(join(tmp, 'fixture.mjs'));

const iso = join(tmp, 'Win11_23H2_ARM64.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));
const firmware = join(tmp, 'TaishanPi3M-emmc-edk2-0.4.2.img');
writeFileSync(firmware, edk2Image({ version: '0.4.2' }));

// An x64 install.wim: a WIM header and its UTF-16 XML, as the tests make one.
const x64 = join(tmp, 'install.wim');
{
  const xml = '<WIM><IMAGE INDEX="1"><TOTALBYTES>16000000000</TOTALBYTES><WINDOWS><ARCH>9</ARCH><EDITIONID>Professional</EDITIONID>'
    + '<INSTALLATIONTYPE>Client</INSTALLATIONTYPE><LANGUAGES><LANGUAGE>en-US</LANGUAGE><DEFAULT>en-US</DEFAULT></LANGUAGES>'
    + '<VERSION><MAJOR>10</MAJOR><MINOR>0</MINOR><BUILD>22631</BUILD><SPBUILD>2861</SPBUILD></VERSION></WINDOWS>'
    + '<NAME>Windows 11 Pro</NAME><DISPLAYNAME>Windows 11 Pro</DISPLAYNAME></IMAGE></WIM>';
  const x = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  const b = Buffer.alloc(208 + 4096 + x.length);
  b.write('MSWIM\0\0\0', 0, 'latin1');
  b.writeUInt32LE(208, 8); b.writeUInt32LE(0x00010d00, 12); b.writeUInt16LE(1, 40); b.writeUInt16LE(1, 42); b.writeUInt32LE(1, 44);
  b.writeUInt32LE(x.length, 72); b[79] = 2; b.writeUInt32LE(208 + 4096, 80); b.writeUInt32LE(x.length, 88);
  x.copy(b, 208 + 4096);
  writeFileSync(x64, b);
}

const base = {
  ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_PICK: iso, WOA_IMAGER_TEST_FIRMWARE: firmware,
  WOA_IMAGER_SHOW_DATA_DIR: '/home/user/.config/Maskrom Studio',
  // A fresh profile, so nothing of this machine's shows or is touched (Linux).
  XDG_CONFIG_HOME: join(tmp, 'config'),
};
delete base.ELECTRON_RUN_AS_NODE;
const errors = [];

async function session(name, { theme = 'light', lang = 'en', env = {}, size = [W, H] }, steps) {
  const app = await electron.launch({ args: ['.'], env: { ...base, ...env } });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), size);
  await page.evaluate(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, lang]);
  await page.reload();
  await page.waitForSelector('h2');
  await page.waitForTimeout(600);
  const shot = async (file) => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(join(out, `${file}${theme === 'dark' ? '-dark' : ''}${lang === 'en' ? '' : `-${lang}`}.png`), Buffer.from(b64, 'base64'));
  };
  try { await steps(page, shot); } catch (e) { errors.push(`${name}: ${e.message}`); }
  await app.close();
}

const next = (page) => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
const button = (page, re) => page.evaluate((src) => { [...document.querySelectorAll('button')].find((b) => new RegExp(src).test(b.textContent))?.click(); }, re);
const toTask = async (page, task) => {
  await page.click('label[for="board-tspi3m"]');
  await next(page);
  await page.waitForSelector(`#task-${task}`);
  await page.click(`label[for="task-${task}"]`);
};

// The Windows path: board, task, image (accepted, with a refused edition), setup with a disk layout, review.
const windowsFlow = (only) => async (page, shot) => {
  if (!only || only.includes('board')) await shot('board');
  await toTask(page, 'windows');
  await shot('task');
  if (only && !only.includes('setup')) return;
  await next(page);
  await page.waitForSelector('.drop');
  await button(page, 'Choose a file|选择文件');
  await page.waitForSelector('text=Windows 11 Pro');
  if (!only) {
    await page.locator('.pf-v6-c-table').scrollIntoViewIfNeeded();
    await shot('windows-image');
  }
  await next(page);
  await page.waitForSelector('#first-skip');
  await page.click('label[for="first-skip"]');
  await page.fill('#acc-user', 'woa');
  await page.fill('#acc-password', 'example');
  await page.fill('#acc-password2', 'example');
  await page.click('label[for="layout-custom"]');
  await page.fill('#layout-win', '40');
  await page.click('label[for="rest-exfat"]');
  await page.fill('#layout-linux', '8');
  await page.locator('dl[aria-label]').last().scrollIntoViewIfNeeded();
  await shot('windows-setup');
  if (only) return;
  await next(page);
  await page.waitForSelector('text=Connect and write');
  await shot('review');
};

await session('windows', {}, windowsFlow(null));
for (const o of [{ theme: 'dark' }, { lang: 'zh-CN' }]) await session(`windows ${JSON.stringify(o)}`, o, windowsFlow(['task', 'setup']));

await session('x64', { env: { WOA_IMAGER_TEST_PICK: x64 } }, async (page, shot) => {
  await toTask(page, 'windows');
  await next(page);
  await page.waitForSelector('.drop');
  await button(page, 'Choose a file');
  await page.waitForSelector('text=cannot be installed');
  await page.locator('.pf-v6-c-table').scrollIntoViewIfNeeded();
  await shot('windows-image-refused');
});

const armbianShots = async (page, shot) => {
  await toTask(page, 'armbian');
  await next(page);
  await page.waitForSelector('text=26.11.0-trunk.137');
  await page.waitForSelector('#armbian-offers');
  await shot('armbian');
  await page.click('label[for="restore-to-drive"]');
  await page.waitForSelector('#restore-to-drive:checked');
  await page.waitForTimeout(300);
  await shot('armbian-drive');
};
await session('armbian', {}, armbianShots);
for (const o of [{ theme: 'dark' }, { lang: 'zh-CN' }]) await session(`armbian ${JSON.stringify(o)}`, o, armbianShots);

// The firmware upgrade against the pretend board: the confirmation, then the finished run.
await session('upgrade', { env: { WOA_IMAGER_TEST_WORKER: 'fake-board-worker.js' } }, async (page, shot) => {
  await toTask(page, 'upgrade');
  await next(page);
  await page.waitForSelector('text=rk3576-lckfb-tspi-3m');
  await next(page);
  await page.click('.pf-v6-c-wizard__footer button:has-text("Connect and write")');
  await page.click('.pf-v6-c-modal-box button:has-text("Connect")');
  await page.waitForSelector('text=Upgrade the firmware?', { timeout: 120000 });
  await page.waitForTimeout(500);
  await shot('upgrade-confirm');
  await page.click('.pf-v6-c-card button:has-text("Upgrade")');
  await page.waitForSelector('text=The firmware is upgraded', { timeout: 180000 });
  await shot('upgrade-done');
});

// Simple mode: four steps, for the TaishanPi 3M and Windows; the CM5-IO's flashing-mode step.
const simple = (boardId) => async (page, shot) => {
  await page.click(`#s-board-${boardId}`);
  if (boardId === 'tspi3m') await shot('simple-board');
  await next(page);
  await page.waitForSelector('#s-task-windows');
  await page.click('label[for="s-task-windows"]');
  await button(page, 'Choose the Windows file|选择 Windows 文件');
  await page.waitForSelector('.pf-m-success');
  if (boardId === 'tspi3m') await shot('simple-what');
  await next(page);
  await page.waitForSelector('.pf-v6-c-card ol');
  await page.waitForTimeout(400);
  await shot(`simple-ready${boardId === 'tspi3m' ? '' : `-${boardId}`}`);
  if (boardId !== 'tspi3m') return;
  await next(page);
  await page.waitForSelector('#s-understand');
  await shot('simple-confirm');
};
const simpleEnv = { env: { WOA_IMAGER_UI_MODE: 'simple' } };
await session('simple', simpleEnv, simple('tspi3m'));
await session('simple cm5io', simpleEnv, simple('cm5io'));
for (const o of [{ theme: 'dark' }, { lang: 'zh-CN' }]) await session(`simple ${JSON.stringify(o)}`, { ...o, ...simpleEnv }, simple('tspi3m'));
// The same step as a Windows PC shows it: the WinUSB driver steps with Zadig, below the photo.
const readyOnWindows = async (page, shot) => {
  await page.click('#s-board-cm5io');
  await next(page);
  await page.click('label[for="s-task-windows"]');
  await button(page, 'Choose the Windows file|选择 Windows 文件');
  await page.waitForSelector('.pf-m-success');
  await next(page);
  await page.waitForSelector('.pf-v6-c-card ol');
  await page.locator('.pf-v6-c-card ol').last().scrollIntoViewIfNeeded();
  await shot('simple-ready-windows');
};
for (const o of [{}, { lang: 'zh-CN' }]) await session(`ready windows ${JSON.stringify(o)}`, { ...o, env: { WOA_IMAGER_UI_MODE: 'simple', WOA_IMAGER_SHOW_PLATFORM: 'win32' } }, readyOnWindows);

// Simple mode's Armbian choice: a card per desktop Armbian publishes, and one without a desktop.
const simpleArmbian = async (page, shot) => {
  await page.click('#s-board-tspi3m');
  await next(page);
  await page.click('label[for="s-task-armbian"]');
  await page.waitForSelector('#s-armbian-Resolute_vendor_gnome');
  await page.waitForSelector('text=26.11.0-trunk.137');
  await page.locator('#s-armbian-Trixie_vendor_minimal').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot('simple-armbian');
};
await session('simple armbian', simpleEnv, simpleArmbian);
for (const o of [{ theme: 'dark' }, { lang: 'zh-CN' }]) await session(`simple armbian ${JSON.stringify(o)}`, { ...o, ...simpleEnv }, simpleArmbian);

// Advanced to Simple with a non-default choice: the dialog that lists what goes back.
await session('mode switch', {}, async (page, shot) => {
  await toTask(page, 'uefi-keep');
  await page.click('#mode-toggle');
  await page.waitForSelector('#mode-simple');
  await shot('mode-menu');
  await page.click('#mode-simple');
  await page.waitForSelector('#mode-title');
  await page.waitForTimeout(400);
  await shot('mode-switch');
});

// Narrow: the masthead has no room for the mode choice; Settings has it.
await session('narrow', { ...simpleEnv, size: [720, 640] }, async (page, shot) => {
  await shot('simple-narrow');
  await page.click('.pf-v6-c-masthead button:has-text("Settings")');
  await page.waitForSelector('#set-mode-simple');
  await page.waitForTimeout(500);
  await shot('simple-narrow-settings');
});

const about = async (page, shot) => {
  await page.click('.pf-v6-c-masthead button:has-text("Settings"), .pf-v6-c-masthead button:has-text("设置")');
  await page.waitForSelector('.pf-v6-c-modal-box');
  await page.waitForTimeout(800);
  await shot('settings');
  await page.click('button:has-text("Clear cache"), button:has-text("清除缓存")');
  await page.waitForSelector('#clear-title');
  await page.waitForTimeout(400);
  await shot('clear-cache');
  await page.click('.pf-v6-c-modal-box button.pf-m-link:has-text("Cancel"), .pf-v6-c-modal-box button.pf-m-link:has-text("取消")');
  await page.click('#about-open');
  await page.waitForSelector('#about-title');
  await page.waitForTimeout(500);
  await shot('about');
};
await session('about', {}, about);
for (const o of [{ theme: 'dark' }, { lang: 'zh-CN' }]) await session(`about ${JSON.stringify(o)}`, o, about);

rmSync('build/renderer/fake-board-worker.js', { force: true });
rmSync(tmp, { recursive: true, force: true });
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`screenshots in ${out}`);
