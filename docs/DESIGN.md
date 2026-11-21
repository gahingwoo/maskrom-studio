# Design: Windows on the eMMC without a USB stick

Status: first version implemented, not yet run on hardware (2026-11-21).

## The goal

Put Windows 11 23H2 on the eMMC of an RK3576 board (LCKFB TaishanPi 3M,
ArmSoM CM5-IO) from a PC over USB, with no USB stick, and with the fewest
things for the user to download or prepare: the app fetches the firmware and
WinPE itself; the user supplies one Windows ISO (or WIM or ESD).

What exists and works today (woa-rk3576 `docs/INSTALL.md`): firmware on the
eMMC, the WinPE image on a USB stick, `install.wim` on an extra exFAT
partition of the stick, then `deploy-windows.cmd` inside WinPE, which applies
the image with DISM, adds the drivers, runs bcdboot and edits the offline
registry.

## The two approaches

### 1. Stage and self-deploy (chosen)

The PC writes, over Maskrom, into the eMMC behind the firmware partition:

- `WOA-STAGE-BOOT`: woa-rk3576's WinPE FAT32 volume, byte for byte as the
  release ships it, except `woa-debug\collect.cmd`, which is replaced by a
  short launcher;
- `WOA-STAGE-DATA`: an exFAT volume with the Windows image (`install.wim` or
  `install.esd`, read straight out of the ISO), `woa-stage.ini` (edition,
  disk GUID, offsets, SHA-256) and `woa-stage.cmd`;
- a new GPT: the firmware entry copied unchanged, then the two staging
  partitions at the end of the disk, and the backup table.

The board then boots WinPE from the eMMC and installs Windows onto the eMMC
itself: `woa-stage.cmd` is `deploy-windows.cmd` with the differences that
come from installing onto the disk the image is on (below), and when Windows
is in place it deletes the staging partitions and extends Windows over them.

### 2. Build on the host

Apply the image to an NTFS volume inside a disk image on the PC (wimlib, or
DISM on Windows), inject drivers and registry changes offline (hivex on
macOS and Linux), make the ESP and BCD, then write the whole result over
Maskrom.

### Comparison

| | 1. Stage | 2. Build on host |
|---|---|---|
| Bytes over Maskrom | WinPE (about 375 MB in use) plus the compressed image (3 to 6 GB) | The applied, uncompressed-on-disk Windows: about 10 to 12 GB of NTFS even with /Compact |
| Time over Maskrom (USB 2.0, not yet measured; 10 to 25 MB/s assumed) | about 5 to 15 minutes | about 10 to 20 minutes, plus building the image on the PC |
| Time on the board | DISM apply on eMMC, 20 to 40 minutes, unattended | none |
| Host OS support | Windows, macOS, Linux alike: everything the PC does is plain byte assembly in TypeScript | Windows: DISM needs admin and a mounted VHD. macOS and Linux: wimlib with NTFS-3G (not on macOS by default), hivex for the hives, and DISM's driver injection reimplemented (DriverStore, the DRIVERS hive, boot-start services) |
| Admin rights on the PC | none (Maskrom over WebUSB; Linux needs the udev rule, Windows the WinUSB driver once) | Windows: yes. Others: no, but native tools to install |
| Proven parts | DISM, bcdboot and the registry edits are deploy-windows.cmd's, which installed Windows on both boards | none of the offline injection has run here |
| Verification | GPT read back over Maskrom; samples of the rest where the loader allows; on the board DISM /Verify checks every file's hash as it applies, and certutil checks the image's SHA-256 where WinPE has it | Everything would have to be read back over Maskrom, which is unreliable past 32 MiB with this loader |
| Failure on the board | WinPE stops with the log on screen; the staging partitions stay and a restart retries | the board does not boot; diagnose blind |

