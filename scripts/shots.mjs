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

async function session(tag, w, h, theme, env, steps, lang = 'en') {
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`${tag}-${theme}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}-${theme} console: ${m.text()}`); });
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
  await page.evaluate(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, lang]);
  await page.reload();
  await page.waitForSelector('h2');
  await page.waitForTimeout(800);
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(`${out}/${name}-${tag}-${theme}${lang === 'en' ? '' : `-${lang}`}.png`, Buffer.from(b64, 'base64'));
  };
  await steps(page, shot);
  await app.close();
}

const next = (page) => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');

const flow = async (page, shot) => {
  await shot('1-board');
  await page.click('label[for="board-tspi3m"]');
  await next(page);
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await shot('2-task');
  await next(page);
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file|选择文件/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await shot('3-windows');
  // The places to get Windows 11 23H2 ARM64, opened.
  await page.click('.pf-v6-c-expandable-section__toggle button');
  await shot('3-windows-get');
  await page.click('.pf-v6-c-expandable-section__toggle button');
  await next(page);
  await page.waitForSelector('#first-skip');
  await page.click('label[for="first-skip"]');
  await page.fill('#acc-user', 'woa');
  await page.fill('#acc-password', 'example');
  await page.fill('#acc-password2', 'example');
  await shot('4-setup');
  await next(page);
  await page.waitForSelector('.pf-v6-c-description-list');
  await shot('5-review');
};

// A small RK3576 update.img (RKFW header, loader, RKAF with parameter.txt and two partitions).
const factory = join(tmp, 'update.img');
{
  const enc = (t) => new TextEncoder().encode(t);
  const param = enc('FIRMWARE_VER: 14.0\nMACHINE_MODEL: TaishanPi3M\nCMDLINE: mtdparts=:0x2000@0x4000(uboot),0x20000@0x6800(boot),-@0x26800(userdata:grow)\n');
  const parts = [['parameter', 'parameter.txt', param], ['uboot', 'Image/uboot.img', new Uint8Array(4 << 20)], ['boot', 'Image/boot.img', new Uint8Array(40 << 20)]];
  let pos = 2048;
  const placed = parts.map(([n, f, d]) => { const at = pos; pos += Math.ceil(d.length / 2048) * 2048; return { n, f, d, at }; });
  const rkaf = new Uint8Array(pos);
  const dv = new DataView(rkaf.buffer);
  rkaf.set(enc('RKAF'), 0); rkaf.set(enc('TaishanPi3M'), 8); rkaf.set(enc('LCKFB'), 72);
  dv.setUint32(136, placed.length, true);
  placed.forEach((p, i) => { const o = 140 + i * 112; rkaf.set(enc(p.n), o); rkaf.set(enc(p.f), o + 32); dv.setUint32(o + 96, p.at, true); dv.setUint32(o + 108, p.d.length, true); rkaf.set(p.d, p.at); });
  const loader = new Uint8Array(4096); loader.set(enc('LDR '), 0); new DataView(loader.buffer).setUint32(0x15, 0x33353736, true);
  const head = new Uint8Array(0x66); const hv = new DataView(head.buffer);
  head.set(enc('RKFW'), 0); hv.setUint32(6, 0x0e000000, true); hv.setUint16(0x0e, 2026, true); head[0x10] = 11; head[0x11] = 2;
  hv.setUint32(0x15, 0x33353736, true); hv.setUint32(0x19, 0x66, true); hv.setUint32(0x1d, 4096, true); hv.setUint32(0x21, 0x66 + 4096, true); hv.setUint32(0x25, rkaf.length, true);
  const out = new Uint8Array(0x66 + 4096 + rkaf.length);
  out.set(head, 0); out.set(loader, 0x66); out.set(rkaf, 0x66 + 4096);
  writeFileSync(factory, out);
}

// Putting the board back: Armbian (made-up answer), then a factory update.img.
const restoreFlow = async (page, shot) => {
  await page.click('label[for="board-tspi3m"]');
  await next(page);
  await page.waitForSelector('#task-armbian');
  await page.click('label[for="task-armbian"]');
  await shot('7-restore-task');
  await next(page);
  await page.waitForSelector('text=26.11.0-trunk.137');
  await shot('8-restore-armbian');
  await next(page);
  await page.waitForSelector('.pf-v6-c-wizard__footer');
  await shot('9-restore-review');
  await page.click('.pf-v6-c-wizard__footer button.pf-m-secondary');
  await page.click('.pf-v6-c-wizard__footer button.pf-m-secondary');
  await page.waitForSelector('#task-factory');
  await page.click('label[for="task-factory"]');
  await next(page);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /update\.img/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=TaishanPi3M');
  await shot('8-restore-factory');
};

for (const [w, h, tag] of [[1100, 780, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    await session(tag, w, h, theme, { ...base, WOA_IMAGER_TEST_FACTORY: factory }, restoreFlow);
  }
}
await session('d', 1100, 780, 'light', { ...base, WOA_IMAGER_TEST_FACTORY: factory }, restoreFlow, 'zh-CN');

for (const [w, h, tag] of [[1100, 780, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    await session(tag, w, h, theme, base, flow);
    await session(`${tag}-here`, w, h, theme, { ...base, WOA_IMAGER_FAKE_ROOT: root }, async (page, shot) => {
      await page.waitForSelector('#via-here');
      await shot('6-this-board');
    });
  }
}
await session('d', 1100, 780, 'light', base, flow, 'zh-CN');
await session('d-here', 1100, 780, 'light', { ...base, WOA_IMAGER_FAKE_ROOT: root }, async (page, shot) => {
  await page.waitForSelector('#via-here');
  await shot('6-this-board');
}, 'zh-CN');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`screenshots in ${out}`);
