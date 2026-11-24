# What Maskrom Studio contacts, and what it keeps

The About dialog sums this up in one line each; this is the detail.

## Network

- **GitHub API and release downloads, at start:** the latest releases of
  gahingwoo/edk2-rk3576 (UEFI firmware) and gahingwoo/woa-rk3576 (WinPE).
  Their files are downloaded only when a write needs them, and checked
  against the SHA-256 the release lists.
- **raw.githubusercontent.com, the first time MaskROM is used:** the pieces
  of the MaskROM loader from rockchip-linux/rkbin at a pinned commit,
  checked against pinned SHA-256 values, then kept.
- **github.armbian.com, only when Armbian is chosen:** Armbian's image
  index (armbian-images.json, about 5 MB), for the list of images.
- **dl.armbian.com and the mirror it redirects to, only when Armbian is
  chosen:** the chosen image's .sha and .asc, the last 64 KiB of the image
  (its decompressed size), then the image (checked against both).
- **github.com/PowerShell/Win32-OpenSSH, only when the SSH server is chosen
  for Windows:** the pinned OpenSSH-ARM64.zip.
- **GitHub, once a day when update checks are on (Settings):** the releases
  of gahingwoo/maskrom-studio.

## Tiers: Stable, Prerelease, CI

Settings has two choices, kept in settings.json, Stable by default: one
for Maskrom Studio's own updates, one for the firmware (edk2-rk3576) and
the WinPE (woa-rk3576) the writes use. The app lists a repository's
releases (`/releases?per_page=50`) and picks (src/shared/channel.ts):

- **Stable:** the newest version that is not a pre-release.
- **Prerelease:** the newest version, pre-releases included.
- **CI:** the release tagged `ci`. Each repository's CI replaces it on
  every successful build of main: a pre-release named
  `CI build <sha> <date>` whose notes give the commit and say it is
  untested. It never counts for the other two tiers. No GitHub Actions
  artifact is downloaded (those need a login). A repository without a
  `ci` release yet falls back to its Prerelease tier, and the page says so.

Drafts never count, and newest is by version, not by date. The page shows
the tier, the release and, for CI, the commit, with a warning for
Prerelease and an "untested build" notice for CI. For the app, CI offers
the `ci` release when it was built from another commit than the running
copy.
- The places to get Windows and the board makers' pages are links: they
  open in the browser, the app does not fetch them.
- No analytics, no telemetry.

## Kept on your device

All in the app's data folder (Linux `~/.config/Maskrom Studio`, Windows
`%APPDATA%\Maskrom Studio`, macOS `~/Library/Application Support/Maskrom Studio`):

- `settings.json`; the theme and language in the app's own storage beside it.
- `nvdata-backups/`: a copy of a board's UEFI settings, saved before each
  firmware upgrade that keeps them.
- `images/`: downloaded firmware, WinPE and Armbian images.
- `loaders/`: the MaskROM loader built from rkbin.

Settings, Clear cache, deletes `images/` and `loaders/` after showing what
they hold; `nvdata-backups/` only when its own box is ticked. It is
refused while a write runs or a file is prepared for one.
