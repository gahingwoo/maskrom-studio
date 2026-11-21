import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickLang, translateMessage, translator } from '../src/shared/i18n';
import { MESSAGE_PATTERNS, MESSAGES } from '../src/renderer/messages';

const src = (f: string) => readFileSync(join(__dirname, '..', 'src', 'renderer', f), 'utf8');

describe('i18n', () => {
  it('follows the system language unless one was chosen', () => {
    expect(pickLang(null, ['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(pickLang(null, ['zh'])).toBe('zh-CN');
    expect(pickLang(null, ['de-DE', 'en-GB'])).toBe('en');
    expect(pickLang('en', ['zh-CN'])).toBe('en');
    expect(pickLang('fr', ['zh-CN'])).toBe('zh-CN');
  });

  it('has every key the page uses, in both languages', () => {
    const used = new Set<string>();
    for (const f of ['App.tsx', 'common.tsx']) {
      for (const m of src(f).matchAll(/\bt\('([a-zA-Z0-9.-]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !MESSAGES[k]);
    expect(missing).toEqual([]);
    for (const [k, v] of Object.entries(MESSAGES)) {
      // Keys whose English comes from edk2-webflash's board list have only Chinese here.
      if (v.en) expect(v['zh-CN'], k).not.toBe('');
      expect(`${v.en}${v['zh-CN']}`, k).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('fills placeholders and translates known messages', () => {
    const t = translator(MESSAGES, 'zh-CN');
    expect(t('task.lead', { board: 'ArmSoM CM5-IO' })).toBe('目标开发板：ArmSoM CM5-IO。');
    expect(translateMessage('No board in Maskrom mode was found.', MESSAGE_PATTERNS, 'zh-CN')).toBe('没有找到 MaskROM 模式的开发板。');
    expect(translateMessage('Something new.', MESSAGE_PATTERNS, 'zh-CN')).toBe('Something new.');
  });
});
