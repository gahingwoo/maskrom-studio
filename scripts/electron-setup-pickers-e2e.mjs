// The language, keyboard and time zone pickers of the "skip setup" page in
// the real app window: preselected from a pretend PC (WOA_IMAGER_TEST_LOCALE,
// WOA_IMAGER_TEST_TZ), found by typing, chosen with the keyboard and the
// mouse, cleared, and shown on the review as the codes the answer file gets.
// Runs hidden, with made-up releases and the Windows image of test/fixtures.
//   node scripts/electron-setup-pickers-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'woa-pickers-'));
// A WIM header and its XML (as test/windows-vetting.test.ts builds them): one 23H2 Pro edition in `lang`.
function wim(lang) {
  const xml = `<WIM><TOTALBYTES>0</TOTALBYTES><IMAGE INDEX="1"><TOTALBYTES>16000000000</TOTALBYTES><WINDOWS><ARCH>12</ARCH><EDITIONID>Professional</EDITIONID>`
    + `<INSTALLATIONTYPE>Client</INSTALLATIONTYPE><LANGUAGES><LANGUAGE>${lang}</LANGUAGE><DEFAULT>${lang}</DEFAULT></LANGUAGES>`
    + '<VERSION><MAJOR>10</MAJOR><MINOR>0</MINOR><BUILD>22631</BUILD><SPBUILD>2861</SPBUILD></VERSION></WINDOWS><NAME>Windows 11 Pro</NAME><DISPLAYNAME>Windows 11 Pro</DISPLAYNAME></IMAGE></WIM>';
  const x = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  const out = Buffer.alloc(208 + 4096 + x.length);
  out.write('MSWIM\0\0\0', 0, 'latin1');
  out.writeUInt32LE(208, 8); out.writeUInt32LE(0x00010d00, 12); out.writeUInt16LE(1, 40); out.writeUInt16LE(1, 42); out.writeUInt32LE(1, 44);
  out.writeUInt32LE(x.length, 72); out[79] = 0x02; out.writeUInt32LE(208 + 4096, 80); out.writeUInt32LE(x.length, 88);
  x.copy(out, 208 + 4096);
  const p = join(tmp, `install-${lang}.wim`);
  writeFileSync(p, out);
  return p;
}
const base = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_UI_MODE: 'advanced', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current' };
delete base.ELECTRON_RUN_AS_NODE;
const failures = [];
const expect = (tag, got, want) => { if (got !== want) failures.push(`${tag}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); else console.log(`ok ${tag}: ${got}`); };

async function toSetup(env, lang) {
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
  await page.evaluate((l) => { localStorage.setItem('lang', l); }, lang);
  await page.reload();
  await page.waitForSelector('h2');
  const next = () => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  await page.click('label[for="board-tspi3m"]');
  await next();
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await next();
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file|选择文件/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await next();
  await page.waitForSelector('#first-skip');
  await page.click('label[for="first-skip"]');
  await page.waitForSelector('#acc-locale');
  return { app, page, next };
}
const value = (page, id) => page.inputValue(`#${id}`);
const options = (page, id) => page.$$eval(`#${id}-list li`, (li) => li.map((l) => l.textContent.trim()));

try {
  // An English page on a New Zealand PC; the image has en-US only.
  {
    const { app, page, next } = await toSetup({ ...base, WOA_IMAGER_TEST_PICK: wim('en-US'), WOA_IMAGER_TEST_LOCALE: 'en-NZ', WOA_IMAGER_TEST_TZ: 'Pacific/Auckland' }, 'en');
    expect('time zone from the PC', await value(page, 'acc-timeZone'), '(UTC+12:00) Auckland, Wellington');
    expect('language: the image\'s English for an en-NZ PC', await value(page, 'acc-locale'), 'English (United States) en-US');
    expect('keyboard follows the language', await value(page, 'acc-keyboard'), '');

    // Typing filters; Enter takes the only match.
    await page.click('#acc-keyboard');
    await page.fill('#acc-keyboard', 'aotearoa');
    const kb = await options(page, 'acc-keyboard');
    expect('keyboard search', kb.length === 1 && kb[0].startsWith('NZ Aotearoa, English (New Zealand)') ? 'one' : kb.join(' | '), 'one');
    await page.keyboard.press('Enter');
    expect('keyboard chosen with Enter', await value(page, 'acc-keyboard'), 'NZ Aotearoa, English (New Zealand) 1409:00001409');

    // Arrow keys and Enter; a language the image cannot show is allowed, with a warning.
    await page.click('#acc-locale');
    await page.fill('#acc-locale', 'new zealand');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect('language chosen with the arrow keys', await value(page, 'acc-locale'), 'English (New Zealand) en-NZ');
    expect('warning for a language not in the image', await page.locator('text=en-NZ is not a display language of this image').count(), 1);

    // The clear button gives the empty choice; a click on an option chooses it.
    await page.click('.pf-v6-c-form__group:has(#acc-timeZone) button[aria-label="Clear"]');
    expect('time zone cleared', await value(page, 'acc-timeZone'), '');
    await page.click('#acc-timeZone');
    await page.fill('#acc-timeZone', 'tokyo');
    await page.click('#acc-timeZone-list li:has-text("Osaka, Sapporo, Tokyo") button');
    expect('time zone chosen with the mouse', await value(page, 'acc-timeZone'), '(UTC+09:00) Osaka, Sapporo, Tokyo');
    await page.click('#acc-locale');
    await page.fill('#acc-locale', 'qqqq');
    expect('no match', (await options(page, 'acc-locale')).join(), 'Nothing matches.');
    await page.keyboard.press('Escape');
    expect('Escape keeps the choice', await value(page, 'acc-locale'), 'English (New Zealand) en-NZ');

    await page.fill('#acc-user', 'woa');
    await page.fill('#acc-password', 'example');
    await page.fill('#acc-password2', 'example');
    await next();
    await page.waitForSelector('text=Language, keyboard, time zone');
    const row = await page.locator('.pf-v6-c-description-list__group:has-text("Language, keyboard, time zone") .pf-v6-c-description-list__description').innerText();
    expect('review shows the answer file values', row.trim(), 'en-NZ; keyboard 1409:00001409; Tokyo Standard Time');
    await app.close();
  }
  // A Chinese page on a PC in Shanghai and a zh-CN image: names in Chinese, zh-CN preselected.
  {
    const { app, page } = await toSetup({ ...base, WOA_IMAGER_TEST_PICK: wim('zh-CN'), WOA_IMAGER_TEST_LOCALE: 'zh-CN', WOA_IMAGER_TEST_TZ: 'Asia/Shanghai' }, 'zh-CN');
    expect('zh time zone from the PC', await value(page, 'acc-timeZone'), '(UTC+08:00) Beijing, Chongqing, Hong Kong, Urumqi');
    expect('zh language from the PC, in the image', await value(page, 'acc-locale'), '中文（中国） zh-CN');
    await page.click('.pf-v6-c-form__group:has(#acc-locale) button[aria-label="清除"]');
    expect('zh language cleared', await value(page, 'acc-locale'), '');
    await page.click('#acc-locale');
    await page.fill('#acc-locale', 'zh-cn');
    const zh = await options(page, 'acc-locale');
    expect('Chinese name with the code', zh[0], '中文（中国）zh-CN');
    await page.keyboard.press('Enter');
    expect('zh chosen', await value(page, 'acc-locale'), '中文（中国） zh-CN');
    await app.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) { console.log(`FAIL\n${failures.join('\n')}`); process.exit(1); }
console.log('PASS: setup pickers preselect, search, choose, clear and reach the review');
