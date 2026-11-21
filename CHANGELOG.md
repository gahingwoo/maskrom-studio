# Changelog

## Unreleased

First version of WoA RK3576 Imager, forked from Roxora Imager 0.1.10 (its
changelog is in the git history before this fork).

- Windows 11 23H2 on the eMMC of the LCKFB TaishanPi 3M and ArmSoM CM5-IO
  over Maskrom, without a USB stick: the app writes woa-rk3576's WinPE and
  the Windows image into the free space of the eMMC, and the board installs
  Windows from there by itself (docs/DESIGN.md).
- The Windows image is a 23H2 ARM64 ISO, install.wim or install.esd, read
  in place; x64 images and builds newer than 25999 are refused.
- edk2-rk3576 firmware from its latest release, "whole image" or "keep the
  partitions", with edk2-webflash's board list and sectors. "Keep the
  partitions" is refused on an eMMC without the edk2-rk3576 layout.
- On an RK3576 board under Linux, the app writes that board's own eMMC or
  SPI NOR, refusing a disk that is mounted, and reads everything back.
- The WinPE image on a USB drive, for the procedure without this app.
- Not yet run on hardware.
