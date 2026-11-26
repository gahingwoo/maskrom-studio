# Using Maskrom Studio

[简体中文](zh-CN/use.md). Installing the app: [install](install.md).

The app is in English and Simplified Chinese; it follows the system
language until you pick one at the top. **Simple** mode (the default) has
four steps with the recommended choices: board, what to do, get ready,
confirm. **Advanced** mode has every option: firmware variants, disk
layout, SD cards and USB drives, release tiers, the WinPE stick, the
factory image.

## Before you start

- For Windows, a Windows 11 23H2 ARM64 ISO ([Windows images](#windows-images)).
- The board, a USB cable for its MaskROM port, a USB keyboard and a screen.
- The board's SD slot and USB ports empty: the firmware boots them before
  the eMMC.
- On Windows, the WinUSB driver installed once with Zadig
  ([install](install.md#windows)).

MaskROM mode, per board (the Get ready step shows the same):

- **LCKFB TaishanPi 3M:** no button. Power off, short the two `MSK` pads
  under the `RK3576` silkscreen, connect the USB-C port marked `OTG+DP` to
  the PC, power on. With edk2-rk3576 already on it, F4 during the boot
  countdown also works.
- **ArmSoM CM5-IO:** hold the MaskROM button while powering on; the USB-C
  port is the MaskROM port.
- **Radxa ROCK 4D:** a USB-A to USB-A cable from the upper USB 3.0 port to
  the PC; hold the MaskROM button while plugging in the power.

The Get ready page shows a live line that turns green when an RK3576 in
MaskROM mode (2207:350e) is seen. All RK3576 boards share that ID, so check
it is the board you chose. On Windows it says when the WinUSB driver is
missing.

## Install Windows on the eMMC

The eMMC must hold the firmware written as the whole image. If it does not,
write "UEFI firmware, whole image" first ([UEFI firmware](#uefi-firmware)).

1. **Board.**
2. **What to do:** "Install Windows" (Advanced: Windows onto the eMMC).
3. **Windows image:** choose or drop the ISO (or install.wim/install.esd).
   The app shows what it read and lists the editions; Pro is the default.
4. **Windows setup:**
   - First start: "Windows setup (OOBE)", or "Skip setup, create this
     account" with user name and password (optional computer name,
     language, keyboard, time zone). Language, keyboard and time zone are
     lists you search by typing a name or code. The time zone starts as
     this computer's; the language as this computer's region when the
     image has that language (else the image's).
   - Sign in automatically (with "Skip setup" only, off by default): signs
     in on every start, not only the first.
   - OpenSSH server: on by default; paste a public key to sign in without
     a password.
   - More drivers: a folder with .inf, .cat and .sys files, for example
     [wddm-mali-g52](https://github.com/gahingwoo/wddm-mali-g52) or gt9271.
   - Trimming: the recommended set ([Trimming Windows](#trimming-windows)).
   - RK3576 tools (monitor widget, NPU tools): on when the WinPE release
     carries them.
5. **Confirm:** check what is erased, tick the box, put the board in
   MaskROM mode and start.
6. The app reads the board and shows the eMMC size and the partitions it
   deletes. Click "Erase and write".
7. The board restarts into WinPE on the eMMC, installs Windows (20 to 40
   minutes) and restarts into it.

If the install fails on the board, WinPE stops with its log on screen; the
staging partitions stay, so a restart tries again. To give up, write "UEFI
firmware, whole image" again.

After the install: the log is `C:\Windows\Logs\woa-stage.log`; with SSH on,
`ssh <user>@<board address>` opens cmd.exe; the desktop shows "Test Mode"
because the drivers are test-signed. Windows' clock is read as UTC and
synced after every start.

**The password.** With "Skip setup", it is written only into the answer
file, encoded as Windows encodes it (not encrypted), and the answer file is
deleted when setup is done. It is never logged. With "Sign in
automatically", a one-time task after the first sign-in stores it as the
LSA secret Windows reads for automatic sign-in (as Sysinternals Autologon
does), then deletes itself and its copy.

## Windows images

Windows 11 23H2 (build 22631) is the tested version. Refused: images that
are not ARM64, builds above 25999 (24H2 and later need ARMv8.1), builds
before Windows 10 1809, and PC ISOs (bootx64.efi without bootaa64.efi).
Windows 11 21H2 and Windows 10 are allowed with a notice that they were not
tested with the current drivers. An ISO is read in place, never copied.

Microsoft's ARM64 ISO page offers only the current release, which is too
new. The Windows step lists sources for 23H2 ARM64:
[NTriver](https://ntriver.org/download-windows-11) (recommended: direct
downloads that also work from mainland China; volume licence Pro and IoT
Enterprise media) and
[UUP dump](https://uupdump.net/known.php?q=22631+arm64), which builds the
ISO on your computer from Microsoft's update servers
([step by step](windows-image.md)). You need a valid licence.

## Disk layout

By default Windows takes the whole disk. In Advanced mode Windows can get a
size (32 GB or more) and the rest becomes a data partition (NTFS or exFAT)
or stays partly free at the end for Linux. The layout is shown before
anything is written. The CM5-IO's eMMC (about 31 GB) has room for Windows
only.

## Windows and Armbian on one eMMC

TaishanPi 3M, Advanced mode, Windows onto the eMMC over MaskROM. On the
Windows setup step tick **Also install Armbian on the eMMC**, choose an
Armbian image (none is preselected) and Armbian's share (24 GB by default;
Windows gets the rest, at least 32 GB).

- The image is checked against Armbian's SHA-256 and signature. Only its
  root partition is written, at the end of the eMMC; its U-Boot goes into
  the firmware's slot at 32 MiB. The UEFI firmware and its settings stay.
- Windows starts by default. To start Armbian, choose **"Armbian
  (U-Boot)"** in the firmware's boot manager; it runs Armbian's own U-Boot,
  kernel and device tree, and the next boot is Windows again.
- Armbian's first start asks for the root password, a user and the time
  zone, as on any Armbian image. Do not put the same Armbian image on an
  SD card in the board as well: both have the same file system UUID.
- Do not run `armbian-install` or a bootloader update on this eMMC: it
  would overwrite the UEFI firmware.
- Not on the CM5-IO (eMMC too small, no boot option in its firmware yet) or
  the ROCK 4D (firmware on SPI NOR).

## Self-test on Windows' first desktop

A minute and a half after the first sign-in Windows checks: Device Manager
without warnings (the EC20 modem's MI_04 having no driver is expected), the
GPU on WDDM 2.0 at 594 MHz or more where the driver reports its clock, an
audio output, network with name resolution, and 64 MiB written to the
system disk and read back. A message box lists the result and can open a
prefilled GitHub issue (no user name, computer name or serial numbers);
nothing is sent unless you submit it. The report is also saved as
`RK3576-selftest.txt` on the desktop.

## Trimming Windows

The recommended set (on by default; one switch in Simple mode, a list in
Advanced mode) removes background apps, OneDrive setup, Copilot and
Widgets, turns off suggested apps, Edge's background mode and SysMain,
delays the search indexer, sets diagnostic data to Required, brings back
the classic right-click menu, stops Windows Update from installing drivers
and installs Chrome arm64 as the default browser. Edge stays: it is the
browser with hardware video decode. Removing Edge and removing the Store are
choices that are off. Windows Update itself, activation, the
drivers and WebView2 are not touched. Each item and how to undo it:
[design, Trimming Windows](dev/design.md#trimming-windows).

## Edge, Chrome and WebView2 on the GPU

At WDDM 2.x (the GPU driver's default) Edge and Chrome render on the GPU
only when started with `--disable-direct-composition`. Every install adds
woa-rk3576's switch: the flag goes onto their Start menu, desktop and
taskbar shortcuts, the link and PDF handlers and WebView2's arguments;
Edge's startup boost and both browsers' background mode are turned off. A
scheduled task (`\RK3576\Browser GPU`) puts the flag back after browser
updates and removes it when the GPU is not at WDDM 2.x. It also covers a
Chrome you install yourself.

Turn it off on the board: `HKLM\SOFTWARE\RK3576\BrowserGpu`, `Mode` = 0
(DWORD), or from an administrator prompt
`powershell -ExecutionPolicy Bypass -File "%ProgramFiles%\RK3576\browser-gpu\rk3576-browser-gpu.ps1" -Action Disable`
(`-Action Uninstall` removes it). Details:
[woa-rk3576, BROWSER-GPU.md](https://github.com/gahingwoo/woa-rk3576/blob/main/tools/rk3576-tools/BROWSER-GPU.md).

## Other targets: an SD card or an NVMe drive

Windows can go onto an SD card in the PC's reader or an NVMe drive in a USB
enclosure, which then goes into the board (where the board has that slot:
see the README's table). The board installs Windows from it on its first
start. On a Windows PC the app can instead build the finished Windows with
DISM (needs administrator rights). There is no USB-drive target for Windows
itself.

## UEFI firmware

- **Whole image:** for a new board or a fresh eMMC. Replaces the partition
  table, everything installed and the UEFI settings.
- **Keep the partitions:** writes only the firmware; partitions and
  settings stay.
- **Upgrade, keeping Windows** (TaishanPi 3M, CM5-IO): reads the installed
  version over MaskROM and shows it beside the new one, saves the UEFI
  settings on the PC, writes the new firmware with the settings put back,
  never touches the partition table, and reads back everything written.
  "Reset the settings" writes the image as it is.
- **Radxa ROCK 4D** (firmware on the 16 MiB SPI NOR; Advanced mode only):
  "UEFI firmware" rewrites the whole flash and resets the settings. "UEFI
  firmware, keep the settings" writes sectors 0 to 32255 and leaves the
  settings (from 0xFC0000 to the end) alone; it refuses a flash that does
  not already hold edk2-rk3576 firmware. Both select the SPI NOR
  explicitly and stop if the loader reports any other storage (a UFS
  module), copy the whole flash to the PC first, and read back everything
  written. Disks are never touched.

Simple mode always writes the Stable release; Advanced mode follows the
tier in Settings.

## Back to Linux, or the factory system

Both replace everything on the eMMC, Windows and the firmware included.

- **Armbian:** any image Armbian publishes for the TaishanPi 3M or the
  CM5-IO (Debian or Ubuntu, vendor or edge kernel, with or without a
  desktop), checked against its SHA-256 and Armbian's OpenPGP signature.
  It can also go onto an SD card or USB drive. The CM5-IO starts such a
  card only when the eMMC has no bootloader; the TaishanPi 3M never starts
  one by itself.
- **Factory image** (Advanced mode only): an `update.img` from the board
  maker. The app refuses one for another chip and writes it as RKDevTool's
  "Upgrade Firmware" does.

## Running on the board itself

Start Linux on the board from an SD card or USB drive, install the arm64
AppImage or .deb and run the app. The first page says "This computer is the
board"; choose "Write this board directly". It asks for the administrator
password and reads back everything it wrote. For Windows, power off
afterwards, remove the SD card or USB drive and power on: the board starts
WinPE from the eMMC. The app refuses the eMMC when the running system is on
it. The ROCK 4D's SPI NOR needs a kernel that shows it as `/dev/mtd0`;
otherwise the app points to MaskROM.

## A copy before each write

Before a write that replaces the start of the eMMC, the app saves the
partition table and, when present, the firmware's UEFI settings to
`nvdata-backups/<board>-before-write-<time>/` in its data folder, with a
`backup.txt` of SHA-256 sums. The confirmation and result name the folder.
If the copy cannot be saved, nothing is written. Putting a copy back is not
in the app yet.

## When something fails

No failure sends you back to the start. The result page offers **Try
again** (same job and choices; the board is looked for again, finished or
partial downloads come from the cache), **Back to the steps**, **Report a
problem** (a GitHub issue with version, system, failed step and the last
log lines, with home folder, user name, addresses and serial numbers
removed) and **Save full log**. If the board left the USB bus, the page
says "The board was disconnected" and shows its MaskROM steps again.

If no board is found, check that it is really in MaskROM mode (a picture on
its screen means it booted normally), the cable and port, the WinUSB driver
or udev rule, and that only one Rockchip device is connected.
