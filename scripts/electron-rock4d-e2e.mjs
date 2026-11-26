// The ROCK 4D's "UEFI firmware, keep the settings" inside the real Electron
// app, against a pretend ROCK 4D (test/electron/fake-rock4d-worker.ts): the
// WoA worker selects the SPI NOR (cs 9) although the loader starts on a UFS
// module, copies the whole flash first, writes sectors 0..32255 of the new
// image, reads it back, and leaves the saved UEFI settings and the UFS alone.
//   node scripts/electron-rock4d-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

await build({ entryPoints: ['test/electron/fake-rock4d-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome130', outfile: 'build/renderer/fake-rock4d-worker.js', logLevel: 'warning' });
const dir = mkdtempSync(join(tmpdir(), 'rock4d-e2e-'));
await build({ entryPoints: ['test/edk2-fixture.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'fixture.mjs'), logLevel: 'warning' });
const { spiImage } = await import(pathToFileURL(join(dir, 'fixture.mjs')).href);
const image = join(dir, 'ROCK4D-spi-edk2-0.4.2.img');
writeFileSync(image, spiImage({ version: '0.4.2' }));

const env = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_TEST_SERVE: image };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], env });
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const res = await page.evaluate(async () => {
    const loader = await window.imager.getLoader('rk3576_spl_loader.bin');
    if ('error' in loader) return { loaderError: loader.error };
    const w = new Worker('fake-rock4d-worker.js', { type: 'module' });
    const stages = [];
    const log = [];
    let planned = null;
    let backup = null;
    const o = location.origin;
    const result = await new Promise((resolve) => {
      w.onerror = (e) => resolve({ workerError: String(e.message ?? e.type) });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'stage') stages.push(m.stage);
        if (m.type === 'log') log.push(m.line);
        if (m.type === 'pre-backup') { backup = { files: m.files.map((f) => `${f.name}:${f.data.length}`), notes: m.notes }; w.postMessage({ type: 'woa-backup-saved', path: 'e2e' }); }
        if (m.type === 'planned') { planned = m.summary; w.postMessage({ type: 'woa-confirm', ok: true }); }
        if (m.type === 'result') resolve(m.result);
      };
      w.postMessage({ type: 'woa-start', moduleUrl: `${o}/wasm/rkdeveloptool.js`, wasmUrl: `${o}/wasm/rkdeveloptool.wasm`, loaderUrl: loader.url,
        reconnectTimeout: 8000,
        job: { kind: 'firmware', boardId: 'rock4d', targetId: 'uefi-keep', image: { url: `${o}/file/test`, size: 16 * 1024 * 1024 }, spotCheck: true, resetAfter: true } });
    });
    const dump = await new Promise((resolve) => {
      w.onmessage = (e) => { if (e.data.type === 'dump') resolve(e.data); };
      w.postMessage({ type: 'dump' });
    });
    return { result, stages, planned, backup, dump, cs: log.filter((l) => /cs 9|Selected storage/.test(l)) };
  });
  console.log(JSON.stringify(res, null, 2));
  ok = res.result?.ok === true && res.result.written === 32256 * 512 && res.result.checks?.headBytes === 32256 * 512
    && res.dump?.firmwareIsNew && res.dump.settingsKept && res.dump.ufsUntouched && res.dump.resets === 1
    && res.planned?.spi?.settings === 'kept' && res.planned.spi.next === '0.4.2'
    && res.backup?.files?.join(',') === 'spi-nor-before.bin:16777216,nvdata-spi-sector-32256-384.bin:196608'
    && res.cs.includes('Selected storage: 16777216 bytes.');
} finally {
  await app.close();
  rmSync('build/renderer/fake-rock4d-worker.js', { force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? 'PASS: ROCK 4D firmware written to the pretend SPI NOR, settings kept, through the Electron worker' : 'FAIL');
process.exit(ok ? 0 : 1);
