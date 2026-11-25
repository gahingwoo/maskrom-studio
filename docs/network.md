# What Maskrom Studio contacts, and what it keeps

The About dialog has one line for each; this is the detail. No analytics,
no telemetry. Links to Windows sources and board makers' pages open in the
browser; the app does not fetch them.

## Network

| Host | When | What |
|---|---|---|
| GitHub API and release downloads | at start | the releases of gahingwoo/edk2-rk3576 (firmware) and gahingwoo/woa-rk3576 (WinPE, RK3576 tools); files are downloaded only when a write needs them, checked against the release's SHA-256 |
| raw.githubusercontent.com | first MaskROM use | the loader pieces from rockchip-linux/rkbin at a pinned commit, checked against pinned SHA-256 values, then kept |
| github.armbian.com | Armbian chosen | Armbian's image index (armbian-images.json, about 5 MB) |
| dl.armbian.com and its mirror | Armbian chosen | the image's .sha and .asc, its last 64 KiB (decompressed size), then the image, checked against both |
| github.com/PowerShell/Win32-OpenSSH | SSH server chosen | the pinned OpenSSH-ARM64.zip |
| dl.google.com | Chrome chosen (in the recommended trimming) | Google's arm64 enterprise MSI |
| GitHub | once a day, if update checks are on | the releases of gahingwoo/maskrom-studio |

## Tiers: Stable, Prerelease, CI

Settings has two tier choices, kept in settings.json, Stable by default:
one for the app's own updates, one for the firmware and WinPE the writes
use. The app lists a repository's releases (`/releases?per_page=50`) and
picks (src/shared/channel.ts):

- **Stable:** the newest version that is not a pre-release.
- **Prerelease:** the newest version, pre-releases included.
- **CI:** the release tagged `ci`, which each repository's CI replaces on
  every green build of main (a pre-release named `CI build <sha> <date>`,
  notes saying it is untested). It never counts for the other tiers. No
  GitHub Actions artifact is downloaded (those need a login). A repository
  without a `ci` release falls back to Prerelease, and the page says so.

Drafts never count; newest is by version, not date. The page shows the
tier, the release and, for CI, the commit, with a warning for Prerelease
and an "untested build" notice for CI. For the app, CI is offered when it
was built from another commit than the running copy.

## Kept on your device

In the app's data folder (Linux `~/.config/Maskrom Studio`, Windows
`%APPDATA%\Maskrom Studio`, macOS `~/Library/Application Support/Maskrom Studio`):

- `settings.json`; the theme and language in the app's storage beside it.
- `nvdata-backups/`: UEFI settings saved before a firmware upgrade, and the
  partition table and settings copied before other eMMC writes.
- `images/`: downloaded firmware, WinPE and Armbian images (partial
  downloads as `.part`, resumed later).
- `loaders/`: the MaskROM loader built from rkbin.

Settings, Clear cache, deletes `images/` and `loaders/` after showing what
they hold, and `nvdata-backups/` only when its own box is ticked. It is
refused while a write runs or a file is being prepared for one.
