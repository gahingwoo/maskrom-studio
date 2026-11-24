// The Homebrew casks of gahingwoo/homebrew-tap, one per tier:
//   maskrom-studio           the newest stable release (a vX.Y.Z tag)
//   maskrom-studio@beta      a pre-release (a vX.Y.Z-suffix tag)
//   maskrom-studio@nightly   the rolling "ci" release: a stable URL to the
//                            version-less DMGs, version :latest, no checksum
// For a tag, the SHA-256 of both DMGs come from GitHub's asset digests (or
// from downloading them when a digest is missing).
//   node scripts/bump-cask.mjs <tag|ci> [OUT_DIR]   (default: print to stdout)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'gahingwoo/maskrom-studio';
const ARCHES = { arm: 'arm64', intel: 'x86_64' };

const common = (token, conflicts) => `  name "Maskrom Studio"
  desc "Install and restore systems and UEFI firmware on Rockchip boards"
  homepage "https://github.com/${REPO}"
${token}
  conflicts_with cask: [${conflicts.map((c) => `"${c}"`).join(', ')}]
  depends_on :macos

  app "Maskrom Studio.app"

  # The app isn't notarized yet; without this the first launch is blocked.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Maskrom Studio.app"]
  end

  zap trash: [
    "~/Library/Application Support/Maskrom Studio",
    "~/Library/Preferences/com.gahingwoo.MaskromStudio.plist",
    "~/Library/Saved Application State/com.gahingwoo.MaskromStudio.savedState",
  ]
end
`;

export function nightlyCask() {
  return `cask "maskrom-studio@nightly" do
  arch arm: "arm64", intel: "x86_64"

  version :latest
  sha256 :no_check

  # The rolling "ci" release: the latest successful build of main, untested.
  url "https://github.com/${REPO}/releases/download/ci/maskrom-studio-macos-#{arch}.dmg"
${common(`
  livecheck do
    skip "Rolling build of main, replaced on every successful build"
  end
`, ['maskrom-studio', 'maskrom-studio@beta'])}`;
}

export function taggedCask(tag, sha) {
  const version = tag.replace(/^v/, '');
  const beta = version.includes('-');
  const name = beta ? 'maskrom-studio@beta' : 'maskrom-studio';
  const others = ['maskrom-studio', 'maskrom-studio@beta', 'maskrom-studio@nightly'].filter((c) => c !== name);
  return { name, text: `cask "${name}" do
  arch arm: "arm64", intel: "x86_64"

  version "${version}"
  sha256 arm:   "${sha.arm}",
         intel: "${sha.intel}"

  url "https://github.com/${REPO}/releases/download/v#{version}/maskrom-studio-#{version}-macos-#{arch}.dmg"
${common(beta ? `
  # Pre-releases (vX.Y.Z-suffix tags); this file is written by scripts/bump-cask.mjs.
  livecheck do
    url :url
    regex(/^v?(\\d+(?:\\.\\d+)+-[\\w.]+)$/i)
    strategy :github_releases
  end
` : `
  livecheck do
    url :url
    strategy :github_latest
  end
`, others)}` };
}

async function sha256Of(tag, arch) {
  const version = tag.replace(/^v/, '');
  const file = `maskrom-studio-${version}-macos-${arch}.dmg`;
  const headers = { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for release ${tag}`);
  const asset = (await r.json()).assets.find((a) => a.name === file);
  if (!asset) throw new Error(`release ${tag} has no ${file}`);
  if (/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')) return asset.digest.slice(7);
  const d = await fetch(asset.browser_download_url);
  if (!d.ok) throw new Error(`downloading ${file} failed: HTTP ${d.status}`);
  return createHash('sha256').update(Buffer.from(await d.arrayBuffer())).digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tag, out] = process.argv.slice(2);
  if (!tag) { console.error('usage: bump-cask.mjs <vX.Y.Z[-suffix]|ci> [OUT_DIR]'); process.exit(2); }
  let name, text;
  if (tag === 'ci') { name = 'maskrom-studio@nightly'; text = nightlyCask(); }
  else ({ name, text } = taggedCask(tag, { arm: await sha256Of(tag, ARCHES.arm), intel: await sha256Of(tag, ARCHES.intel) }));
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.rb`), text); console.log(`${join(out, `${name}.rb`)}`); }
  else process.stdout.write(text);
}
