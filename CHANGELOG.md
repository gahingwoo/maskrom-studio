# Changelog

## Unreleased

Renamed to Maskrom Studio ("Install and restore systems and UEFI firmware
on Rockchip boards"); the repository is gahingwoo/maskrom-studio and the
app id com.gahingwoo.MaskromStudio. Settings are carried over from the old
data folder on the first start (README, "Coming from WoA RK3576 Imager").

- Windows image vetting: architecture and build from the image, what was
  found shown, and where to get 23H2 ARM64.
- Armbian or a factory update.img onto the whole eMMC.
- Firmware upgrade that keeps Windows and the UEFI settings.
- About Maskrom Studio.

## Before the rename

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
- Windows comes out configured: the drivers' test certificates trusted,
  extra driver folders, OpenSSH server (on by default), and a choice
  between Windows' own setup and none at all (a local administrator from
  the name and password given, straight to the desktop).
- English and Simplified Chinese, following the system language.
- Windows onto an SD card or an NVMe drive attached to the PC as well as
  the eMMC, staged for the board to install; and on a Windows PC, built
  finished with DISM (for the eMMC into a virtual disk written over
  Maskrom).
- Not yet run on hardware.
