// The staged Windows install inside the real Electron app, against a pretend
// TaishanPi 3M: app:// pages with COOP/COEP and CSP, the WoA worker as a
// module, the WASM rkdeveloptool and its libusb WebUSB backend, the WinPE
// image and a Windows ISO read with synchronous Range requests of
// app://local/file/<token>, install.wim read through its UDF extents. Only
// navigator.usb is replaced (test/fake-rockchip.ts).
//   node scripts/electron-woa-e2e.mjs      (needs mkfs.vfat, mtools, sgdisk, xz)
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await build({ entryPoints: ['test/electron/fake-woa-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome130', outfile: 'build/renderer/fake-woa-worker.js', logLevel: 'warning' });
const dir = mkdtempSync(join(tmpdir(), 'woa-e2e-'));
// A small stand-in for woa-rk3576's winpe.img (the layout test builds the same).
const env0 = { ...process.env, MTOOLS_SKIP_CHECK: '1' };
const fat = join(dir, 'fat.img');
execFileSync('truncate', ['-s', '64M', fat]);
execFileSync('mkfs.vfat', ['-F', '32', '-n', 'WINPE', fat]);
for (const d of ['EFI', 'EFI/Boot', 'sources', 'woa-drivers', 'woa-drivers/dwcsdhc', 'woa-debug']) execFileSync('mmd', ['-i', fat, `::/${d}`], { env: env0 });
const put = (p, data) => { const f = join(dir, 'f'); writeFileSync(f, data); execFileSync('mcopy', ['-i', fat, f, `::/${p}`], { env: env0 }); };
put('EFI/Boot/bootaa64.efi', Buffer.alloc(100000, 1));
put('sources/boot.wim', Buffer.alloc(2 << 20, 2));
put('woa-drivers/dwcsdhc/dwcsdhc.inf', '[Version]\r\n');
put('woa-debug/collect.cmd', Buffer.alloc(14566, 'r'));
const winpe = join(dir, 'winpe.img');
execFileSync('truncate', ['-s', String(66 << 20), winpe]);
execFileSync('sgdisk', ['-o', '-n', `1:2048:${2048 + (64 << 11) - 1}`, '-t', '1:0700', '-c', '1:WINPE', winpe]);
const fd = openSync(winpe, 'r+');
writeSync(fd, readFileSync(fat), 0, 64 << 20, 1 << 20);
closeSync(fd);
const iso = join(dir, 'w.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));
const head = Array.from(readFileSync('test/fixtures/tspi3m-emmc-head.bin'));

const env = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_TEST_SERVE: winpe, WOA_IMAGER_TEST_SERVE_XZ: iso, WOA_IMAGER_TEST_PICK: iso };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], env });
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const win = await page.evaluate(() => window.imager.pickWindows());
  const res = await page.evaluate(async ({ head, win, winpeSize }) => {
    const loader = await window.imager.getLoader('rk3576_spl_loader.bin');
    if ('error' in loader) return { loaderError: loader.error };
    const w = new Worker('fake-woa-worker.js', { type: 'module' });
    w.postMessage({ type: 'seed', head });
    const stages = [];
    let planned = null;
    const o = location.origin;
    const result = await new Promise((resolve) => {
      w.onerror = (e) => resolve({ workerError: String(e.message ?? e.type) });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'stage') stages.push(m.stage);
        if (m.type === 'planned') { planned = m.summary; w.postMessage({ type: 'woa-confirm', ok: true }); }
        if (m.type === 'result') resolve(m.result);
      };
      w.postMessage({ type: 'woa-start', moduleUrl: `${o}/wasm/rkdeveloptool.js`, wasmUrl: `${o}/wasm/rkdeveloptool.wasm`, loaderUrl: loader.url,
        reconnectTimeout: 8000,
        job: { kind: 'stage', boardId: 'tspi3m', appVersion: 'e2e', spotCheck: true, resetAfter: true,
          winpe: { url: `${o}/file/test`, size: winpeSize },
          image: { url: `${o}/file/xz`, size: win.fileSize, extents: win.extents, name: win.imageName, imageSize: win.imageSize,
            sha256: null, index: 1, edition: 'Windows 11 Pro', build: 22631 } } });
    });
    const dump = await new Promise((resolve) => {
      w.onmessage = (e) => { if (e.data.type === 'dump') resolve(e.data); };
      w.postMessage({ type: 'dump' });
    });
    return { crossOriginIsolated: self.crossOriginIsolated, result, stages, planned, dump };
  }, { head, win, winpeSize: 66 << 20 });
  const show = { ...res, dump: res.dump && { ...res.dump, bootSector: undefined, dataSector: undefined } };
  console.log(JSON.stringify(show, null, 2));
  const names = res.dump?.parts?.map((p) => p.name).join(',');
  const oem = (s) => String.fromCharCode(...s.slice(3, 11));
  ok = res.result?.ok === true && names === 'firmware,WOA-STAGE-BOOT,WOA-STAGE-DATA'
    && res.dump.parts[0].first === 64 && res.dump.parts[0].last === 131071
    && oem(res.dump.dataSector) === 'EXFAT   ' && res.dump.bootSector[510] === 0x55
    && res.dump.backupSig === 'EFI PART' && res.dump.resets === 1 && res.planned?.removed?.[0]?.name === 'data';
} finally {
  await app.close();
  rmSync('build/renderer/fake-woa-worker.js', { force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? 'PASS: staged install written to the pretend eMMC through the Electron worker' : 'FAIL');
process.exit(ok ? 0 : 1);
