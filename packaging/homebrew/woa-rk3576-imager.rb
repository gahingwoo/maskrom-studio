# Homebrew cask for WoA RK3576 Imager. Not published yet: it goes into a tap
# (which one is still open). The version and both checksums come from the
# release's SHA256SUMS; update them with each release.
cask "woa-rk3576-imager" do
  arch arm: "arm64", intel: "x86_64"

  version "0.1.0"
  sha256 arm:   "REPLACE_WITH_SHA256_OF_ARM64_DMG",
         intel: "REPLACE_WITH_SHA256_OF_X86_64_DMG"

  url "https://github.com/gahingwoo/woa-rk3576-imager/releases/download/v#{version}/woa-rk3576-imager-#{version}-macos-#{arch}.dmg"
  name "WoA RK3576 Imager"
  desc "Install Windows on RK3576 boards over USB and write their UEFI firmware"
  homepage "https://github.com/gahingwoo/woa-rk3576-imager"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "WoA RK3576 Imager.app"

  # Not notarized yet: remove the quarantine flag so Gatekeeper does not
  # block the first launch (what install.sh does too).
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/WoA RK3576 Imager.app"]
  end

  zap trash: [
    "~/Library/Application Support/WoA RK3576 Imager",
    "~/Library/Preferences/io.github.gahingwoo.woa-rk3576-imager.plist",
  ]
end
