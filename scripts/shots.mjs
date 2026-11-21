// Screenshots of the app's steps, light and dark, at the default window size
// and at the minimum width. Runs the built app hidden, with made-up releases
// (no network), the Windows image of test/fixtures and, for the "this board"
// pictures, a pretend TaishanPi 3M (a folder laid out like /proc and /sys).
//   node scripts/shots.mjs OUT_DIR
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'dev/shots';
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'woa-shots-'));
const iso = join(tmp, 'Win11_23H2_ARM64.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));
const root = join(tmp, 'root');
const put = (p, v) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), v); };
put('proc/device-tree/compatible', 'lckfb,tspi-3m-rk3576\0rockchip,rk3576\0');
put('sys/block/mmcblk1/device/type', 'MMC\n');
put('sys/block/mmcblk1/device/name', 'A3A561\n');
put('sys/block/mmcblk1/size', '121110528\n');

const base = {
  ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_PICK: iso,
};
delete base.ELECTRON_RUN_AS_NODE;
const errors = [];

async function session(tag, w, h, theme, env, steps) {
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`${tag}-${theme}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}-${theme} console: ${m.text()}`); });
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
  await page.evaluate((t) => { localStorage.setItem('theme', t); }, theme);
  await page.reload();
  await page.waitForSelector('h2:has-text("Board")');
  await page.waitForTimeout(800);
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(`${out}/${name}-${tag}-${theme}.png`, Buffer.from(b64, 'base64'));
  };
  await steps(page, shot);
  await app.close();
}

const next = (page) => page.click('.pf-v6-c-wizard__footer button:has-text("Next")');

for (const [w, h, tag] of [[1100, 780, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    await session(tag, w, h, theme, base, async (page, shot) => {
      await shot('1-board');
      await page.click('label[for="board-tspi3m"]');
      await next(page);
      await page.waitForSelector('h2:has-text("What to write")');
      await page.click('label[for="task-windows"]');
      await shot('2-task');
      await next(page);
      await page.waitForSelector('h2:has-text("Windows image")');
      await page.click('button:has-text("Choose a file")');
      await page.waitForSelector('text=Windows 11 Pro');
      await shot('3-windows');
      await next(page);
      await page.waitForSelector('h2:has-text("Review")');
      await shot('4-review');
    });
    await session(`${tag}-here`, w, h, theme, { ...base, WOA_IMAGER_FAKE_ROOT: root }, async (page, shot) => {
      await page.waitForSelector('text=This computer is the board');
      await shot('5-this-board');
    });
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`screenshots in ${out}`);
