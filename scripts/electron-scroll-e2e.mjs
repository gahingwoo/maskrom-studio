// Scrolling and text selection in the real app window, at small sizes: in
// every step, the run view and the dialogs exactly one element scrolls, a
// mouse wheel over the content moves it, and the page itself never does.
// Ctrl+A outside a text field selects nothing. Runs hidden, with made-up
// releases, the Windows image of test/fixtures and a pretend update.img.
//   node scripts/electron-scroll-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'woa-scroll-'));
const iso = join(tmp, 'Win11_23H2_ARM64.iso');
writeFileSync(iso, execFileSync('xz', ['-dc', 'test/fixtures/udf-small.iso.xz']));
const env = { ...process.env, WOA_IMAGER_HIDDEN: '1', WOA_IMAGER_FAKE_RELEASES: '1', WOA_IMAGER_FAKE_UPDATE: 'current', WOA_IMAGER_TEST_PICK: iso };
delete env.ELECTRON_RUN_AS_NODE;
const failures = [];

/** The elements that scroll now, and whether a wheel over (x, y) moves one of them. */
async function check(page, tag, at = [450, 330], within = null) {
  const found = await page.evaluate((within) => {
    const out = [];
    const root = within ? document.querySelector(within) : document;
    for (const el of [...(within ? [root] : []), ...root.querySelectorAll('*')]) {
      if (el.offsetParent === null && el !== document.body) continue;
      const cs = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(cs.overflowY)) out.push(el.className.toString().split(' ')[0] || el.tagName);
    }
    const d = document.scrollingElement;
    return { out, page: d.scrollHeight > d.clientHeight + 1 };
  }, within);
  const big = found.out.filter((c) => !/code-block|log/.test(c));
  if (found.page) failures.push(`${tag}: the page itself scrolls`);
  if (big.length > 1) failures.push(`${tag}: ${big.length} scroll containers (${big.join(', ')})`);
  if (big.length === 1) {
    await page.mouse.move(at[0], at[1]);
    const sum = () => page.evaluate(() => [...document.querySelectorAll('*')].reduce((a, e) => a + e.scrollTop, 0));
    const before = await sum();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    const moved = (await sum()) - before;
    if (moved <= 0) failures.push(`${tag}: the wheel did not scroll ${big[0]}`);
    console.log(`${tag}: ${big[0]} scrolls, wheel moved it ${moved}px`);
  } else console.log(`${tag}: fits, nothing to scroll`);
}

for (const [w, h] of [[900, 600], [1024, 700], [720, 480]]) {
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
  await page.evaluate(() => { localStorage.setItem('lang', 'en'); });
  await page.reload();
  await page.waitForSelector('h2');
  const tag = (s) => `${w}x${h} ${s}`;
  const next = () => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  const back = () => page.click('.pf-v6-c-wizard__footer button.pf-m-secondary');
  await check(page, tag('board'));

  // Ctrl+A outside a field selects nothing; inside one it selects the field's text.
  await page.mouse.click(w - 60, h - 30);
  await page.keyboard.press('Control+A');
  const sel = await page.evaluate(() => String(window.getSelection()));
  if (sel.trim() !== '') failures.push(`${tag('board')}: Ctrl+A selected page text (${sel.slice(0, 40)}...)`);
  const us = await page.evaluate(() => getComputedStyle(document.querySelector('.pf-v6-c-wizard__main-body') ?? document.body).userSelect);
  if (us !== 'none') failures.push(`${tag('board')}: step text is selectable (user-select ${us})`);

  await page.click('label[for="board-tspi3m"]');
  await next();
  await page.waitForSelector('#task-windows');
  await page.click('label[for="task-windows"]');
  await check(page, tag('task'));
  await next();
  await page.waitForSelector('.drop');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Choose a file/.test(b.textContent))?.click(); });
  await page.waitForSelector('text=Windows 11 Pro');
  await check(page, tag('windows'));
  await next();
  await page.waitForSelector('#first-skip');
  await page.click('label[for="first-skip"]');
  await page.fill('#acc-user', 'woa');
  const inField = await page.evaluate(() => { const i = document.querySelector('#acc-user'); i.focus(); i.select(); return getComputedStyle(i).userSelect; });
  if (inField === 'none') failures.push(`${tag('setup')}: text fields cannot be selected`);
  await page.fill('#acc-password', 'example');
  await page.fill('#acc-password2', 'example');
  await check(page, tag('setup'));
  await next();
  await page.waitForSelector('text=Connect and write');
  await check(page, tag('review'));

  // The other tasks' steps: firmware upgrade is not reachable without a firmware image; Armbian and the factory image are.
  for (let i = 0; i < 3; i++) await back();
  await page.waitForSelector('#task-armbian');
  await page.click('label[for="task-armbian"]');
  await next();
  await page.waitForSelector('text=26.11.0-trunk.137');
  await check(page, tag('restore'));
  await back();

  // Dialogs: Settings, About.
  await page.click('.pf-v6-c-masthead button:has-text("Settings")');
  await page.waitForSelector('.pf-v6-c-modal-box');
  await page.waitForTimeout(300);
  await check(page, tag('settings'), [w / 2, h / 2], '.pf-v6-c-modal-box');
  await page.click('button.link-button');
  await page.waitForSelector('#about-title');
  await page.waitForTimeout(500);
  await check(page, tag('about'), [w / 2, h / 2], '.about-backdrop');
  const aboutSel = await page.evaluate(() => getComputedStyle(document.querySelector('.about-backdrop .pf-v6-c-description-list__description')).userSelect);
  if (aboutSel === 'none') failures.push(`${tag('about')}: the About values cannot be selected`);
  await page.keyboard.press('Escape');
  await app.close();
}
rmSync(tmp, { recursive: true, force: true });
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PASS: one scroller per view, the wheel scrolls it, Ctrl+A selects nothing outside a field');
