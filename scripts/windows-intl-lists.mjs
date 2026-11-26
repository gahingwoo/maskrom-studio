// Writes src/shared/windows-intl.json, the lists behind the language,
// keyboard and time zone pickers of the "skip setup" page, from:
//   - Microsoft, "Available language packs for Windows": the display
//     languages (pack: true) and the language interface packs;
//   - Microsoft, "Default input profiles (input locales) in Windows": the
//     locales and their keyboards, as LCID:KLID pairs;
//   - Unicode CLDR windowsZones.xml: Windows time zone IDs, their display
//     names and the IANA zones each one stands for;
//   - Unicode CLDR bcp47/timezone.xml: IANA aliases (Asia/Kolkata is
//     Asia/Calcutta in windowsZones.xml).
// Run again to refresh (needs the network):
//   node scripts/windows-intl-lists.mjs
// test/windows-intl.test.ts checks every value against accountProblem.
import { writeFileSync } from 'node:fs';

const MS = 'https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop';
const SRC = {
  languages: `${MS}/available-language-packs-for-windows?view=windows-11`,
  keyboards: `${MS}/default-input-locales-for-windows-language-packs?view=windows-11`,
  zones: 'https://raw.githubusercontent.com/unicode-org/cldr/main/common/supplemental/windowsZones.xml',
  aliases: 'https://raw.githubusercontent.com/unicode-org/cldr/main/common/bcp47/timezone.xml',
};

const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); };
const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const text = (h) => unescape(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tables = (html) => [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((t) =>
  [...t[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1]))).slice(1));

// The same checks as accountProblem in src/woa/setup-files.ts.
const LOCALE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Z]{2})?$/;
const KLID = /^[0-9a-fA-F]{4}:[0-9a-fA-F]{8}$/;

const [langHtml, kbHtml, zonesXml, aliasXml] = await Promise.all([get(SRC.languages), get(SRC.keyboards), get(SRC.zones), get(SRC.aliases)]);

// Languages: table 1 is the full language packs, the others the interface packs.
const languages = new Map();
tables(langHtml).forEach((rows, i) => {
  for (const r of rows) {
    if (/No longer used/.test(r[1])) continue;
    const tag = r[1].split(' ')[0];
    if (LOCALE.test(tag) && !languages.has(tag)) languages.set(tag, { tag, name: r[0], pack: i === 0 });
  }
});

// Keyboards: "en-NZ: NZ Aotearoa keyboard (1409:00001409)"; an input method is
// "zh-CN: Microsoft Pinyin (0804:{GUID}{GUID})" and is offered as its language tag.
const english = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' });
const keyboards = new Map();
for (const rows of tables(kbHtml)) {
  for (const [region, ...cells] of rows) {
    // A cell can hold several profiles: "vi-VN: ... (042A:...) en-US: US keyboard (0409:00000409)".
    for (const p of cells.flatMap((c) => c.split(/(?<=\)) (?=[a-z]{2,3}(?:-[A-Za-z0-9]+)*: )/))) {
      const m = /^([A-Za-z0-9-]+): (.+?) \(([0-9A-Fa-f]{4}:(?:[0-9A-Fa-f]{8}|\{[^)]*))\)$/.exec(p);
      if (!m) continue;
      const [, tag, layout, pair] = m;
      if (!LOCALE.test(tag)) continue;
      // The row is a region ("English (Belgium)" uses fr-BE), so the tag is named by Intl.
      if (!languages.has(tag)) languages.set(tag, { tag, name: english.of(tag) ?? tag, pack: false });
      const value = KLID.test(pair) ? pair.toUpperCase() : tag;
      const name = layout.replace(/ keyboard$/, '');
      // An input method is chosen by its language tag, so Windows takes that language's default one:
      // name it after the row for the language's main region ("Chinese (Traditional, Taiwan)": Bopomofo).
      const had = keyboards.get(value);
      if (!had || (had.ime && had.tag === tag && region.startsWith(had.region.replace(/\)$/, '')) && region.length > had.region.length)) keyboards.set(value, { value, layout: name, tag, ime: !KLID.test(pair), region });
    }
  }
}

// Time zones, in windowsZones.xml order (by UTC offset, as Windows lists them).
const zones = [];
const iana = {};
for (const m of zonesXml.matchAll(/<!-- (\(UTC[^)]*\)[^>]*?) -->(?:[ \t]*<!--[^>]*-->)?\s*<mapZone other="([^"]+)" territory="001" type="([^"]+)"\/>/g)) {
  zones.push({ id: m[2], display: m[1].trim() });
}
for (const m of zonesXml.matchAll(/<mapZone other="([^"]+)" territory="([^"]+)" type="([^"]+)"\/>/g)) {
  for (const z of m[3].split(' ')) if (!(z in iana) || m[2] === '001') iana[z] = m[1];
}
// Every alias of a zone that windowsZones.xml names maps to the same Windows zone.
for (const m of aliasXml.matchAll(/<type name="[^"]+"[^>]*?alias="([^"]+)"/g)) {
  const names = m[1].split(' ');
  const known = names.find((n) => n in iana);
  if (known) for (const n of names) if (!(n in iana)) iana[n] = iana[known];
}

const ids = new Set(zones.map((z) => z.id));
for (const w of Object.values(iana)) if (!ids.has(w)) throw new Error(`${w} has no display name`);

const out = {
  comment: 'Generated by scripts/windows-intl-lists.mjs; do not edit. Values for unattend.xml: languages (InputLocale, SystemLocale, UILanguage, UserLocale; pack: a Windows display language), keyboards (InputLocale), time zones (TimeZone), and the IANA zone of the PC to its Windows zone.',
  sources: SRC,
  fetched: new Date().toISOString().slice(0, 10),
  languages: [...languages.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
  keyboards: [...keyboards.values()].map(({ region: _r, ...k }) => k).sort((a, b) => a.value.localeCompare(b.value)),
  timeZones: zones,
  ianaToWindows: Object.fromEntries(Object.entries(iana).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync('src/shared/windows-intl.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(`languages ${out.languages.length} (${out.languages.filter((l) => l.pack).length} display), keyboards ${out.keyboards.length}, time zones ${zones.length}, IANA names ${Object.keys(iana).length}`);
