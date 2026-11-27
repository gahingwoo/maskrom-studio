// "Windows + Armbian" on one NVMe drive for the CM5-IO, in the real app with
// made-up releases and drives (boards.ts oneDisk 'nvme').
//
// Simple mode: the main menu offers "Windows + Armbian (experimental)" next
// to "Install Windows"; it asks for the NVMe drive (a 4 GB stick is listed
// greyed out with the sizes, not left out), offers Armbian's edge images
// only, and starts Armbian's share at half the drive. Start reads the SPL
// from the pretend board's eMMC over MaskROM, finds the partition table
// leaves the firmware's slot free and writes Armbian's U-Boot FIT to eMMC
// sector 0x10000 (test/electron/fake-cm5io-worker.ts says what the slot
// holds), then goes on to the NVMe drive (which fails here: the WinPE
// release is made up). An older SPL stops the job with nothing written.
//
// Advanced mode: with Windows on the NVMe drive, Armbian can go onto the
// same drive or an SD card (the SD card stays the default there), and the
// SD card list shows a 4 GB card greyed out with the sizes instead of
// saying there is no card.
// Screenshots go to shots/ (CI uploads them with the others).
//   node scripts/electron-cm5io-onedisk-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await build({ entryPoints: ['test/electron/fake-cm5io-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome130', outfile: 'build/renderer/fake-cm5io-worker.js', logLevel: 'warning' });
const tmp = mkdtempSync(join(tmpdir(), 'cm5io-onedisk-'));
// A small Armbian-like disk image (test/armbian-fixture.ts) in place of the download.
await build({ entryPoints: ['test/armbian-fixture.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(tmp, 'fixture.mjs'), logLevel: 'warning' });
const { fakeArmbian } = await import(join(tmp, 'fixture.mjs'));
const armbianImg = join(tmp, 'armbian.img');
writeFileSync(armbianImg, fakeArmbian());
const shots = 'shots';
mkdirSync(shots, { recursive: true });
const iso = join(tmp, 'Win11_23H2_ARM64.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));
const drive = (device, description, size, kind) => ({ device, description, size, mountpoints: [], kind, internal: null, warning: null, disabled: null });
const drives = [drive('/dev/sdx', 'USB NVMe enclosure', 256e9, 'usb'), drive('/dev/sdy', 'USB stick', 3965190144, 'usb'),
  drive('/dev/sdz', 'SD card reader', 3965190144, 'sd'), drive('/dev/sdw', 'SD card reader 2', 32e9, 'sd')];
const base = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_PICK: iso, WOA_IMAGER_FAKE_DRIVES: JSON.stringify(drives), WOA_IMAGER_TEST_ARMBIAN: armbianImg };
delete base.ELECTRON_RUN_AS_NODE;
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); else console.log(`ok: ${what}`); };

const next = (page) => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const desc = (page, id) => page.evaluate((i) => document.getElementById(i)?.closest('.pf-v6-c-radio')?.textContent ?? null, id);
const button = (page, re) => page.evaluate((r) => { [...document.querySelectorAll('button')].find((b) => new RegExp(r).test(b.textContent))?.click(); }, re);

/** Simple mode up to the "what" step with "Windows + Armbian" chosen and the Windows file picked. */
async function simpleBoth(page, lang) {
  await page.evaluate((l) => { localStorage.setItem('lang', l); }, lang);
  await page.reload();
  await page.waitForSelector('#s-board-cm5io');
  await page.click('#s-board-cm5io');
  await next(page);
  await page.waitForSelector('#s-task-both');
  const menu = await page.evaluate(() => [...document.querySelectorAll('input[name="s-task"]')].map((x) => x.id));
  await page.click('label[for="s-task-both"]');
  await button(page, 'Choose the Windows file|选择 Windows 文件');
  await page.waitForSelector('.pf-m-success');
  await page.waitForSelector('#disk-\\/dev\\/sdx');
  return menu;
}

/** Run from the confirm step; the run's result, stages and log. */
async function run(page, shot) {
  await page.waitForFunction(() => /Try again|重试/.test(document.body.textContent) && !!document.querySelector('.pf-v6-c-alert__title'), null, { timeout: 120000 });
  await page.evaluate(() => { document.querySelector('.log button')?.click(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${shot}-run.png`), fullPage: true });
  return page.evaluate(() => ({
    titles: [...document.querySelectorAll('.pf-v6-c-alert__title')].map((x) => x.textContent),
    progress: [...document.querySelectorAll('.pf-v6-c-progress')].map((p) => p.textContent),
    log: document.querySelector('.log pre')?.textContent ?? '',
  }));
}

try {
  // Simple mode, the 0.5.0 SPL: the slot is written, then the NVMe drive.
  let app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_UI_MODE: 'simple', WOA_IMAGER_TEST_WORKER: 'fake-cm5io-worker.js?spl=once' } });
  let page = await app.firstWindow();
  const menu = await simpleBoth(page, 'en');
  expect(menu.indexOf('s-task-both') === menu.indexOf('s-task-windows') + 1, `"Windows + Armbian" sits next to "Install Windows" (${menu.join(', ')})`);
  expect(/^Windows \+ Armbian \(experimental\)/.test(await text(page, 'label[for="s-task-both"]')), 'it is labelled experimental');
  expect(/one NVMe drive for the ArmSoM CM5-IO/.test(await desc(page, 's-task-both')), 'it says both go onto one NVMe drive');
  expect(/not yet been run from start to finish on a board/.test(await text(page, '#hybrid-experimental')), 'the experimental note is there');
  expect(/sectors 65536 to 98303/.test(await text(page, '#hybrid-firmware')) && /0\.5\.0 or later/.test(await text(page, '#hybrid-firmware')), 'it says what is written to the board and what firmware it needs');
  const stick = await page.evaluate(() => ({ disabled: document.getElementById('disk-/dev/sdy')?.disabled ?? null }));
  expect(stick.disabled === true && /This drive is 3\.7 GiB; Windows needs at least 27\.9 GiB/.test(await desc(page, 'disk-/dev/sdy')), 'a 4 GB stick is listed greyed out, with the sizes');
  await page.click('label[for="disk-/dev/sdx"]');
  await page.waitForSelector('#hybrid-Trixie_edge_minimal');
  const offers = await page.evaluate(() => [...document.querySelectorAll('input[name="hybrid-image"]')].map((x) => x.id));
  expect(offers.length > 0 && offers.every((x) => /_edge_/.test(x)), `only edge images (${offers.join(', ')})`);
  expect(/Only edge images here/.test(await text(page, '#hybrid-edge-only')), 'and it says why');
  await page.click('label[for="hybrid-Trixie_edge_minimal"]');
  await page.waitForSelector('#hybrid-slider');
  const share = await page.evaluate(() => document.getElementById('hybrid-size')?.value);
  expect(share === '119', `Armbian starts at half the 256 GB drive (${share} GB)`);
  await page.screenshot({ path: join(shots, 'cm5io-onedisk-simple-what.png'), fullPage: true });
  await next(page);
  await page.waitForSelector('#s-ready-nvme');
  expect(/Keep the NVMe drive connected/.test(await text(page, '#s-ready-nvme')), 'the ready step says to keep the drive connected');
  await next(page);
  await page.waitForSelector('#s-understand');
  const rows = await page.evaluate(() => [...document.querySelectorAll('.pf-v6-c-description-list__group')].map((g) => g.textContent));
  expect(rows.some((r) => /Windows \+ Armbian/.test(r)) && rows.some((r) => /Armbian: 119\.0 GB/.test(r)), 'the confirm step names the choice and the split');
  expect(rows.some((r) => /Everything on the NVMe drive USB NVMe enclosure/.test(r) && /only Armbian's U-Boot is written/.test(r)), 'and what is erased where');
  await page.screenshot({ path: join(shots, 'cm5io-onedisk-simple-confirm.png'), fullPage: true });
  await page.click('label[for="s-understand"]');
  await next(page);
  const a = await run(page, 'cm5io-onedisk-simple');
  console.log(JSON.stringify({ titles: a.titles, progress: a.progress }, null, 2));
  expect(a.progress.some((x) => /Armbian's U-Boot is in the slot/.test(x)), 'the check passes and the slot is written');
  expect(/rkdeveloptool rl 0 34/.test(a.log) && /wl 65536 /.test(a.log), 'the partition table is read and the FIT written at sector 65536');
  expect(/fake board: the eMMC slot holds a U-Boot FIT/.test(a.log), 'the board\'s eMMC slot holds the FIT');
  expect(!a.titles.some((x) => /slot|cannot start Armbian/.test(x)), `the job went on to the NVMe drive (${a.titles.join(' | ')})`);
  await app.close();

  // An older SPL: refused before anything is written; the menu in Chinese.
  app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_UI_MODE: 'simple', WOA_IMAGER_TEST_WORKER: 'fake-cm5io-worker.js' } });
  page = await app.firstWindow();
  await simpleBoth(page, 'zh-CN');
  expect(/Windows \+ Armbian（实验性）/.test(await text(page, 'label[for="s-task-both"]')), 'the choice in Chinese');
  await page.click('label[for="disk-/dev/sdx"]');
  await page.waitForSelector('#hybrid-Trixie_edge_minimal');
  await page.click('label[for="hybrid-Trixie_edge_minimal"]');
  await next(page);
  await page.waitForSelector('#s-ready-nvme');
  await next(page);
  await page.waitForSelector('#s-understand');
  await page.click('label[for="s-understand"]');
  await next(page);
  const b = await run(page, 'cm5io-onedisk-old-spl');
  expect(b.titles.some((x) => /不能从 NVMe 硬盘启动 Armbian/.test(x)), `an older SPL stops the job, in Chinese (${b.titles.join(' | ')})`);
  expect(/fake board: the eMMC slot is empty/.test(b.log) && !/wl 65536/.test(b.log), 'and nothing was written to the slot');
  await app.close();

  // Advanced mode: the SD card stays the default with Windows on the NVMe drive, the one disk is a choice,
  // and a 4 GB card is listed greyed out with the sizes.
  app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_TEST_WORKER: 'fake-cm5io-worker.js?spl=once' } });
  page = await app.firstWindow();
  await page.evaluate(() => { localStorage.setItem('lang', 'en'); });
  await page.reload();
  await page.waitForSelector('h2');
  await page.click('label[for="board-cm5io"]');
  await next(page);
  await page.click('label[for="task-windows"]');
  await page.click('label[for="dest-nvme"]');
  await next(page);
  await page.waitForSelector('.drop');
  await button(page, 'Choose a file|选择文件');
  await page.waitForSelector('text=Windows 11 Pro');
  await next(page);
  await page.waitForSelector('#hybrid-on');
  await page.click('label[for="first-oobe"]');
  await page.click('label[for="hybrid-on"]');
  await page.waitForSelector('#hybrid-where-sd');
  expect(await page.evaluate(() => document.getElementById('hybrid-where-sd')?.checked) === true, 'Advanced mode keeps the SD card as the default');
  expect(/Also write Armbian to an SD card/.test(await text(page, 'label[for="hybrid-on"]')), 'and its wording');
  await page.click('label[for="hybrid-where-disk"]');
  await page.waitForSelector('#hybrid-Trixie_edge_minimal');
  expect(/Also install Armbian on the NVMe drive/.test(await text(page, 'label[for="hybrid-on"]')), 'the one disk is a choice');
  expect(!(await page.$('#hybrid-Trixie_vendor_minimal')), 'with edge images only');
  await page.click('label[for="hybrid-where-sd"]');
  await page.waitForSelector('#hybrid-Trixie_vendor_minimal');
  await page.click('label[for="hybrid-Trixie_vendor_minimal"]');
  await page.waitForSelector('#hybrid-sd-size');
  await next(page);
  for (let i = 0; i < 4 && !(await page.$('#review-erase')); i++) { await next(page); await page.waitForTimeout(300); }
  await page.waitForSelector('#sd-\\/dev\\/sdz');
  const card = await page.evaluate(() => document.getElementById('sd-/dev/sdz')?.disabled ?? null);
  const cardText = await desc(page, 'sd-/dev/sdz');
  expect(card === true && /This card is 3\.\d+ GiB; this Armbian image needs at least \d+\.\d+ GiB/.test(cardText), `a 4 GB card is listed greyed out with the sizes (${cardText})`);
  expect(!/No USB drive or SD card/.test(await page.evaluate(() => document.body.textContent)), 'and the page does not say there is no card');
  expect(await page.evaluate(() => document.getElementById('sd-/dev/sdw')?.disabled) === false, 'the 32 GB card can be chosen');
  await page.screenshot({ path: join(shots, 'cm5io-onedisk-small-card.png'), fullPage: true });
  await app.close();
} finally {
  rmSync('build/renderer/fake-cm5io-worker.js', { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) { console.error(`FAIL:\n${failures.join('\n')}`); process.exit(1); }
console.log('PASS: Windows + Armbian on the CM5-IO\'s NVMe drive writes Armbian\'s U-Boot to the eMMC slot first, and small drives stay listed');
