# Board checks still to do

CI (unit tests, MaskROM through the WASM against a pretend board, Electron
end-to-end runs, screenshots) is not a board. This is what still needs real
hardware. When an item passes, move it to "Tested" with the date and what
was seen. Procedure: [hardware-test](hardware-test.md).

## Untested

- **Staged Windows on the eMMC** and the setup options: see
  hardware-test sections 2 and 2b, both boards.
- **Trimming**, recommended set, staged and PC build: listed apps gone,
  OneDrive not started, no Copilot or Widgets, SysMain disabled, WSearch
  delayed, Windows Update and activation working, Store present; a new user
  gets the classic menu; woa-stage.log shows each step. Edge gone, WebView2
  apps (the RK3576 monitor) working, Chrome installed after its signature
  check and the default for a new user. Whether Edge returns after a
  cumulative update.
- **RK3576 tools**: tray monitor and widget at first sign-in, counters task,
  listed in Settings, Apps.
- **Pulling the cable during a write** (loader and wl, both boards): "The
  board was disconnected", the live line green again after re-entering
  MaskROM, Try again finishes; the same for an SD card pulled from the
  reader. Report a problem has nothing personal in it on all three hosts;
  Save full log writes the file.
- **Live MaskROM line**: green within two seconds of entering MaskROM on
  Linux, macOS and Windows; without WinUSB it says the driver is missing,
  then green after Zadig; unplugging resets it; the write right after still
  finds the board.
- **Copy before a write**: Armbian, factory image, firmware and Windows on
  both boards each leave gpt-sectors-0-33.bin, nvdata-sector-43648-384.bin
  (when there were settings) and backup.txt with matching SHA-256; the
  folder is named on the confirmation and result.
- **Staged onto SD or NVMe from macOS**: one password dialog, write and
  read-back through rawdisk `--regions` with a real reader and USB NVMe
  enclosure on Apple silicon and Intel, disk ejected; then WinPE installs
  from it on the CM5-IO (SD, NVMe) and TaishanPi 3M (SD). CI only writes
  RAM disks.
- **Staged onto SD or NVMe from Linux**: the same; only the note that the
  PC build needs Windows.
- **Windows image checks**: x64 and 24H2 ISOs refused; NTriver 23H2 VL Pro
  and UUP dump ISOs accepted; Windows 10 and 21H2 with the notice.
- **Disk layout**: 40 GB Windows, exFAT data partition, 8 GB free on the
  TaishanPi 3M; diskpart's `size=` and `extend size=` do what woa-stage.ini
  asks; the data partition appears.
- **Windows + Armbian on one eMMC**: see
  [hybrid-and-presets](hybrid-and-presets.md#to-check-on-a-board).
- **Self-test**: the message box, the report file, the issue link.
- **Armbian onto the eMMC**: vendor and edge on both boards; first 32 MiB
  equal; the board starts Armbian.
- **Every Armbian image**: GNOME and KDE Plasma on Ubuntu resolute onto the
  eMMC and a 16 GB SD card on both boards; an 8 GB card refused for a
  desktop; the index read on Windows and macOS (only Linux so far).
- **Factory update.img**: never run with a real one.
- **Firmware upgrade keeping Windows**: installed version read, nvdata
  saved, boot entries and settings still there, Windows starts.
- **Armbian or SD firmware onto SD or USB**: write and read-back on all
  three hosts; CM5-IO starts the card only with no eMMC bootloader,
  TaishanPi 3M never by itself.
- **Coming from WoA RK3576 Imager**: settings, theme, language carried
  over; the .deb replaces the old package.
- **Clear cache**: size shown, list of what goes, backups kept unless
  ticked, refused during a write, freed size shown.
- **Windows window**: mouse wheel and touchpad scrolling on x64 and arm64,
  1366x768 at 125%, no stray text selection.
- **Windows arm64 package**: drive list, SD write, MaskROM.
- **Release tiers**: firmware and WinPE on Prerelease and CI; the app
  updating itself from `ci` on each OS.
- **Simple mode**: its three tasks on both boards from a new install; the
  flashing-mode instructions (TaishanPi pads and F4, CM5-IO button);
  switching modes keeps the board; the reset dialog.
- **Targets per board**: only boards.ts targets offered. Windows from SD
  has not run on any board; ROCK 4D NVMe waits for ACPI. The ROCK 4D's
  Chinese MaskROM steps are new text.
- **ROCK 4D SPI NOR firmware**: "UEFI firmware" and "keep the settings"
  over MaskROM (`cs 9`, size check, the 16 MiB copy, read-back), and on
  the board itself with flashcp; only against the pretend board so far
  (scripts/electron-rock4d-e2e.mjs). Steps in hardware-test.md.
- **Mode menu**: masthead menu, the dialog going back to Simple, Settings'
  copy, at 100% and 125%.

## Tested

Nothing yet.
