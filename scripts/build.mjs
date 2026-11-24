// Build everything into build/: main, preload and helper (Node, CommonJS),
// the page and the Maskrom worker (browser, ES modules), and the WASM
// rkdeveloptool from vendor/rkdeveloptool-wasm/ (scripts/build-wasm.sh).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// For the About dialog: the commit this is built from (CI's, else git's), the
// build date (UTC), and the PatternFly that is bundled.
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = (process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD')).slice(0, 7) || 'unknown';
const built = new Date().toISOString().slice(0, 10);
const patternfly = JSON.parse(readFileSync('node_modules/@patternfly/patternfly/package.json', 'utf8')).version;

const prod = process.env.NODE_ENV === 'production';
rmSync('build', { recursive: true, force: true });

// Native modules and those that load them stay in node_modules.
const external = ['electron', 'drivelist', 'etcher-sdk', '@balena/sudo-prompt'];

const node = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external, sourcemap: !prod, logLevel: 'warning',
  define: { __BUILD_COMMIT__: JSON.stringify(commit) } };
await build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'build/main/main.js' });
await build({ ...node, entryPoints: ['src/preload/preload.ts'], outfile: 'build/preload/preload.js' });
await build({ ...node, entryPoints: ['src/helper/write-helper.ts'], outfile: 'build/helper/write-helper.js' });

const web = { bundle: true, platform: 'browser', target: 'chrome130', format: 'esm', minify: prod, sourcemap: !prod, logLevel: 'warning' };
await build({
  ...web, entryPoints: { app: 'src/renderer/main.tsx' }, outdir: 'build/renderer',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' },
  assetNames: 'assets/[name]-[hash]', jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
    __BUILD_COMMIT__: JSON.stringify(commit), __BUILD_DATE__: JSON.stringify(built), __PATTERNFLY_VERSION__: JSON.stringify(patternfly),
  },
});
await build({ ...web, entryPoints: { 'maskrom-worker': 'src/maskrom/worker.ts' }, outdir: 'build/renderer' });
await build({ ...web, entryPoints: { 'woa-worker': 'src/woa/woa-worker.ts' }, outdir: 'build/renderer' });
cpSync('src/renderer/index.html', 'build/renderer/index.html');
cpSync('src/renderer/theme.js', 'build/renderer/theme.js');

if (!existsSync('vendor/rkdeveloptool-wasm/rkdeveloptool.wasm')) {
  console.error('vendor/rkdeveloptool-wasm/ is missing: run scripts/build-wasm.sh (MaskROM will not work without it)');
  process.exitCode = 1;
} else {
  mkdirSync('build/renderer/wasm', { recursive: true });
  cpSync('vendor/rkdeveloptool-wasm/rkdeveloptool.js', 'build/renderer/wasm/rkdeveloptool.js');
  cpSync('vendor/rkdeveloptool-wasm/rkdeveloptool.wasm', 'build/renderer/wasm/rkdeveloptool.wasm');
}
console.log('built into build/');
