// The ROCK 4D's "UEFI firmware, keep the settings" inside the real Electron
// app, against a pretend ROCK 4D (test/electron/fake-rock4d-worker.ts): the
// WoA worker selects the SPI NOR (cs 9) although the loader starts on a UFS
// module, copies the whole flash first, writes sectors 0..32255 of the new
// image, reads it back, and leaves the saved UEFI settings and the UFS alone.
// Then the read-only check for the Armbian one-shot: the SPL of the
// rock4d-parity build passes, a release's SPL is refused, nothing is written.
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
  // The firmware check before Armbian goes next to Windows (armbian-once.ts): read only, on the SPI NOR flash.
  const check = await page.evaluate(async () => {
    const loader = await window.imager.getLoader('rk3576_spl_loader.bin');
    const o = location.origin;
    const run = (spl) => new Promise((resolve) => {
      const w = new Worker(`fake-rock4d-worker.js${spl ? `?spl=${spl}` : ''}`, { type: 'module' });
      const log = [];
      const asked = [];
      w.onerror = (e) => resolve({ workerError: String(e.message ?? e.type) });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'log') log.push(m.line);
        if (m.type === 'planned' || m.type === 'pre-backup' || m.type === 'backup') asked.push(m.type);
        if (m.type === 'result') {
          w.onmessage = (d) => { if (d.data.type === 'dump') resolve({ result: m.result, asked, dump: d.data, cs: log.filter((l) => /cs 9|ArmbianOnce/.test(l)) }); };
          w.postMessage({ type: 'dump' });
        }
      };
      w.postMessage({ type: 'woa-start', moduleUrl: `${o}/wasm/rkdeveloptool.js`, wasmUrl: `${o}/wasm/rkdeveloptool.wasm`, loaderUrl: loader.url,
        reconnectTimeout: 8000, job: { kind: 'armbian-once-check', boardId: 'rock4d', resetAfter: true } });
    });
    return { once: await run('once'), old: await run(null) };
  });
  console.log(JSON.stringify(check, null, 2));
  const checkOk = check.once.result?.ok === true && check.once.result.written === 0 && check.once.asked.length === 0
    && check.once.dump.spiUntouched && check.once.dump.ufsUntouched && check.once.dump.resets === 1
    && check.once.cs.some((l) => /cs 9/.test(l)) && check.once.cs.some((l) => /^ArmbianOnce\/1 found in the SPL at SPI NOR byte 0x/.test(l))
    && check.old.result?.ok === false && /cannot start Armbian from the SD card/.test(check.old.result.reason) && /Nothing was written\.$/.test(check.old.result.reason)
    && check.old.result.written === 0 && check.old.dump.spiUntouched && check.old.asked.length === 0;
  if (!checkOk) console.log('FAIL: the Armbian one-shot check');
  ok = checkOk && res.result?.ok === true && res.result.written === 32256 * 512 && res.result.checks?.headBytes === 32256 * 512
    && res.dump?.firmwareIsNew && res.dump.settingsKept && res.dump.ufsUntouched && res.dump.resets === 1
    && res.planned?.spi?.settings === 'kept' && res.planned.spi.next === '0.4.2'
    && res.backup?.files?.join(',') === 'spi-nor-before.bin:16777216,nvdata-spi-sector-32256-384.bin:196608'
    && res.cs.includes('Selected storage: 16777216 bytes.');
} finally {
  await app.close();
  rmSync('build/renderer/fake-rock4d-worker.js', { force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? 'PASS: ROCK 4D firmware written to the pretend SPI NOR, settings kept, and its Armbian one-shot checked read-only, through the Electron worker' : 'FAIL');
process.exit(ok ? 0 : 1);
