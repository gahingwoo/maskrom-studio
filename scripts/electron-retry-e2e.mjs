// A job whose board goes away, inside Electron: the firmware upgrade against
// a pretend TaishanPi 3M that takes the loader and never comes back
// (test/electron/fake-gone-worker.ts). Checks that the run page:
//   1. names it "The board was disconnected" and shows how to get the board
//      back into MaskROM mode, with the live MaskROM line;
//   2. offers Try again, Back to the steps, Report a problem, Save full log;
//   3. Try again runs the same job again (the same task, nothing chosen anew)
//      and ends on the same page, never stuck.
//   npm run build && node scripts/electron-retry-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'retry-e2e-'));
await build({ entryPoints: ['test/electron/fake-gone-worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'chrome130',
  outfile: 'build/renderer/fake-gone-worker.js', loader: { '.bin': 'binary' }, logLevel: 'warning' });
await build({ entryPoints: ['test/edk2-fixture.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(tmp, 'fixture.mjs'), logLevel: 'warning' });
const { edk2Image } = await import(join(tmp, 'fixture.mjs'));
const firmware = join(tmp, 'TaishanPi3M-emmc-edk2-0.4.2.img');
writeFileSync(firmware, edk2Image({ version: '0.4.2' }));

const env = {
  ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_FIRMWARE: firmware, WOA_IMAGER_TEST_WORKER: 'fake-gone-worker.js', XDG_CONFIG_HOME: join(tmp, 'config'),
};
delete env.ELECTRON_RUN_AS_NODE;
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failures++; };

const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.evaluate(() => localStorage.setItem('lang', 'en'));
  await page.reload();
  await page.waitForSelector('h2');
  const next = () => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  await page.click('label[for="board-tspi3m"]');
  await next();
  await page.click('label[for="task-upgrade"]');
  await next();
  await page.waitForSelector('text=rk3576-lckfb-tspi-3m');
  await next();
  await page.click('.pf-v6-c-wizard__footer button:has-text("Connect and write")');
  for (const round of [1, 2]) {
    await page.waitForSelector('text=The board was disconnected', { timeout: 90000 });
    const text = await page.evaluate(() => document.body.innerText);
    if (process.env.DEBUG_E2E) console.log(text);
    check(/Put it back into MaskROM mode/.test(text) && /pads marked MSK/.test(text), `round ${round}: says how to get the board back into MaskROM mode`);
    check(await page.locator('#maskrom-live').count() === 1, `round ${round}: the live MaskROM line is shown`);
    for (const b of ['Try again', 'Back to the steps', 'Report a problem', 'Save full log']) {
      check(await page.locator(`button:has-text("${b}")`).count() > 0, `round ${round}: "${b}" is offered`);
    }
    if (round === 1) {
      await page.click('button:has-text("Try again")');
      await page.waitForSelector('text=Upgrading the firmware', { timeout: 10000 }).catch(() => {});
      check(await page.locator('text=The board was disconnected').count() === 0, 'Try again starts the same job again at once');
    }
  }
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  failures++;
} finally {
  await app.close();
  rmSync('build/renderer/fake-gone-worker.js', { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
