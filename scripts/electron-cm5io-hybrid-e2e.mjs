// The CM5-IO's Armbian next to Windows in the real app, made-up releases and
// drives: Windows on the eMMC, Armbian on an SD card. The setup step says the
// firmware must be 0.5.0 or later and that the request goes on the eMMC
// (English and Chinese), there is no size slider (Armbian takes the card), the
// review step asks for the SD card only (Windows goes to the eMMC) and shows
// how to put the board in MaskROM; Start first reads the SPL from the board's
// eMMC over MaskROM (test/electron/fake-cm5io-worker.ts). An older SPL stops
// the job before anything is written; the 0.5.0 SPL lets it go on to the
// Windows downloads (which then fail here: the releases are made up). With
// Windows on the NVMe drive the box is offered too, with both drives to pick.
// Screenshots go to shots/ (CI uploads them with the others).
//   node scripts/electron-cm5io-hybrid-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await build({ entryPoints: ['test/electron/fake-cm5io-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome130', outfile: 'build/renderer/fake-cm5io-worker.js', logLevel: 'warning' });
const tmp = mkdtempSync(join(tmpdir(), 'cm5io-hybrid-'));
const shots = 'shots';
mkdirSync(shots, { recursive: true });
const iso = join(tmp, 'Win11_23H2_ARM64.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));
const drive = (device, description, size, kind) => ({ device, description, size, mountpoints: [], kind, internal: null, warning: null, disabled: null });
const drives = [drive('/dev/sdx', 'USB NVMe enclosure', 256e9, 'usb'), drive('/dev/sdy', 'SD card reader', 32e9, 'sd')];
const base = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_PICK: iso, WOA_IMAGER_FAKE_DRIVES: JSON.stringify(drives) };
delete base.ELECTRON_RUN_AS_NODE;
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); else console.log(`ok: ${what}`); };

const next = (page) => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);

/** Board, task, where Windows goes, Windows image, then the setup step; returns the page there. */
async function toSetup(page, lang, dest) {
  await page.evaluate((l) => { localStorage.setItem('lang', l); }, lang);
  await page.reload();
  await page.waitForSelector('h2');
  await page.click('label[for="board-cm5io"]');
  await next(page);
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await page.waitForSelector(`#dest-${dest}`);
  await page.click(`label[for="dest-${dest}"]`);
  await next(page);
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file|选择文件/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await next(page);
  await page.waitForSelector('#hybrid-on');
}

/** Tick the box and pick an image; what the setup step then shows. */
async function tick(page) {
  await page.click('label[for="first-oobe"]');
  await page.click('label[for="hybrid-on"]');
  await page.waitForSelector('#hybrid-Trixie_vendor_minimal');
  await page.click('label[for="hybrid-Trixie_vendor_minimal"]');
  await page.waitForSelector('#hybrid-sd-size');
  return {
    sizeSlider: await page.$('#hybrid-size') !== null,
    sdSize: await text(page, '#hybrid-sd-size'),
    desc: await page.evaluate(() => document.getElementById('hybrid-on')?.closest('.pf-v6-c-check')?.textContent ?? ''),
    offers: await page.evaluate(() => [...document.querySelectorAll('input[name="hybrid-image"]')].map((x) => x.id)),
  };
}

/** On to the review step. */
async function toReview(page) {
  await next(page);
  // Any steps between setup and review (trimming) are passed with their defaults.
  for (let i = 0; i < 4 && !(await page.$('#review-erase')); i++) { await next(page); await page.waitForTimeout(300); }
  await page.waitForSelector('#sd-\\/dev\\/sdy');
}

/** The review step with the card chosen, then Start; the run's result and stages. */
async function startRun(page, shot) {
  const setup = await tick(page);
  await page.screenshot({ path: join(shots, `${shot}-setup.png`), fullPage: true });
  await toReview(page);
  await page.click('label[for="sd-/dev/sdy"]');
  const review = await page.evaluate(() => ({
    diskPicker: !!document.querySelector('input[name="disk"]'),
    rows: [...document.querySelectorAll('.pf-v6-c-description-list__group')].map((g) => g.textContent),
    maskrom: !!document.querySelector('.pf-v6-c-card'),
    ask: document.querySelector('#review-erase')?.textContent ?? '',
  }));
  if (await page.$('#review-understood')) await page.click('label[for="review-understood"]');
  await page.screenshot({ path: join(shots, `${shot}-review.png`), fullPage: true });
  await next(page);
  await page.waitForSelector('.pf-v6-c-progress', { timeout: 30000 });
  await page.waitForFunction(() => /Try again|再试一次|Back|返回/.test(document.body.textContent) && !!document.querySelector('.pf-v6-c-alert__title'), null, { timeout: 120000 });
  await page.screenshot({ path: join(shots, `${shot}-run.png`), fullPage: true });
  const run = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('.pf-v6-c-alert__title')].map((x) => x.textContent),
    progress: [...document.querySelectorAll('.pf-v6-c-progress')].map((p) => p.textContent),
  }));
  return { setup, review, run };
}

