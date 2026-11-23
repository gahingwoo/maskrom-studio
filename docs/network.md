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
- **dl.armbian.com and the mirror it redirects to, only when Armbian is
  chosen:** the image's .sha and .asc, then the image (checked against
  both).
- **github.com/PowerShell/Win32-OpenSSH, only when the SSH server is chosen
  for Windows:** the pinned OpenSSH-ARM64.zip.
- **GitHub, once a day when update checks are on (Settings):** the releases
  of gahingwoo/maskrom-studio.
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
