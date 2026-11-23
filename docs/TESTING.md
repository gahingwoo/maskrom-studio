# Not yet tested on a board

What CI checks (unit tests, the Maskrom paths through the WASM against a
pretend board, Electron end-to-end runs, screenshots) is not a board. This
list is what still needs the real hardware, for the combined test. Strike
an entry by moving it to "Tested" with the date and what was seen.

## Untested

- **Windows image checks** (win-image-vetting): an x64 ISO refused, a 24H2
  ISO refused, a 23H2 VL Pro ISO from NTriver and a UUP dump ISO accepted;
  Windows 10 and 21H2 images shown with the purple notice.
- **Disk layout** (windows-partitioning): a 40 GB Windows with an exFAT
  data partition and 8 GB kept for Linux on the TaishanPi 3M; diskpart's
  `create partition primary size=` and `extend size=` in WinPE do what
  woa-stage.ini asks; Windows starts; the data partition appears.
- **Armbian onto the eMMC** (restore-linux-factory): vendor and edge on
  both boards; the first 32 MiB read back equal; the board starts Armbian.
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

## Tested
