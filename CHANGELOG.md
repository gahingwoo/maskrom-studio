# Changelog

## Unreleased

Maskrom Studio ("Install and restore systems and UEFI firmware on
Rockchip boards"): repository gahingwoo/maskrom-studio, app id
com.gahingwoo.MaskromStudio. Settings from an earlier install are carried
over on the first start.

- Windows image vetting: architecture and build from the image, what was
  found shown, and where to get 23H2 ARM64.
- Armbian or a factory update.img onto the whole eMMC.
- Firmware upgrade that keeps Windows and the UEFI settings.
- About Maskrom Studio.
- Windows and Armbian on one eMMC (TaishanPi 3M, Advanced mode): Armbian's
  root partition at the end of the eMMC, its U-Boot in the firmware slot,
  started from the firmware's "Armbian (U-Boot)" boot option.
- Radxa ROCK 4D: Windows on the NVMe drive and Armbian (vendor or edge,
  Armbian's own image) on an SD card in one job, Advanced mode. The board's
  SPL is read over MaskROM first: without the Armbian one-shot (new U-Boot
  SPL, not in a release yet) nothing is written.
- WinPE's install screen names the disk it installs to (eMMC, SD card or
  NVMe drive) and gives the eMMC timing only for the eMMC.
- A self-test on Windows' first desktop, with an optional prefilled GitHub
  issue.
- How to get a Windows 11 23H2 ARM64 image with UUP dump (docs).
- "Sign in automatically" for a Windows install that skips setup: signs in
  on every start, with the password kept as an LSA secret instead of plain
  text in the registry.
- Edge, Chrome and WebView2 render on the GPU at WDDM 2.x: woa-rk3576's
  rk3576-browser-gpu.ps1 adds --disable-direct-composition to their launch
  paths at the first start and keeps it there after browser updates.
- Radxa ROCK 4D: "UEFI firmware, keep the settings" for its SPI NOR flash
  (sectors 0 to 32255; the settings at 0xFC0000 stay). Every ROCK 4D write
  over MaskROM selects the SPI NOR (`cs 9`), refuses any other storage,
  checks the image is the ROCK 4D's, copies the whole flash to the PC first
  and reads back what it wrote.
- NTriver is the recommended place to get Windows for everyone, not only
  in mainland China.
- "Skip setup": language, keyboard and time zone are searchable lists
  with names (Microsoft's language and input profile tables, CLDR's
  Windows zones) instead of typed codes, preselected from this computer.
  The answer file gets the same codes as before.
- The RK3576 Windows driver package is installed automatically: the
  woa-rk3576 release's rk3576-drivers-arm64.zip (GPU, video decoder, NPU,
  audio, storage, network and the rest), checked against the release's
  SHA-256, with each board's own list. "Add a driver folder" is now only
  for extra drivers.
- .txt files open again on installs from the 22621 ARM64 media: its Notepad
  app is x64 only without the x64 framework it needs, so it is
  unprovisioned and notepad.exe opens them. The self-test shows its whole
  report in its message box. The trim lists are checked against a recorded
  inventory of that image: no framework, no app that stays.
- An "RK3576 Tools" folder (Chinese name on a Chinese Windows) on the
  Public Desktop, shortcuts only: self-test, RK3576 Monitor, drivers guide,
  collect diagnostics, fix SSH, browser GPU switch, user guide.
- SSH: port 22 is opened on every firewall profile. It was Private and
  Domain only, so on a first network that came up as Public (a ROCK 4D,
  2026-11-26) SSH was blocked. Installs from before this: "Fix SSH" in the
  desktop folder of a new install, or
  `Set-NetFirewallRule -DisplayName 'OpenSSH Server (sshd)' -Profile Any`.

## First version

Forked from Roxora Imager 0.1.10 (its changelog is in the git history
before this fork).

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
