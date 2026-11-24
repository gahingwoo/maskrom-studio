// The README's animated walkthrough: Simple mode, from choosing the board to
// a finished firmware update, in the built app (hidden window) against the
// pretend TaishanPi 3M of test/electron/fake-board-worker.ts, so no USB
// device is involved. Releases are made up (WOA_IMAGER_FAKE_RELEASES), as
// for scripts/readme-shots.mjs. Frames are the window's own capturePage(),
// ffmpeg makes the GIF; the write itself is shown at twice its speed.
//   npm run build && node scripts/demo-gif.mjs [OUT_DIR]   (default dev/demo; FFMPEG= to choose,
//   LANGS=en for one language)
// Writes demo-en.gif and demo-zh-CN.gif, light theme.
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'dev/demo';
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const [W, H] = [1100, 780];
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'demo-gif-'));
await build({ entryPoints: ['test/electron/fake-board-worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'chrome130',
  outfile: 'build/renderer/fake-board-worker.js', loader: { '.bin': 'binary' }, logLevel: 'warning' });
// The "newest" firmware the fake releases offer: a made-up edk2-rk3576 0.4.2.
await build({ entryPoints: ['test/edk2-fixture.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(tmp, 'fixture.mjs'), logLevel: 'warning' });
const { edk2Image } = await import(join(tmp, 'fixture.mjs'));
const firmware = join(tmp, 'TaishanPi3M-emmc-edk2-0.4.2.img');
writeFileSync(firmware, edk2Image({ version: '0.4.2' }));

const env = {
  ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'simple', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_WORKER: 'fake-board-worker.js', WOA_IMAGER_TEST_FIRMWARE: firmware,
  WOA_IMAGER_SHOW_DATA_DIR: '/home/user/.config/Maskrom Studio', XDG_CONFIG_HOME: join(tmp, 'config'),
};
delete env.ELECTRON_RUN_AS_NODE;

// The hidden window draws no pointer; this one follows the mouse so a viewer
// can see what gets clicked.
const cursor = () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .08s';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 9-6.2 1.1L14 19l-2.6 1.2-3.1-6.9L3 17z" fill="#151515" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.left = `${e.clientX - 3}px`; c.style.top = `${e.clientY - 2}px`; }, true);
  addEventListener('mousedown', () => { c.style.transform = 'scale(.8)'; }, true);
  addEventListener('mouseup', () => { c.style.transform = ''; }, true);
};

async function record(lang) {
  const app = await electron.launch({ args: ['.'], env });
  const frames = [];
  let speed = 1;
  let virtual = 0;
  let last = 0;
  let recording = false;
  let loop = null;
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);
    await page.evaluate((l) => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', l); }, lang);
    await page.reload();
    await page.waitForSelector('h2');
    await page.evaluate(cursor);
    await page.waitForTimeout(600);

    const grab = async () => {
      while (recording) {
        const now = Date.now();
        const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
        virtual += (now - last) / speed;
        last = now;
        frames.push({ data, t: virtual / 1000 });
        await new Promise((r) => setTimeout(r, Math.max(0, 70 - (Date.now() - now))));
      }
    };
    last = Date.now();
    recording = true;
    loop = grab();

    let x = W / 2, y = H / 2;
    await page.mouse.move(x, y);
    const click = async (loc) => {
      await loc.scrollIntoViewIfNeeded();
      const b = await loc.boundingBox();
      if (!b) throw new Error('not on screen');
      const nx = b.x + Math.min(b.width / 2, 40), ny = b.y + b.height / 2;
      await page.mouse.move(nx, ny, { steps: 16 });
      x = nx; y = ny;
      await page.waitForTimeout(200);
      await page.mouse.click(x, y);
    };
    const next = () => click(page.locator('.pf-v6-c-wizard__footer button.pf-m-primary'));

    await page.waitForTimeout(1200);
    await click(page.locator('#s-board-tspi3m'));
    await page.waitForTimeout(700);
    await next();
    await page.waitForSelector('#s-task-upgrade');
    await page.waitForTimeout(700);
    await click(page.locator('label[for="s-task-upgrade"]'));
    await page.waitForFunction(() => !document.querySelector('.pf-v6-c-wizard__footer button.pf-m-primary')?.disabled, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await next();
    await page.waitForSelector('.pf-v6-c-card ol');
    await page.waitForTimeout(2200);
    await next();
    await page.waitForTimeout(1800);
    const understand = page.locator('#s-understand');
    if (await understand.count()) { await click(page.locator('label[for="s-understand"]')); await page.waitForTimeout(500); }
    await next();
    const go = page.locator('.pf-v6-c-card button.pf-m-primary', { hasText: lang === 'en' ? 'Upgrade' : '升级' });
    await go.waitFor({ timeout: 120000 });
    await page.waitForTimeout(1800);
    // The write: shown sped up, so the GIF stays short.
    const before = virtual;
    const started = Date.now();
    await click(go);
    speed = 2;
    await page.waitForSelector(`text=${lang === 'en' ? 'The firmware is upgraded' : '固件已升级'}`, { timeout: 180000 });
    speed = 1;
    console.log(`${lang}: the write took ${((Date.now() - started) / 1000).toFixed(1)} s, shown as ${((virtual - before) / 1000).toFixed(1)} s`);
    await page.mouse.move(W - 40, H - 40, { steps: 10 });
    await page.waitForTimeout(2500);
  } finally {
    recording = false;
    await loop?.catch(() => {});
    await app.close();
  }
  return frames;
}

function encode(frames, gif) {
  const dir = mkdtempSync(join(tmp, 'frames-'));
  let list = '';
  frames.forEach((f, i) => {
    const name = `f${String(i).padStart(5, '0')}.png`;
    writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'));
    const d = i + 1 < frames.length ? Math.max(frames[i + 1].t - f.t, 0.001) : 2;
    list += `file '${name}'\nduration ${d.toFixed(3)}\n`;
  });
  list += `file 'f${String(frames.length - 1).padStart(5, '0')}.png'\n`;
  writeFileSync(join(dir, 'list.txt'), list);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', 'fps=12,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', gif], { stdio: 'inherit' });
  rmSync(dir, { recursive: true, force: true });
}

let failed = false;
try {
  for (const lang of (process.env.LANGS ?? 'en,zh-CN').split(',')) {
    try {
      const frames = await record(lang);
      const gif = join(out, `demo-${lang}.gif`);
      encode(frames, gif);
      const kb = Math.round(statSync(gif).size / 1024);
      console.log(`${gif} ${kb} KiB, ${frames.length} frames`);
      if (kb > 3 * 1024) { console.error(`${gif} is over 3 MiB`); failed = true; }
    } catch (e) {
      console.error(`${lang}: ${e.message}`);
      failed = true;
    }
  }
} finally {
  rmSync('build/renderer/fake-board-worker.js', { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) process.exit(1);
