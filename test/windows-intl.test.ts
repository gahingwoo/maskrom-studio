import { describe, expect, it } from 'vitest';
import { accountProblem, unattendXml, type Account } from '../src/woa/setup-files';
import {
  defaultLanguage, imageHasLanguage, keyboardChoices, languageChoices, languageName, matchLanguage, timeZoneChoices,
  WINDOWS_KEYBOARDS, WINDOWS_LANGUAGES, WINDOWS_TIME_ZONES, windowsZoneFor,
} from '../src/shared/windows-intl';

const base: Account = { user: 'woa', password: 'x', computerName: '', locale: '', keyboard: '', timeZone: '', autoLogonAlways: false };

describe('the language, keyboard and time zone lists', () => {
  it('hold only values the answer file check accepts, each once', () => {
    for (const l of WINDOWS_LANGUAGES) expect(accountProblem({ ...base, locale: l.tag }), l.tag).toBeNull();
    for (const k of WINDOWS_KEYBOARDS) expect(accountProblem({ ...base, keyboard: k.value }), k.value).toBeNull();
    for (const z of WINDOWS_TIME_ZONES) expect(accountProblem({ ...base, timeZone: z.id }), z.id).toBeNull();
    for (const list of [WINDOWS_LANGUAGES.map((l) => l.tag), WINDOWS_KEYBOARDS.map((k) => k.value), WINDOWS_TIME_ZONES.map((z) => z.id)]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
  it('have the 23H2 display languages and the common regional formats', () => {
    const packs = WINDOWS_LANGUAGES.filter((l) => l.pack).map((l) => l.tag);
    for (const t of ['en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ja-JP', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'ko-KR']) expect(packs).toContain(t);
    for (const t of ['en-NZ', 'en-AU', 'en-CA', 'en-IN', 'de-CH', 'fr-BE']) expect(WINDOWS_LANGUAGES.map((l) => l.tag)).toContain(t);
  });
  it('names them in the page language with the code', () => {
    expect(languageName('zh-CN', 'zh-CN')).toBe('中文（中国）');
    expect(languageName('en-NZ', 'en')).toBe('English (New Zealand)');
    const zh = languageChoices('zh-CN').find((c) => c.value === 'zh-CN')!;
    expect(zh).toMatchObject({ label: '中文（中国）', detail: 'zh-CN' });
    // Typing the English name finds it on the Chinese page too.
    expect(zh.search).toContain('chinese');
    expect(keyboardChoices('en').find((c) => c.value === '1409:00001409')).toMatchObject({ label: 'NZ Aotearoa, English (New Zealand)' });
    expect(keyboardChoices('en').find((c) => c.value === 'zh-CN')!.label).toBe('Microsoft Pinyin, Chinese (China)');
    expect(keyboardChoices('en').find((c) => c.value === '0409:00000409')!.label).toBe('US, English (United States)');
  });
  it('lists Windows time zones as Windows shows them, in its order', () => {
    const z = timeZoneChoices();
    expect(z.find((c) => c.value === 'New Zealand Standard Time')).toMatchObject({ label: '(UTC+12:00) Auckland, Wellington' });
    expect(z.find((c) => c.value === 'China Standard Time')!.label).toMatch(/^\(UTC\+08:00\) Beijing/);
    expect(z[0].value).toBe('Dateline Standard Time');
    expect(z.find((c) => c.value === 'New Zealand Standard Time')!.search).toContain('auckland');
    // The IANA city finds the zone even when Windows' name does not say it.
    expect(z.find((c) => c.value === 'China Standard Time')!.search).toContain('shanghai');
  });
});

describe('what is preselected from the PC', () => {
  it('maps the PC time zone, aliases included', () => {
    expect(windowsZoneFor('Pacific/Auckland')).toBe('New Zealand Standard Time');
    expect(windowsZoneFor('Asia/Shanghai')).toBe('China Standard Time');
    expect(windowsZoneFor('Asia/Kolkata')).toBe('India Standard Time');
    expect(windowsZoneFor('Asia/Calcutta')).toBe('India Standard Time');
    expect(windowsZoneFor('Europe/Kyiv')).toBe('FLE Standard Time');
    expect(windowsZoneFor('America/New_York')).toBe('Eastern Standard Time');
    expect(windowsZoneFor('Europe/London')).toBe('GMT Standard Time');
    expect(windowsZoneFor('UTC')).toBe('UTC');
    expect(windowsZoneFor('Mars/Olympus')).toBeNull();
    expect(windowsZoneFor(undefined)).toBeNull();
  });
  it('reads the PC locale in its several spellings', () => {
    expect(matchLanguage('en-NZ')).toBe('en-NZ');
    expect(matchLanguage('en_NZ.UTF-8')).toBe('en-NZ');
    expect(matchLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(matchLanguage('zh-Hant')).toBe('zh-TW');
    expect(matchLanguage('de')).toBe('de-DE');
    expect(matchLanguage('C')).toBeNull();
    expect(matchLanguage('')).toBeNull();
  });
  it('takes the PC language only where the image can show it, else the same language of the image, else none', () => {
    expect(defaultLanguage('zh-CN', ['zh-CN'])).toBe('zh-CN');
    expect(defaultLanguage('en-NZ', ['en-US'])).toBe('en-US');
    expect(defaultLanguage('en-NZ', ['en-NZ', 'en-US'])).toBe('en-NZ');
    expect(defaultLanguage('de-DE', ['en-US'])).toBe('');
    expect(defaultLanguage('en-US', [])).toBe('');
    expect(imageHasLanguage('en-NZ', ['en-US'])).toBe(false);
    expect(imageHasLanguage('', ['en-US'])).toBe(true);
  });
});

describe('the answer file from picked values', () => {
  it('is what typing the same codes wrote', () => {
    const a: Account = { ...base, locale: 'en-NZ', keyboard: '1409:00001409', timeZone: 'New Zealand Standard Time' };
    const x = unattendXml(a);
    expect(x).toContain('      <InputLocale>1409:00001409</InputLocale>\n      <SystemLocale>en-NZ</SystemLocale>\n      <UILanguage>en-NZ</UILanguage>\n      <UserLocale>en-NZ</UserLocale>\n');
    expect(x).toContain('      <TimeZone>New Zealand Standard Time</TimeZone>\n');
    // An input method is its language tag; an empty keyboard follows the language.
    expect(unattendXml({ ...a, locale: 'zh-CN', keyboard: '' })).toContain('<InputLocale>zh-CN</InputLocale>');
    expect(unattendXml({ ...base })).not.toMatch(/International-Core|<TimeZone>/);
  });
});