Approach 1 sends less over the slow link, needs no administrator rights or
native tools on any of the three host systems, reuses the deploy logic that
has already installed Windows on both boards, and moves verification to
where it can be done: the device. Approach 2 would have to reimplement what
DISM /Add-Driver does for a boot-critical driver on two host systems, and
its result could not be read back reliably over Maskrom.

## Questions approach 1 had to answer

**How the firmware boots the staged WinPE once.** BootNext cannot be set
over Maskrom. It does not need to be: edk2-rk3576 creates a boot option per
block device ("eMMC User Data"), and booting it loads
`\EFI\Boot\bootaa64.efi` from the first FAT volume on that device that has
it (`BmExpandMediaDevicePath` in MdeModulePkg). The new GPT has exactly one
such volume, `WOA-STAGE-BOOT`, so the next boot from the eMMC is WinPE. The
firmware tries the SD slot and USB first, so those must be empty. After the
install only the new ESP has that file, so the next boot is Windows, as
after deploy-windows.cmd. Nothing in the firmware changes.

**How WinPE starts the install with no one typing.** woa-rk3576's
`startnet.cmd` (baked into boot.wim) calls `woa-debug\collect.cmd` from the
first volume that has it, with that volume's letter. The staged copy has the
launcher in that file (same clusters, FAT chain shortened to fit, FSInfo
free count adjusted; `src/woa/fat32.ts`), so the released WinPE runs it
without being rebuilt. The launcher copies the install script to the RAM
disk X: and runs it there, because both staging volumes are deleted at the
end. WinPE itself runs from RAM (boot.wim is loaded whole), so deleting its
volume is safe.

**How the install finds the right disk.** The new GPT gets a random disk
GUID, written into `woa-stage.ini`. `woa-stage.cmd` asks diskpart for each
disk's `uniqueid` and takes the one disk with that GUID, then checks its
size and the firmware partition (offset 32768, 67076096 bytes) as
deploy-windows.cmd does. An SD card in the slot cannot be mistaken for it.

**Where Windows goes.** ESP at offset 64 MiB (right after the firmware
partition, `create partition efi ... offset=65536`), MSR, then NTFS up to the
staging partitions. After the apply the staging volumes are deleted
(`delete volume override`) and `extend` gives their space to Windows.

**FAT32's 4 GiB file limit.** install.wim is often larger, so it goes on an
exFAT volume (`src/woa/exfat.ts`). WinPE reads exFAT; the firmware does not
need to.

**Verification without the 32 MiB read limit.** Over Maskrom the app reads
back the partition table (sector 0 to 33, inside the trusted 32 MiB), and
three 64 KiB samples of each region; samples past 32 MiB that do not match
are counted and reported (as 0xCC filler or otherwise), not taken as a
failed write. This also measures whether the limit is per address or per
command, which is not known. On the board, DISM `/Apply-Image /Verify`
checks every file against the hashes the WIM stores, and when WinPE has
certutil the image's SHA-256 is compared with the one the app computed.
Where the app runs on the board itself (below), everything is read back
from the eMMC after the kernel's cache is dropped.

**Throughput.** Not measured. rkdeveloptool through WebUSB in a worker, 1 MiB
transfers; the first test on hardware should time the write (the app shows
bytes and the rkdeveloptool log).

**Robustness.** The primary GPT is written last, so a write cut short leaves
the old table and the board boots as before. A power cut during the install
on the board: the staging partitions are still there and the next boot runs
the install again, which first deletes partitions it does not know
(anything but the firmware and the two staging ones).

## Running on the board itself

