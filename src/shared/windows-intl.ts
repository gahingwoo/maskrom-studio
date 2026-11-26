// The choices behind the language, keyboard and time zone pickers of the
// "skip setup" page, from windows-intl.json (scripts/windows-intl-lists.mjs:
// Microsoft's language pack and input profile tables, CLDR's Windows zones).
// The values are what unattend.xml takes, unchanged: a language tag such as
// zh-CN, an input locale such as 1409:00001409 (or a language tag for an
// input method), a Windows time zone ID such as New Zealand Standard Time.
// Names are the PC's own (Intl.DisplayNames) in the page's language, with
// Microsoft's English name when Intl has none.
import data from './windows-intl.json';
import type { Lang } from './i18n';

export interface WindowsLanguage { tag: string; name: string; pack: boolean }
export interface WindowsKeyboard { value: string; layout: string; tag: string; ime: boolean }
export interface WindowsTimeZone { id: string; display: string }

export const WINDOWS_LANGUAGES: WindowsLanguage[] = data.languages;
export const WINDOWS_KEYBOARDS: WindowsKeyboard[] = data.keyboards;
export const WINDOWS_TIME_ZONES: WindowsTimeZone[] = data.timeZones;
const IANA: Record<string, string> = data.ianaToWindows;

/** One entry of a picker: what is written, what is shown, what typing matches. */
export interface Choice { value: string; label: string; detail: string; search: string }

const names = new Map<string, Intl.DisplayNames | null>();
function displayNames(lang: Lang): Intl.DisplayNames | null {
  if (!names.has(lang)) {
    try { names.set(lang, new Intl.DisplayNames([lang], { type: 'language', languageDisplay: 'standard' })); } catch { names.set(lang, null); }
  }
  return names.get(lang)!;
}

/** "中文（中国）" or "English (New Zealand)" for a tag, in the page's language. */
export function languageName(tag: string, lang: Lang): string {
  let n: string | undefined;
  try { n = displayNames(lang)?.of(tag); } catch { /* not a tag Intl knows */ }
  if (n && n !== tag) return n;
  return WINDOWS_LANGUAGES.find((l) => l.tag === tag)?.name ?? tag;
}

const english = (tag: string) => WINDOWS_LANGUAGES.find((l) => l.tag === tag)?.name ?? '';
const byLabel = (lang: Lang) => (a: Choice, b: Choice) => a.label.localeCompare(b.label, lang) || a.value.localeCompare(b.value);

export function languageChoices(lang: Lang): Choice[] {
  return WINDOWS_LANGUAGES.map((l) => {
    const label = languageName(l.tag, lang);
    return { value: l.tag, label, detail: l.tag, search: `${label} ${l.tag} ${l.name}`.toLowerCase() };
  }).sort(byLabel(lang));
}

export function keyboardChoices(lang: Lang): Choice[] {
  return WINDOWS_KEYBOARDS.map((k) => {
    const label = `${k.layout}, ${languageName(k.tag, lang)}`;
    return { value: k.value, label, detail: k.value, search: `${label} ${k.value} ${english(k.tag)}`.toLowerCase() };
  }).sort(byLabel(lang));
}

/** In Windows' own order, by UTC offset. */
export function timeZoneChoices(): Choice[] {
  const cities = new Map<string, string[]>();
  for (const [z, w] of Object.entries(IANA)) if (z.includes('/')) cities.set(w, [...(cities.get(w) ?? []), z.split('/').pop()!.replace(/_/g, ' ')]);
  return WINDOWS_TIME_ZONES.map((z) => ({
    value: z.id, label: z.display, detail: z.id,
    search: `${z.display} ${z.id} ${(cities.get(z.id) ?? []).join(' ')}`.toLowerCase(),
  }));
}

/** The Windows time zone for an IANA one (the PC's), or null. */
export function windowsZoneFor(iana: string | undefined | null): string | null {
  return (iana && IANA[iana]) || null;
}

/** The listed tag a system locale means: en_NZ.UTF-8, en-NZ, zh-Hans-CN, de. */
export function matchLanguage(system: string | undefined | null): string | null {
  if (!system) return null;
  const raw = system.replace(/[.@].*$/, '').replace(/_/g, '-');
  const has = (t: string) => WINDOWS_LANGUAGES.some((l) => l.tag === t);
  if (has(raw)) return raw;
  let loc: Intl.Locale;
  try { loc = new Intl.Locale(raw); } catch { return null; }
  const full = loc.region ? loc : loc.maximize();
  const tries = [`${full.language}-${full.script}-${full.region}`, `${full.language}-${full.region}`];
  // zh-Hant without a region is Taiwan's; zh-Hans China's (maximize says so).
  return tries.find(has) ?? null;
}

/**
 * The language preselected for the image: the PC's when the image has it as
 * a display language; else the image's language of the same family (an
 * en-NZ PC and an en-US image: en-US); else none (the image's own).
 */
export function defaultLanguage(system: string | undefined | null, imageLanguages: string[]): string {
  const pc = matchLanguage(system);
  if (!pc || imageLanguages.length === 0) return '';
  const lower = imageLanguages.map((l) => l.toLowerCase());
  const exact = lower.indexOf(pc.toLowerCase());
  if (exact >= 0) return imageLanguages[exact];
  const base = pc.split('-')[0].toLowerCase();
  const same = imageLanguages.find((l) => l.toLowerCase().split('-')[0] === base);
  return same && WINDOWS_LANGUAGES.some((l) => l.tag === same) ? same : '';
}

/** Whether Windows can show its menus in this language with this image (a display language it has). */
export function imageHasLanguage(tag: string, imageLanguages: string[]): boolean {
  return !tag || imageLanguages.some((l) => l.toLowerCase() === tag.toLowerCase());
}
