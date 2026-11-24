# Using Maskrom Studio

Step by step, for each thing the app does. [简体中文](zh-CN/use.md)

Nothing in the app has been run on a board yet (2026-11-24); the steps are
what the app asks for and does. Installing the app itself:
[install](install.md).

## Before you start

- A Windows 11 23H2 ARM64 ISO, for Windows (see
  [Windows images](#windows-images)).
- The board, a USB cable for its MaskROM port, a USB keyboard and a screen.
- The SD card slot and the USB ports of the board empty: the firmware boots
  them before the eMMC.
- On Windows, the WinUSB driver for MaskROM devices, installed once with
  Zadig ([install](install.md#windows)).

How each board goes into MaskROM mode (the app shows the same on its Get
ready step):

- **LCKFB TaishanPi 3M:** no button. Power off, short the two pads marked
  `MSK` under the `RK3576` silkscreen, connect the USB-C port marked
  `OTG+DP` to the PC and power on. A board that already runs edk2-rk3576
  also goes to MaskROM with F4 during the boot countdown.
- **ArmSoM CM5-IO:** hold the MaskROM button while powering on; the USB-C
  port is the MaskROM port.
- **Radxa ROCK 4D:** a USB-A to USB-A cable from the upper USB 3.0 port to
  the PC; hold the MaskROM button while plugging in the power.

## Install Windows on the eMMC

The firmware has to be on the eMMC first, written as the whole image. If it
is not, write "UEFI firmware, whole image" first (see
[UEFI firmware](#uefi-firmware)).

1. **Board:** choose the board.
2. **What to do:** "Install Windows" (Advanced mode: Windows onto the eMMC).
3. **Windows image:** choose the ISO, or drop it on the window. The app
   shows what it read from the image (architecture, build, boot files,
   languages) and lists its editions; choose one (Pro by default).
4. **Windows setup:**
   - First start: "Windows setup (OOBE)", or "Skip setup, create this
     account" with a user name and password (and optionally computer name, language, keyboard,
     time zone).
   - OpenSSH server: on by default; paste a public key to sign in without
     a password.
   - More drivers: a folder with .inf, .cat and .sys files, for example
     [wddm-mali-g52](https://github.com/gahingwoo/wddm-mali-g52) or
     gt9271.
   - Trimming: the recommended set by default (see
     [Trimming Windows](#trimming-windows)).
   - RK3576 tools (monitor widget, NPU tools): installed by default when
     the WinPE release carries them.
5. **Confirm:** check what is erased and written, put the board in MaskROM
   mode as the card says, and click "Connect and write".
6. The app reads the board and shows the eMMC size and the partitions it
   will delete. Click "Erase and write".
7. The board restarts, starts WinPE from the eMMC, installs Windows (20 to
   40 minutes) and restarts into Windows.

If the install fails on the board, WinPE stops and shows its log; the
staging partitions stay, so restarting the board tries again. To give up,
write "UEFI firmware, whole image" again.

After the install:

- the install log is `C:\Windows\Logs\woa-stage.log`;
- with SSH on, `ssh <user>@<board address>` signs in to cmd.exe;
- the desktop shows "Test Mode": the drivers need test signing.

### Where the password goes

With "Skip setup, create this account", the password is written only into the answer file on the
eMMC, encoded the way Windows encodes it (not plain text, but not
encrypted), and the answer file is deleted when Windows setup is done. It
is never logged. With "Sign in by itself on every start", Windows keeps the
password in the registry, as it does for any automatic sign-in.

## Windows images

Windows 11 23H2 (build 22631) is the tested version. The app refuses an
image that is not ARM64, builds newer than 25999 (Windows 11 24H2 and later
need ARMv8.1, and RK3576 is ARMv8.0), and builds older than Windows 10
1809. Windows 11 21H2 and Windows 10 are allowed with a notice that they
were not tested with the current drivers.

Microsoft's own ARM64 ISO page offers only the current release, which is
too new. The app's Windows step lists where a 23H2 ARM64 ISO can be had:
[NTriver](https://ntriver.org/download-windows-11) (works from China; its
23H2 ARM64 ISOs are the volume licence Pro and IoT Enterprise media) and
[UUP dump](https://uupdump.net/known.php?q=22631+arm64), which builds the
ISO on your computer from Microsoft's update servers. You need a valid
licence.

Step by step with UUP dump, on Windows, macOS or Linux:
[Getting a Windows 11 23H2 ARM64 image](windows-image.md).

## Disk layout

By default Windows takes the whole disk. In Advanced mode the Windows setup
step can give Windows a size (32 GB or more) and make the rest a data
partition (NTFS or exFAT) or leave some of it free at the end for Linux.
The layout is shown before anything is written. The CM5-IO's eMMC (about
31 GB) has room for Windows only.

## Windows and Armbian on one eMMC

TaishanPi 3M, Advanced mode, Windows onto the eMMC over MaskROM. On the
Windows setup step tick **Also install Armbian on the eMMC**, choose an
Armbian image (none is chosen for you; the list is Armbian's own for the
board) and Armbian's share of the eMMC (24 GB by default; Windows gets the
rest and at least 32 GB).

- The Armbian image is downloaded from Armbian and checked against its
  SHA-256 and signature. Only its root partition is written, at the end of
  the eMMC, and its U-Boot goes into the firmware's slot at 32 MiB. The
  UEFI firmware and its settings stay.
- Windows is installed as usual and stops where Armbian starts.
- **Windows starts by default.** To start Armbian, choose **"Armbian
  (U-Boot)"** in the firmware's boot manager. That boot runs Armbian's own
  U-Boot, kernel and device tree; the boot after it is Windows again.
  Armbian as the default needs a firmware option that is not released yet.
- Nothing is preset in Armbian: its first start asks for the root
  password, a user and the time zone, as on any Armbian image.
- Do not run `armbian-install` or a bootloader update in Armbian on this
  eMMC: it would write Armbian's bootloader over the UEFI firmware.
- Not on the CM5-IO (its eMMC is too small for both, and its firmware
  does not have the boot option yet) or the ROCK 4D (firmware on SPI NOR).

## Windows' first desktop: the self-test

When the first user signs in, Windows checks itself after a minute and a
half: Device Manager without warnings (the EC20 modem's MI_04 interface is
expected to have no driver), the GPU on its WDDM 2.0 driver at 594 MHz or
more where the driver reports its clock, a working audio output, a network
connection with name resolution, and 64 MiB written to the system disk and
read back. A message box says everything passed, or lists the problems and
offers to open a prefilled GitHub issue in the browser. Nothing is sent
unless you submit that issue yourself; it has no user name, computer name
or serial numbers. The report is also saved on the desktop as
`RK3576-selftest.txt`.

## Trimming Windows

While Windows is installed, the app can turn off what a 4 GB board spends
its first minutes on: apps that run in the background, OneDrive setup,
Copilot, Widgets, suggested apps, Edge's background mode, SysMain; and
bring back the classic right-click menu. The recommended set is on by
default. In Advanced mode each item is a choice, and Edge can be replaced
with Chrome (off by default). Windows Update, activation, the drivers and
WebView2 are not touched.

What each item does and how to undo it on the running Windows:
[design, Trimming Windows](dev/design.md#trimming-windows).

## Other targets: an SD card or an NVMe drive

Windows can also go onto an SD card in the PC's reader, or an NVMe drive in
a USB enclosure, which then goes into the board (where the board has that
slot; see the table in the README). The board installs Windows from it on
its first start. On a Windows PC the app can instead build the finished
Windows with DISM, so the board starts straight into it.

## UEFI firmware

- **Whole image:** for a new board or an eMMC to start again. It replaces
  the partition table, everything installed, and the UEFI settings.
- **Keep the partitions:** writes only the firmware and keeps the
  partitions and the settings.
- **Upgrade, keeping Windows** (TaishanPi 3M, CM5-IO): the app reads the
  installed version over MaskROM and shows it next to the new one, saves
  the board's UEFI settings on the PC, writes the new firmware with the
  settings put back, never touches the partition table, and reads back
  everything it wrote.

Simple mode always writes the Stable release; Advanced mode follows the
release tier chosen in Settings.

## Back to Linux, or the factory system

Both replace everything on the eMMC, Windows and the UEFI firmware
included.

- **Armbian:** any image Armbian publishes for the TaishanPi 3M or the
  CM5-IO (Debian or Ubuntu, vendor or mainline kernel, with or without a
  desktop), downloaded from Armbian and checked against its SHA-256 and
  Armbian's OpenPGP signature. It can also go onto an SD card or a USB
  drive.
- **Factory image:** an `update.img` you downloaded from the board maker.
  The app reads it, refuses one for another chip, and writes it as
  RKDevTool's "Upgrade Firmware" does. Advanced mode only; not yet run on a
  board.

## Running on the board itself

Start Armbian, Fedora or another Linux on the board from an SD card or a USB
drive, install the arm64 AppImage or .deb, and run the app. The first page
says "This computer is the board"; choose "Write this board directly". It asks
for the administrator password and reads back everything it wrote. For
Windows, power off afterwards, remove the SD card or USB drive, and power
on: the board starts WinPE from the eMMC.

The app refuses to write the eMMC when the running system started from it.

## A copy before each write

Before a write that replaces the start of the eMMC, the app saves the
partition table and, when there is one, the firmware's UEFI settings to a
folder under its data folder (`nvdata-backups/<board>-before-write-<time>/`,
with a `backup.txt` of SHA-256 sums). The confirmation and the result name
the folder. Putting a copy back is not in the app yet.

## When something fails

No failure sends you back to the start. The result page offers:

- **Try again:** the same job with every choice kept; the board is looked
  for again, and finished downloads come from the cache.
- **Back to the steps**, with the choices kept.
- **Report a problem:** opens a GitHub issue with the version, the system,
  the step that failed and the last lines of the log, with the home folder,
  user name, addresses and serial numbers removed.
- **Save full log**, to attach to the issue.

If the board left the USB bus, the page says "The board was disconnected"
and shows its MaskROM steps again.
