// The ROCK 4D's Armbian next to Windows in the real app, made-up releases and
// drives: the setup step says what the firmware must have and how Armbian
// starts (English and Chinese), there is no size slider (Armbian takes the
// card), the review step asks for the NVMe drive and the SD card (not the same
// one) and shows how to put the board in MaskROM; Start first reads the
// board's SPL over MaskROM (test/electron/fake-rock4d-worker.ts). A release's
// SPL stops the job before anything is written; the rock4d-parity SPL lets it
// go on to the Windows write (which then fails here: the releases are made up).
//   node scripts/electron-rock4d-hybrid-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await build({ entryPoints: ['test/electron/fake-rock4d-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome130', outfile: 'build/renderer/fake-rock4d-worker.js', logLevel: 'warning' });
const tmp = mkdtempSync(join(tmpdir(), 'rock4d-hybrid-'));
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

/** Board, task, Windows image, then the setup step with Armbian ticked; returns the page there. */
async function toSetup(page, lang) {
  await page.evaluate((l) => { localStorage.setItem('lang', l); }, lang);
  await page.reload();
  await page.waitForSelector('h2');
  await page.click('label[for="board-rock4d"]');
  await next(page);
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await page.waitForSelector('#dest-nvme');
  await page.click('label[for="dest-nvme"]');
  await next(page);
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file|选择文件/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await next(page);
  await page.waitForSelector('#hybrid-on');
}

/** On to the review step with both drives chosen and the box ticked, then Start; the run's result and stages. */
async function startRun(page) {
  // Windows' own setup on the first start: no account to type here.
  await page.click('label[for="first-oobe"]');
  await page.click('label[for="hybrid-on"]');
  await page.waitForSelector('#hybrid-Trixie_vendor_minimal');
  await page.click('label[for="hybrid-Trixie_vendor_minimal"]');
  await page.waitForSelector('#hybrid-sd-size');
  const setup = {
    sizeSlider: await page.$('#hybrid-size') !== null,
    sdSize: await text(page, '#hybrid-sd-size'),
    vendor: await page.evaluate(() => document.getElementById('hybrid-Trixie_vendor_minimal')?.closest('.pf-v6-c-radio')?.textContent ?? ''),
    edge: await page.evaluate(() => document.getElementById('hybrid-Trixie_edge_minimal')?.closest('.pf-v6-c-radio')?.textContent ?? ''),
    offers: await page.evaluate(() => [...document.querySelectorAll('input[name="hybrid-image"]')].map((x) => x.id)),
  };
  await next(page);
  // Any steps between setup and review (trimming) are passed with their defaults.
  for (let i = 0; i < 4 && !(await page.$('#review-erase')); i++) { await next(page); await page.waitForTimeout(300); }
  await page.waitForSelector('#disk-\\/dev\\/sdx');
  await page.click('label[for="disk-/dev/sdx"]');
  await page.click('label[for="sd-/dev/sdy"]');
  const review = await page.evaluate(() => ({
    sdTakenDisabled: document.getElementById('sd-/dev/sdx')?.disabled ?? null,
    rows: [...document.querySelectorAll('.pf-v6-c-description-list__group')].map((g) => g.textContent),
    maskrom: !!document.querySelector('.pf-v6-c-card'),
    ask: document.querySelector('#review-erase')?.textContent ?? '',
  }));
  await page.click('label[for="review-understood"]');
  const go = await page.evaluate(() => [...document.querySelectorAll('.pf-v6-c-wizard__footer button.pf-m-primary')].map((b) => ({ t: b.textContent, d: b.disabled })));
  await next(page);
  await page.waitForSelector('.pf-v6-c-progress', { timeout: 30000 });
  // The result: an alert with a title once the run has ended.
  await page.waitForFunction(() => /Try again|再试一次|Back|返回/.test(document.body.textContent) && !!document.querySelector('.pf-v6-c-alert__title'), null, { timeout: 120000 });
  const run = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('.pf-v6-c-alert__title')].map((x) => x.textContent),
    progress: [...document.querySelectorAll('.pf-v6-c-progress')].map((p) => p.textContent),
  }));
  return { setup, review, go, run };
}

try {
  // A release's SPL: refused before anything is written; the setup step in English.
  let app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_TEST_WORKER: 'fake-rock4d-worker.js' } });
  let page = await app.firstWindow();
  await toSetup(page, 'en');
  const fw = await text(page, '#hybrid-firmware');
  expect(/Needs firmware with the Armbian one-shot/.test(fw) && /U-Boot v2026\.10/.test(fw) && /reads the SPL from the board over MaskROM/.test(fw), 'the setup step says what the firmware must have, before anything is ticked');
  expect(/writes a one-time request to the SD card and restarts/.test(fw) && /is Windows again/.test(fw), 'and how Armbian starts');
  expect(/Also write Armbian to an SD card/.test(await text(page, 'label[for="hybrid-on"]')), 'the box says SD card, not eMMC');
  const a = await startRun(page);
  console.log(JSON.stringify(a, null, 2));
  expect(!a.setup.sizeSlider && /whole SD card/.test(a.setup.sdSize), 'no size slider: Armbian takes the card');
  expect(a.setup.offers.includes('hybrid-Trixie_vendor_minimal') && a.setup.offers.includes('hybrid-Trixie_edge_minimal'), 'vendor and edge kernels are offered');
  expect(/nightly/.test(a.setup.vendor) && !/nightly/.test(a.setup.edge), 'a nightly build says so');
  expect(a.review.sdTakenDisabled === true, 'the drive chosen for Windows cannot also be the Armbian card');
  expect(a.review.rows.some((r) => /Checked first/.test(r) && /read over MaskROM/.test(r)) && a.review.rows.some((r) => /Erased for Armbian.*SD card reader/.test(r)), 'the review names the check and both drives');
  expect(a.review.maskrom, 'the review shows how to put the board in MaskROM');
  expect(a.run.titles.some((x) => /cannot start Armbian from the SD card/.test(x)), `a release's SPL stops the job (${a.run.titles.join(' | ')})`);
  expect(!a.run.progress.some((x) => /Download, check, write|Written/.test(x) && /100%/.test(x)), 'nothing was written to the drives');
  await app.close();

  // The rock4d-parity SPL: the check passes and the job goes on to Windows; the setup step in Chinese.
  app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_TEST_WORKER: 'fake-rock4d-worker.js?spl=once' } });
  page = await app.firstWindow();
  await toSetup(page, 'zh-CN');
  const zh = await text(page, '#hybrid-firmware');
  expect(/需要带 Armbian 单次启动的固件/.test(zh) && /一次性的请求/.test(zh), 'the firmware note in Chinese');
  const b = await startRun(page);
  console.log(JSON.stringify(b.run, null, 2));
  expect(b.run.progress.some((x) => /能：它的 SPL 带 Armbian 单次启动/.test(x)), 'the check passes on the new SPL');
  expect(!b.run.titles.some((x) => /cannot start Armbian|不能从 SD 卡启动 Armbian/.test(x)), 'and does not stop the job');
  await app.close();
} finally {
  rmSync('build/renderer/fake-rock4d-worker.js', { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) { console.error(`FAIL:\n${failures.join('\n')}`); process.exit(1); }
console.log('PASS: the ROCK 4D\'s Armbian next to Windows checks the firmware first and says how it starts');
