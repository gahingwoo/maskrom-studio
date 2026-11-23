// Render resources/icons/maskrom-studio.svg into the PNG sizes, the .ico
// and the .icns that scripts/icons.mjs lays out for the packagers. Run once
// after changing the SVG; the results are committed.
//   node scripts/make-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'resources/icons';
const svg = readFileSync(`${SRC}/maskrom-studio.svg`, 'utf8');
const png = (size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const pngs = Object.fromEntries([...sizes, 1024].map((s) => [s, png(s)]));
for (const s of sizes) writeFileSync(`${SRC}/png/maskrom-studio-${s}.png`, pngs[s]);

// .ico with PNG entries (Windows Vista and later read them).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header[e] = s === 256 ? 0 : s; header[e + 1] = s === 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[s].length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += pngs[s].length;
});
writeFileSync(`${SRC}/maskrom-studio.ico`, Buffer.concat([header, ...icoSizes.map((s) => pngs[s])]));

// .icns with PNG entries: ic07 128, ic08 256, ic09 512, ic10 1024.
const parts = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([t, s]) => {
  const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(pngs[s].length + 8, 4);
  return Buffer.concat([h, pngs[s]]);
});
const body = Buffer.concat(parts);
const top = Buffer.alloc(8); top.write('icns', 0, 'ascii'); top.writeUInt32BE(body.length + 8, 4);
writeFileSync(`${SRC}/maskrom-studio.icns`, Buffer.concat([top, body]));
console.log('icons written to', SRC);
