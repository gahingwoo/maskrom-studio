// Every native binary in an unpacked package (.node addons, .exe, .dll,
// unpacked from app.asar or not) is built for the given CPU.
//   node scripts/check-native-arch.mjs dist/win-arm64-unpacked arm64
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { machines } from './lib/machine.mjs';

const [dir, arch] = process.argv.slice(2);
if (!dir || !arch) { console.error('usage: check-native-arch.mjs DIR ARCH'); process.exit(2); }
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
let bad = 0;
let seen = 0;
for (const f of walk(dir)) {
  if (!/\.(node|exe|dll)$/i.test(f)) continue;
  const m = machines(f);
  if (m.length === 0) continue;
  seen++;
  const ok = m.includes(arch);
  if (!ok || /\.node$/.test(f)) console.log(`${ok ? 'ok  ' : 'BAD '} ${m.join('+').padEnd(6)} ${f}`);
  if (!ok) bad++;
}
console.log(bad ? `FAIL: ${bad} of ${seen} native binaries are not ${arch}` : `all ${seen} native binaries are ${arch}`);
process.exit(bad ? 1 : 0);
