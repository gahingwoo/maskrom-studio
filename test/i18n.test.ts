import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickLang, translateMessage, translator } from '../src/shared/i18n';
import { MESSAGE_PATTERNS, MESSAGES } from '../src/renderer/messages';
import { WOA_BOARDS } from '../src/woa/boards';

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

  it('has the board keys App.tsx builds from boards.ts', () => {
    const keys: string[] = [];
    for (const b of WOA_BOARDS) {
      keys.push(`board.fw.${b.firmwareStorage}`, `board.maskrom.${b.maskromEntry}`, ...b.windowsTargets.map((x) => `where.${x}`), ...b.windowsTargets.map((x) => `dest.${x}`));
      if (b.windowsTargets.includes('sd')) keys.push(`dest.sd.desc.${b.sdBoot}`);
      // English from edk2-webflash, Chinese here, step by step.
      b.webflash.maskrom.forEach((_s, i) => keys.push(`maskrom.${b.id}.${i + 1}`));
      if (b.webflash.maskromNote) keys.push(`maskrom.${b.id}.note`);
      if (b.factoryPage) keys.push(`restore.factory.${b.id}`, `sd.boot.${b.sdBoot}.title`, `sd.boot.${b.sdBoot}.armbian`, `sd.boot.${b.sdBoot}.uefi`, `next.drive.${b.sdBoot}`);
      if (b.emmc) keys.push(`s.ready.${b.id}.1`);
    }
    expect(keys.filter((k) => !MESSAGES[k])).toEqual([]);
    expect(translateMessage('Windows is not installed to an NVMe drive on the LCKFB TaishanPi 3M. Nothing was written.', MESSAGE_PATTERNS, 'zh-CN'))
      .toBe('LCKFB TaishanPi 3M 不支持把 Windows 装到 NVMe 硬盘。没有写入任何内容。');
  });

  it('fills placeholders and translates known messages', () => {
    const t = translator(MESSAGES, 'zh-CN');
    expect(t('task.lead', { board: 'ArmSoM CM5-IO' })).toBe('目标开发板：ArmSoM CM5-IO。');
    expect(translateMessage('No board in MaskROM mode was found.', MESSAGE_PATTERNS, 'zh-CN')).toBe('没有找到 MaskROM 模式的开发板。');
    expect(translateMessage('Something new.', MESSAGE_PATTERNS, 'zh-CN')).toBe('Something new.');
  });
});