When the app runs on an RK3576 board under Linux (Armbian, Fedora, anything
booted from an SD card or USB drive), it offers to write that board
directly: the firmware (eMMC whole image, eMMC keep the partitions, or the
ROCK 4D's SPI NOR) and Windows.

- Detection: `/proc/device-tree/compatible` (board compatibles and
  `rockchip,rk3576`), or the SMBIOS product name edk2-rk3576 reports when
  Linux booted through UEFI with ACPI (`/sys/class/dmi/id/product_name`).
- eMMC: the `mmcblkN` whose `device/type` is `MMC`. Refused while anything
  on it is mounted (including root and /boot) or used by LVM, RAID or ZFS
  (lsblk, as Roxora Imager's internal-disk rules), checked again by the
  elevated helper just before writing. The confirmation names the model,
  device and size.
- SPI NOR: an MTD device of type `nor`, written with mtd-utils' `flashcp
  -v` (erase, write, verify). The mainline ROCK 4D device tree enables
  `sfc0` with a `jedec,spi-nor` flash, so a kernel with
  `CONFIG_SPI_ROCKCHIP_SFC` and `CONFIG_MTD_SPI_NOR` shows `/dev/mtd0`.
  Whether Armbian's ROCK 4D kernels (vendor and edge) enable both was not
  checked here. When there is no MTD device the app says what is missing
  and points to Maskrom. The TaishanPi 3M and CM5-IO keep their firmware
  on the eMMC.
- Windows: the same staged layout, written with plain file I/O through the
  elevated helper (pkexec), then read back in full. The user shuts down,
  removes the SD card or USB drive Linux ran from, and powers on.

Why not wimlib on the board instead of staging WinPE: wimlib can apply the
image to NTFS, but the drivers are the hard part. The boot disk sits behind
a test-signed boot-start driver (dwcsdhc), and `dism /Add-Driver` installs a
driver into the DriverStore and the DRIVERS and SYSTEM hives in ways no
Linux tool reproduces; deploy-windows.cmd also depends on DISM making it
boot-start. Staging keeps one install path for both modes, at the cost of
one reboot.

## What is reused, and from where

- **edk2-webflash** (flash.gahingwoo.com), the flasher proven on these
  boards: its board list (`src/boards.js`: firmware choices, sectors,
  slices, wording, Maskrom steps) and its `prepare()` (`src/flash.js`) are
  copied unchanged into `src/web/webflash/`, so "whole image" and "keep the
  partitions" write exactly what the web flasher writes. Its command
  sequence (db, wl, rd, no cs) is the one `src/woa/maskrom-regions.ts`
  follows. Its `runFlash()` is not used: it asks the user to pick the device
  twice, which Electron does not need.
- **Roxora Imager**: the Electron shell, the rkdeveloptool WASM build and
  its byte-source devices (`src/maskrom/`), the loader built from rkbin
  against a pin (same SHA-256 as edk2-webflash's `rk3576_spl_loader.bin`),
  release downloads checked by SHA-256, the elevated helper, the Linux disk
  safety rules, updates, the pretend Rockusb board for tests.
- **woa-rk3576**: the WinPE release image, its startnet.cmd hook, and
  deploy-windows.cmd's steps.
- Base for the Maskrom sequence: Roxora Imager's runner and parsing, with
  edk2-webflash's commands. Roxora Imager's own `sequence.ts` adds `cs`,
  which has not run on these boards; the WoA path leaves it out as the web
  flasher does, and identifies the storage by its size from `rfi` instead.

Written here, because nothing existing does it from TypeScript on three
host systems without native tools: a GPT writer, a FAT32 single-file patch,
an exFAT writer (checked with exfatprogs' fsck in the tests), a UDF reader
for the ISO, and the WIM header and XML reader.

## Not in the first version

- The ROCK 4D (no eMMC; Windows would go on NVMe). The layout code takes a
  board and a disk; an NVMe target needs a deploy script that installs
  onto a disk other than the staging one, which makes it simpler, not
  harder.
- A USB stick that already holds the Windows image (the fallback stick is
  WinPE only, as today; the exFAT writer could add the image partition).
- Downloading Windows from Microsoft (UUP). Legal and automatable in
  principle (uupdump does it), but it means converting ESDs, and is left
  out.
- The web build. flash.gahingwoo.com remains the browser flasher.
