# Not yet tested on a board

What CI checks (unit tests, the MaskROM paths through the WASM against a
pretend board, Electron end-to-end runs, screenshots) is not a board. This
list is what still needs the real hardware, for the combined test. Strike
an entry by moving it to "Tested" with the date and what was seen.

## Untested

- **Trimming Windows** (trim-windows): a staged install and a PC build
  with the recommended set on both boards: the listed apps gone, OneDrive
  not started, no Copilot or Widgets, SysMain disabled, WSearch delayed,
  Windows Update and activation still working, the Store and Edge still
  there; a new user gets the classic right-click menu; woa-stage.log
  shows each step. Then Edge removed with Chrome:
  Edge gone, WebView2 apps (the RK3576 monitor) still working, Chrome
  installed after its signature check and the default browser of a new
  user. Whether Edge comes back after a cumulative update.
- **RK3576 tools in the install** (trim-windows): once woa-rk3576 releases
  the bundle, the tray monitor and widget appear on the first sign-in, the
  counters task exists, Settings, Apps lists RK3576 tools.
- **Pulling the cable during a write** (retry-report): on both boards,
  during the loader and during wl: "The board was disconnected" with the
  MaskROM steps, the live line green again after re-entering MaskROM, Try
  again finishing the write; the same with an SD card pulled from the
  reader (the drive message). Report a problem opens a prefilled GitHub
  issue with nothing personal in it on Windows, macOS and Linux; Save full
  log writes the file.
- **Live MaskROM line** (ux-decisions D2): on the Get ready page and the
  MaskROM card, the line turns green within two seconds of the board
  entering MaskROM (TaishanPi 3M pads, CM5-IO button) on Linux, macOS and
  Windows; on a Windows PC without WinUSB it says the driver is missing
  and turns green after Zadig; unplugging turns it back. The write right
  after it still finds the board (the Windows check opens and closes the
  device once).
- **The copy before a write** (ux-decisions D6): Armbian, a factory image,
  the firmware and a Windows install on both boards each leave a folder in
  nvdata-backups with gpt-sectors-0-33.bin, nvdata-sector-43648-384.bin
  (when the board had settings) and backup.txt; the SHA-256 in it match the
  files; the folder is named on the confirmation card and the result.
- **Staged Windows onto an SD card or NVMe drive from macOS**
  (stage-everywhere): the password dialog once, the write and read-back
  through rawdisk `--regions` with a real card reader and a USB NVMe
  enclosure on Apple silicon and Intel; the disk ejected afterwards; then
  WinPE starts from it on the CM5-IO (SD, NVMe) and the TaishanPi 3M (SD,
  with its eMMC firmware), installs Windows with the drivers and the board
  starts it. CI only writes RAM disks with made-up regions.
- **Staged onto an SD card or NVMe drive from Linux** (stage-everywhere):
  the same, now the default method there; the page shows no greyed-out
  "built on this PC" choice, only the note that it needs Windows.
- **Windows image checks** (win-image-vetting): an x64 ISO refused, a 24H2
  ISO refused, a 23H2 VL Pro ISO from NTriver and a UUP dump ISO accepted;
  Windows 10 and 21H2 images shown with the purple notice.
- **Disk layout** (windows-partitioning): a 40 GB Windows with an exFAT
  data partition and 8 GB kept for Linux on the TaishanPi 3M; diskpart's
  `create partition primary size=` and `extend size=` in WinPE do what
  woa-stage.ini asks; Windows starts; the data partition appears.
- **Armbian onto the eMMC** (restore-linux-factory): vendor and edge on
  both boards; the first 32 MiB read back equal; the board starts Armbian.
- **Every Armbian image** (armbian-images): a desktop image (GNOME, then
  KDE Plasma, Ubuntu resolute) onto the eMMC and onto a 16 GB SD card on
  both boards, its signature checked, the desktop reached; an 8 GB card
  refused for a desktop image; the list read live from Armbian's index on
  Linux, Windows and macOS (only checked from Linux so far).
- **Factory update.img** (restore-linux-factory): never run with a real
  update.img. `gpt parameter.txt`, `ul` with its loader, then `wl` per
  partition; the board starts the factory system.
- **Firmware upgrade keeping Windows and settings** (uefi-upgrade): the
  installed version read over MaskROM, the nvdata copy saved, the boot
  entries and settings still there after the upgrade, Windows starts.
- **Armbian or the SD card firmware onto an SD card or USB drive**
  (restore-target-choice): the write and read-back on Linux, Windows and
  macOS hosts; what the boards then do with the card (CM5-IO: only with
  no bootloader on the eMMC; TaishanPi 3M: never by itself).
- **Coming from an earlier version** (rename-maskrom-studio): an earlier
  install updated by hand; settings, theme and language carried over; the
  .deb replaces the earlier package.
- **Clear cache** (clear-cache): Settings shows the size, the dialog lists
  what goes, the UEFI settings backups stay unless ticked, refused while
  a write runs, the freed size shown.
- **Windows window** (ui-scroll-select): scrolling with a mouse wheel and a
  touchpad on Windows x64 and arm64, a 1366x768 screen at 125%; no stray
  text selection.
- **Windows arm64 package** (win-arm64-natives): drive list, SD card write
  and MaskROM on Windows on Arm.

- **Release tiers** (release-tiers): Settings, firmware and WinPE on
  Prerelease (0.3.0-tspi3m.1 era releases) and CI once edk2-rk3576 has a
  `ci` release; the app updating itself from the `ci` release on each OS.

- **Simple mode** (simple-mode): each of its three tasks (the factory
  restore is in Advanced mode only until it is verified) on both boards
  from a new install; the flashing-mode instructions as written (TaishanPi
  3M pads and F4, CM5-IO button); switching modes keeps the board; the
  dialog when Advanced choices are reset.

- **Windows targets per board** (board-targets): only the targets in
  boards.ts are offered (TaishanPi 3M: eMMC, SD card; CM5-IO: eMMC, SD
  card, NVMe; ROCK 4D: NVMe, SD card). Windows from an SD card has not run
  on any board; NVMe on the ROCK 4D waits for its ACPI tables. The ROCK
  4D's MaskROM steps in Chinese (USB-A to USB-A cable) are new text.
- **Mode menu** (board-targets): the masthead menu, the dialog when going
  back to Simple, and Settings' copy, on a real screen at 100% and 125%.

## Tested
