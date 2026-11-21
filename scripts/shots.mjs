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

// A small Armbian-like image for the Armbian step (mkfs.ext4 -d and sgdisk, no root needed).
const armbianImage = (() => {
  const t = join(tmp, 'armbian-tree');
  const a = (p, v) => { mkdirSync(join(t, p, '..'), { recursive: true }); writeFileSync(join(t, p), v); };
  a('etc/armbian-release', 'BOARD=lckfb-taishanpi-3m\nBOARD_NAME="Taishan Pi 3M"\nARCH=arm64\nBOOT_SOC=rk3576\nVERSION=26.11.0-trunk\n');
  a('etc/fstab', 'UUID=0bb4374f-5bdf-42c2-b951-03fc3cb84ca8 / ext4 defaults 0 1\n');
  a('boot/vmlinuz-7.3.4-edge-rockchip64', 'k');
  a('boot/initrd.img-7.3.4-edge-rockchip64', 'i');
  const fs = join(tmp, 'rootfs.ext4');
  const img = join(tmp, 'Armbian_26.11.0_Lckfb-taishanpi-3m_trixie_edge_7.3.4_gnome_desktop.img');
  try {
    execFileSync('truncate', ['-s', '32M', fs]);
    execFileSync('mkfs.ext4', ['-q', '-F', '-U', '0bb4374f-5bdf-42c2-b951-03fc3cb84ca8', '-d', t, fs], { env: { ...process.env, PATH: `${process.env.PATH}:/usr/sbin:/sbin` } });
    execFileSync('truncate', ['-s', String(49 << 20), img]);
    execFileSync('sgdisk', ['-o', '-n', `1:32768:${32768 + (32 << 11) - 1}`, '-t', '1:8305', img]);
    execFileSync('dd', [`if=${fs}`, `of=${img}`, 'bs=1M', 'seek=16', 'conv=notrunc', 'status=none']);
    return img;
  } catch {
    return null;
  }
})();

const base = {
  ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current',
  WOA_IMAGER_TEST_PICK: iso, ...(armbianImage ? { WOA_IMAGER_TEST_ARMBIAN: armbianImage } : {}),
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

// Windows and Armbian on the eMMC: the task page with the option, the Armbian page, the review.
const armbianFlow = async (page, shot) => {
  await page.click('label[for="board-tspi3m"]');
  await next(page);
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await page.waitForSelector('#with-armbian:not([disabled])');
  await page.click('label[for="with-armbian"]');
  await shot('7-task-armbian');
  await next(page);
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file|选择文件/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await next(page);
  await page.waitForSelector('#first-skip');
  await page.click('label[for="first-skip"]');
  await page.fill('#acc-user', 'Woo');
  await page.fill('#acc-password', 'example');
  await page.fill('#acc-password2', 'example');
  await next(page);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Choose the Armbian image|选择 Armbian 映像/.test(b.textContent)));
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose the Armbian image|选择 Armbian 映像/.test(b.textContent))?.click(); });
  await page.waitForSelector('#armbian-size');
  await shot('8-armbian');
  await next(page);
  await page.waitForSelector('.pf-v6-c-description-list');
  await shot('9-review-armbian');
};

for (const [w, h, tag] of [[1100, 780, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    await session(tag, w, h, theme, base, flow);
    await session(`${tag}-here`, w, h, theme, { ...base, WOA_IMAGER_FAKE_ROOT: root }, async (page, shot) => {
      await page.waitForSelector('#via-here');
      await shot('6-this-board');
    });
  }
}
if (armbianImage) {
  for (const theme of ['light', 'dark']) await session('d', 1100, 780, theme, base, armbianFlow);
  await session('m', 720, 640, 'light', base, armbianFlow);
  await session('d', 1100, 780, 'light', base, armbianFlow, 'zh-CN');
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