try {
  // An older SPL on the eMMC: refused before anything is written; the setup step in English.
  let app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_TEST_WORKER: 'fake-cm5io-worker.js' } });
  let page = await app.firstWindow();
  await toSetup(page, 'en', 'emmc');
  const fw = await text(page, '#hybrid-firmware');
  expect(/keeps its firmware on the eMMC/.test(fw) && /0\.5\.0 or later/.test(fw) && /reads the SPL from the board's eMMC over MaskROM/.test(fw), 'the setup step says what the firmware must have, before anything is ticked');
  expect(/writes a one-time request to the eMMC and restarts/.test(fw) && /from the SD card/.test(fw) && /starts Windows from the eMMC/.test(fw) && /is Windows again/.test(fw), 'and how Armbian starts');
  expect(/Also write Armbian to an SD card/.test(await text(page, 'label[for="hybrid-on"]')), 'the box says SD card, not eMMC');
  expect(/\(experimental\)/.test(await text(page, 'label[for="hybrid-on"]')) && /not yet been run from start to finish on a board/.test(await text(page, '#hybrid-experimental')), 'the box says it is experimental');
  const a = await startRun(page, 'cm5io-hybrid-emmc');
  console.log(JSON.stringify(a, null, 2));
  expect(!a.setup.sizeSlider && /whole SD card/.test(a.setup.sdSize), 'no size slider: Armbian takes the card');
  expect(/Windows goes onto the eMMC, Armbian onto an SD card/.test(a.setup.desc), 'the box says Windows goes onto the eMMC');
  expect(a.setup.offers.includes('hybrid-Trixie_vendor_minimal'), 'Armbian images are offered');
  expect(!a.review.diskPicker, 'no drive to pick for Windows: it goes to the eMMC');
  expect(a.review.rows.some((r) => /Checked first/.test(r) && /read over MaskROM/.test(r)) && a.review.rows.some((r) => /Erased for Armbian.*SD card reader/.test(r)), 'the review names the check and the card');
  expect(a.review.rows.some((r) => /except the firmware partition/.test(r)), 'and that the eMMC keeps its firmware');
  expect(/erase the eMMC and the SD card/.test(a.review.ask), 'the question names the eMMC and the card');
  expect(a.review.maskrom, 'the review shows how to put the board in MaskROM');
  expect(a.run.titles.some((x) => /cannot start Armbian from the SD card: its SPL \(eMMC, sectors 64 to 2111\)/.test(x) && /0\.5\.0 or later/.test(x)), `an older SPL stops the job (${a.run.titles.join(' | ')})`);
  expect(!a.run.progress.some((x) => /Written/.test(x) && /100%/.test(x)), 'nothing was written');
  await app.close();

  // The 0.5.0 SPL: the check passes and the job goes on to Windows; the setup step in Chinese.
  app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_TEST_WORKER: 'fake-cm5io-worker.js?spl=once' } });
  page = await app.firstWindow();
  await toSetup(page, 'zh-CN', 'emmc');
  const zh = await text(page, '#hybrid-firmware');
  expect(/需要带 Armbian 单次启动的固件/.test(zh) && /在 eMMC 上写一个一次性的请求/.test(zh) && /平时从 eMMC 启动 Windows/.test(zh), 'the firmware note in Chinese');
  expect(/实验性/.test(await text(page, 'label[for="hybrid-on"]')) && /实验性功能/.test(await text(page, '#hybrid-experimental')), 'and says it is experimental in Chinese');
  const b = await startRun(page, 'cm5io-hybrid-emmc-zh');
  console.log(JSON.stringify(b.run, null, 2));
  expect(b.run.progress.some((x) => /能：它的 SPL 带 Armbian 单次启动/.test(x)), 'the check passes on the 0.5.0 SPL');
  expect(!b.run.titles.some((x) => /cannot start Armbian|不能从 SD 卡启动 Armbian/.test(x)), 'and does not stop the job');
  await app.close();

  // Windows on the NVMe drive: the box is there too, and the review asks for both drives.
  app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_TEST_WORKER: 'fake-cm5io-worker.js?spl=once' } });
  page = await app.firstWindow();
  await toSetup(page, 'en', 'nvme');
  expect(/starts Windows from an NVMe drive/.test(await text(page, '#hybrid-firmware')), 'with NVMe the note says Windows starts from the NVMe drive');
  const c = await tick(page);
  expect(/Windows goes onto an NVMe drive/.test(c.desc), 'and the box says so');
  await toReview(page);
  await page.waitForSelector('#disk-\\/dev\\/sdx');
  await page.click('label[for="disk-/dev/sdx"]');
  const taken = await page.evaluate(() => document.getElementById('sd-/dev/sdx')?.disabled ?? null);
  expect(taken === true, 'the drive chosen for Windows cannot also be the Armbian card');
  await page.screenshot({ path: join(shots, 'cm5io-hybrid-nvme-review.png'), fullPage: true });
  await app.close();
} finally {
  rmSync('build/renderer/fake-cm5io-worker.js', { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) { console.error(`FAIL:\n${failures.join('\n')}`); process.exit(1); }
console.log('PASS: the CM5-IO\'s Armbian next to Windows checks the eMMC SPL first and says how it starts');
