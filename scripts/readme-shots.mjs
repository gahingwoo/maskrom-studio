// Screenshots for the README: the four steps of writing an SD card, with the
// real Roxora releases from GitHub (not the sample catalog, which puts a
// "Sample data" notice on every step) and the stubbed drive list, so no real
// disk appears. Needs network access; CI runs it after scripts/shots.mjs.
//   node scripts/readme-shots.mjs OUT_DIR
import { _electron as electron } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dev/readme-shots';
mkdirSync(out, { recursive: true });
const env = { ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_SAMPLE: '0', ROXORA_IMAGER_FAKE_DRIVES: '1', ROXORA_IMAGER_FAKE_UPDATE: 'current' };
delete env.ELECTRON_RUN_AS_NODE;

for (const theme of ['light', 'dark']) {
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
  await page.evaluate((t) => { localStorage.setItem('theme', t); }, theme);
  await page.reload();
  await page.waitForSelector('h2:has-text("Board")');
  // The real releases: wait until a board from them is listed.
  await page.waitForSelector('text=Radxa ROCK 4D', { timeout: 60000 });
  await page.waitForTimeout(800);
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(`${out}/${name}-${theme}.png`, Buffer.from(b64, 'base64'));
  };
  await shot('1-board');
  await page.fill('.board-search input', 'rock 4d');
  await page.press('.board-search input', 'Enter');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
  await page.waitForSelector('h2:has-text("Image")');
  await shot('2-image');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
  await page.waitForSelector('text=SanDisk');
  await shot('3-destination');
  await page.click('text=SanDisk');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
  await page.waitForTimeout(500);
  await shot('4-review');
  await app.close();
}
console.log(`README screenshots in ${out}`);
