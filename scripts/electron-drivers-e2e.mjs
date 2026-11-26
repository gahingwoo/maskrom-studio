// The RK3576 driver package in the real app: the Windows setup step says the
// board's drivers are installed automatically (and which ones), the package
// is downloaded from a local server, checked against its SHA-256, and the
// board's list comes out of it; a release without a package says what is
// installed instead. Runs hidden, with made-up releases and the Windows image
// of test/fixtures; the package is test/fixtures' manifest with stand-in
// driver files.
//   node scripts/electron-drivers-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'woa-drivers-'));
const iso = join(tmp, 'Win11_23H2_ARM64.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));

// The package: rk3576-drivers/ with the manifest, two files per driver and SHA256SUMS.txt, stored (no compression).
const manifest = readFileSync('test/fixtures/rk3576-drivers-manifest.json');
const files = [['rk3576-drivers/manifest.json', manifest]];
for (const d of JSON.parse(manifest).drivers) {
  files.push([`rk3576-drivers/drivers/${d.dir}/${d.dir}.inf`, Buffer.from(`[Version]\r\n; ${d.dir}\r\n`)]);
  files.push([`rk3576-drivers/drivers/${d.dir}/${d.dir}.sys`, Buffer.from(`MZ ${d.dir}`)]);
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
files.push(['rk3576-drivers/SHA256SUMS.txt', Buffer.from(files.map(([p, b]) => `${sha(b)}  ${p.slice('rk3576-drivers/'.length)}`).join('\n') + '\n')]);
function storedZip(entries) {
  const locals = [];
  const central = [];
  let at = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
    locals.push(h, n, data);
    central.push(c, n);
    at += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, cd, end]);
}
const zip = storedZip(files);
let downloads = 0;
const server = createServer((req, res) => {
  if (req.url !== '/rk3576-drivers-arm64.zip') { res.writeHead(404).end(); return; }
  downloads++;
  res.writeHead(200, { 'content-length': zip.length, 'content-type': 'application/zip' }).end(zip);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/rk3576-drivers-arm64.zip`;

const base = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current', WOA_IMAGER_TEST_PICK: iso };
delete base.ELECTRON_RUN_AS_NODE;
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); else console.log(`ok: ${what}`); };

/** The setup step's driver paragraph for `board` in `lang`. */
async function setupText(page, board, lang) {
  await page.evaluate((l) => { localStorage.setItem('lang', l); }, lang);
  await page.reload();
  await page.waitForSelector('h2');
  const next = () => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  await page.click(`label[for="board-${board}"]`);
  await next();
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await next();
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file|选择文件/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await next();
  await page.waitForSelector('#drivers-auto');
  return page.evaluate(() => ({
    auto: document.querySelector('#drivers-auto').textContent,
    optional: [...document.querySelectorAll('button')].map((b) => b.textContent).find((x) => /driver folder|驱动文件夹/.test(x)) ?? '',
  }));
}

try {
  // A release with the package.
  let app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_RK3576_DRIVERS_URL: url, WOA_IMAGER_RK3576_DRIVERS_SHA256: sha(zip), WOA_IMAGER_RK3576_DRIVERS_SIZE: String(zip.length) } });
  let page = await app.firstWindow();
  const t = await setupText(page, 'tspi3m', 'en');
  expect(/Installed automatically/.test(t.auto) && /GPU/.test(t.auto) && /NPU/.test(t.auto) && /touch screen/.test(t.auto) && /Bluetooth/.test(t.auto), `TaishanPi 3M: the package is installed automatically, with the touch screen and Bluetooth (${t.auto})`);
  expect(/optional/i.test(t.optional), `adding a driver folder is optional (${t.optional})`);
  const c = await setupText(page, 'cm5io', 'zh-CN');
  expect(/自动安装/.test(c.auto) && /电源键/.test(c.auto) && !/触摸屏/.test(c.auto), `CM5-IO in Chinese: power button, no touch screen (${c.auto})`);
  expect(/可选/.test(c.optional), `zh: adding a driver folder is optional (${c.optional})`);

  // What the app stages for each board, out of the downloaded package.
  const staged = {};
  for (const b of ['tspi3m', 'cm5io', 'rock4d']) {
    const r = await page.evaluate((boardId) => window.imager.prepareExtras({ ssh: false, drivers: null, boardId }), b);
    if ('error' in r) { failures.push(`${b}: ${r.error}`); continue; }
    staged[b] = [...new Set(r.files.filter((f) => f.path.startsWith('rk3576-drivers/')).map((f) => f.path.split('/')[1]))];
  }
  console.log(JSON.stringify(staged));
  const all = ['dwcsdhc', 'dwcmshc', 'maliwddm', 'vdpu383', 'rknpu', 'es8323'];
  expect(staged.tspi3m && all.every((d) => staged.tspi3m.includes(d)) && staged.tspi3m.includes('gt9271') && staged.tspi3m.includes('bcm4345bt') && !staged.tspi3m.includes('rk806pwrkey'), 'TaishanPi 3M gets its list');
  expect(staged.cm5io && all.every((d) => staged.cm5io.includes(d)) && staged.cm5io.includes('rk806pwrkey') && !staged.cm5io.includes('gt9271') && !staged.cm5io.includes('bcm4345bt'), 'CM5-IO gets its list, without the optional Bluetooth');
  expect(staged.rock4d && staged.rock4d.includes('rkeeprom') && !staged.rock4d.includes('gt9271'), 'ROCK 4D gets the EEPROM and no touch screen');
  expect(downloads <= 1, `the package is downloaded at most once and kept (${downloads} downloads)`);
  await app.close();

  // A package whose SHA-256 is not the one the release gives: refused.
  app = await electron.launch({ args: ['.'], env: { ...base, WOA_IMAGER_RK3576_DRIVERS_URL: url, WOA_IMAGER_RK3576_DRIVERS_SHA256: 'e'.repeat(64), WOA_IMAGER_RK3576_DRIVERS_SIZE: String(zip.length) } });
  page = await app.firstWindow();
  await page.waitForSelector('h2');
  const bad = await page.evaluate(() => window.imager.prepareExtras({ ssh: false, drivers: null, boardId: 'tspi3m' }));
  expect('error' in bad, `a package with the wrong SHA-256 is refused (${bad.error ?? 'accepted'})`);
  await app.close();

  // A release without the package (the made-up 0.1.1).
  app = await electron.launch({ args: ['.'], env: base });
  page = await app.firstWindow();
  const w = await setupText(page, 'rock4d', 'en');
  expect(/no driver package/.test(w.auto), `without a package the page says the WinPE drivers are installed (${w.auto})`);
  await app.close();
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) { console.error(`FAIL:\n${failures.join('\n')}`); process.exit(1); }
console.log('PASS: the board\'s drivers come from the package automatically, and the page says so');
