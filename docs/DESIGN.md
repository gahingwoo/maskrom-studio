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

The PC writes, over MaskROM, into the eMMC behind the firmware partition:

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
MaskROM.

### Comparison

| | 1. Stage | 2. Build on host |
|---|---|---|
| Bytes over MaskROM | WinPE (about 375 MB in use) plus the compressed image (3 to 6 GB) | The applied, uncompressed-on-disk Windows: about 10 to 12 GB of NTFS even with /Compact |
| Time over MaskROM (USB 2.0, not yet measured; 10 to 25 MB/s assumed) | about 5 to 15 minutes | about 10 to 20 minutes, plus building the image on the PC |
| Time on the board | DISM apply on eMMC, 20 to 40 minutes, unattended | none |
| Host OS support | Windows, macOS, Linux alike: everything the PC does is plain byte assembly in TypeScript | Windows: DISM needs admin and a mounted VHD. macOS and Linux: wimlib with NTFS-3G (not on macOS by default), hivex for the hives, and DISM's driver injection reimplemented (DriverStore, the DRIVERS hive, boot-start services) |
| Admin rights on the PC | none (MaskROM over WebUSB; Linux needs the udev rule, Windows the WinUSB driver once) | Windows: yes. Others: no, but native tools to install |
| Proven parts | DISM, bcdboot and the registry edits are deploy-windows.cmd's, which installed Windows on both boards | none of the offline injection has run here |
| Verification | GPT read back over MaskROM; samples of the rest where the loader allows; on the board DISM /Verify checks every file's hash as it applies, and certutil checks the image's SHA-256 where WinPE has it | Everything would have to be read back over MaskROM, which is unreliable past 32 MiB with this loader |
| Failure on the board | WinPE stops with the log on screen; the staging partitions stay and a restart retries | the board does not boot; diagnose blind |

Approach 1 sends less over the slow link, needs no administrator rights or
native tools on any of the three host systems, reuses the deploy logic that
has already installed Windows on both boards, and moves verification to
where it can be done: the device. Approach 2 would have to reimplement what
DISM /Add-Driver does for a boot-critical driver on two host systems, and
its result could not be read back reliably over MaskROM.

## Questions approach 1 had to answer

**How the firmware boots the staged WinPE once.** BootNext cannot be set
over MaskROM. It does not need to be: edk2-rk3576 creates a boot option per
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

**Verification without the 32 MiB read limit.** Over MaskROM the app reads
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
  and points to MaskROM. The TaishanPi 3M and CM5-IO keep their firmware
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
  slices, wording, MaskROM steps) and its `prepare()` (`src/flash.js`) are
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
- Base for the MaskROM sequence: Roxora Imager's runner and parsing, with
  edk2-webflash's commands. Roxora Imager's own `sequence.ts` adds `cs`,
  which has not run on these boards; the WoA path leaves it out as the web
  flasher does, and identifies the storage by its size from `rfi` instead.

Written here, because nothing existing does it from TypeScript on three
host systems without native tools: a GPT writer, a FAT32 single-file patch,
an exFAT writer (checked with exfatprogs' fsck in the tests), a UDF reader
for the ISO, and the WIM header and XML reader.

## Both paths, three targets

The user asked for both paths, so the first approach is the default and the
second is offered where it can be done properly.

| Target | Layout | Staged (default) | Built on the PC |
|---|---|---|---|
| eMMC, over MaskROM | firmware partition kept, Windows from 64 MiB | any host | Windows host: DISM into a VHD, then MaskROM |
| eMMC, on the board | as above | Linux on the board | no |
| SD card in the PC's reader | fresh GPT, Windows from 1 MiB | any host | Windows host: DISM onto the card |
| NVMe in a USB enclosure | fresh GPT, Windows from 1 MiB | any host | Windows host: DISM onto the drive |

Which of these a board offers is `windowsTargets` in src/woa/boards.ts, the
one place the page and the checks in stage-layout.ts and main.ts read it
from: the TaishanPi 3M takes the eMMC and an SD card (its mini-PCIe slot is
no M.2 slot, so no NVMe), the CM5-IO the eMMC, an SD card and NVMe, the
ROCK 4D (no eMMC, firmware on SPI NOR) NVMe and an SD card. Every sentence
on the page that names targets is made from that list.

**Staged onto an SD card or NVMe drive.** The same layout as on the eMMC
without the firmware partition, written to the drive on the PC through the
elevated writer (etcher-sdk's block device, then read back in full). The
card or drive goes into the board, the firmware boots its WinPE (SD and
USB come before the eMMC; NVMe may need the boot manager), and WinPE
installs onto that same disk, found by its GUID, as on the eMMC. For an SD
target the SD controller driver (dwcmshc) is made boot-start as well as
sdstor. On macOS the main process plans the same regions
(`planDiskStage` in src/helper/board-write.ts, plain TypeScript, no
mkfs or diskutil formatting) and writes them through
maskrom-studio-rawdisk `--regions` (src/helper/macos/rawdisk.c,
src/main/mac-write.ts `macWriteRegions`): the helper gets the disk from
authopen after the password dialog as for an SD card image, reads a
16-byte header (offset, length) before each region and a zero-length end,
writes each region at its place, then sends every region back for the
comparison. Afterwards the disk is ejected, so macOS does not keep the new
FAT and exFAT volumes mounted.

There is no USB-drive target for Windows: the boards start WinPE from a
USB stick (the fallback stick, any host), but Windows itself is installed
to the eMMC, an SD card or an NVMe drive only.

**Drivers in a staged install.** Everything the PC build does to the
applied Windows is the shared `CONFIGURE` block (stage-scripts.ts), which
the board's WinPE runs too: `dism /Add-Driver` of the RK3576 drivers from
the WinPE release (boot disk, GPU, NPU, audio and the rest of
woa-drivers) and of the user's extra driver folder, bcdboot, test signing
in the BCD, the boot-start services (sdstor, dwcmshc for an SD target),
the registry settings, the drivers' test certificates in Root and
TrustedPublisher, the answer file and OpenSSH. A test checks that both
scripts contain it. The one difference left: the PC build applies an
NVMe target without /Compact, the board always with it.

**Built on a Windows PC.** `host-build.cmd` (stage-scripts.ts) is the
install script's own configure block, run by the PC's DISM, the way Windows
on Raspberry's tools service ARM64 images from x64 Windows: diskpart
(the chosen disk, or an expandable VHD the size of the board's eMMC with
the first 64 MiB left free), `dism /Apply-Image`, `/Add-Driver`, bcdboot,
test signing, the registry changes, certificates, answer file and OpenSSH.
The ISO is mounted with Mount-DiskImage. For the eMMC, src/woa/vhd.ts
reads the VHD and src/woa/host-image.ts sends only its blocks that hold
data, with a new partition table that keeps the firmware entry. The script
runs elevated (UAC); its console goes to a file the app follows.

**Why the PC build is Windows only.** What has to come out of it is a
Windows that can open its boot disk on the first start, and the boot disk
(eMMC or SD) sits behind a third-party test-signed driver. For such a
driver `dism /Add-Driver` offline does all of this:

- copies the package into `Windows\System32\DriverStore\FileRepository\
  <inf>_arm64_<hash>\` and the INF into `Windows\INF\oemN.inf`;
- registers it in the DRIVERS hive (`DriverDatabase\DriverPackages`,
  `DriverInfFiles`, `DeviceIds\<hardware ID>`, with ranks, signer and
  catalog data that PnP reads at boot to install the device);
- because the INF's StartType is 0, installs the service (`SYSTEM\
  ControlSet00x\Services\dwcsdhc`: Type 1, Start 0, ErrorControl, Group,
  ImagePath) and copies the .sys into `System32\drivers`, so winload loads it
  and PnP binds the boot device on the first start. Windows 8 and later
  have no CriticalDeviceDatabase; that binding comes from the
  DriverDatabase entries.

wimlib applies the image on Linux (through NTFS-3G), and hivex can write
the SYSTEM hive, but the DRIVERS hive records are undocumented and
version-specific, and a mistake there ends in INACCESSIBLE_BOOT_DEVICE
with nothing to debug from. A BCD would also have to be made without
bcdboot. So on Linux and macOS the app offers the staged install for every
target instead, which runs the same DISM on the board. The one case that
could work without driver injection is NVMe (stornvme is inbox), which
would still need a BCD; that is left for later.

**Booting Windows from an SD card.** The firmware boots the SD slot before
the eMMC (woa-rk3576 INSTALL.md), so a card with an ESP is found. On the
ROCK 4D the firmware is on the SPI NOR flash and boots the card the same
way. On the
TaishanPi 3M the BootROM reads only the eMMC; the SPL there tries the SD
card first for the firmware FIT (edk2-rk3576 docs/HARDWARE.md, "the SPL
tries SD first") and with no card boots the eMMC's. A Windows card has no
FIT at sector 16384 (that is inside its ESP), so the SPL should fall back
to the eMMC firmware, as U-Boot's SPL goes down its boot list; this is the
documented behaviour with the card out, not yet seen with a Windows card
in. A board whose firmware itself lives on the SD card cannot have Windows
there too. On the CM5-IO an SD card in the slot was the cause of WinPE
freezes (fixed in firmware at ExitBootServices, n=1), and Windows running
from an SD card has not been tried on any of the boards.

**NVMe.** Windows' inbox stornvme drives it; the firmware must boot NVMe
(Fedora does on the CM5-IO and ROCK 4D; the TaishanPi 3M has no M.2 slot)
and describe PCIe in ACPI (done
and verified under Windows on the CM5-IO). The ROCK 4D's ACPI is in
progress in edk2-rk3576; the app says so and still prepares the drive.

## How the installed Windows comes out

Everything deploy-windows.cmd does stays: the RK3576 drivers from the WinPE
release, test signing, dwcsdhc and sdstor boot-start, sdbus off,
hibernation and Fast Startup off, BypassNRO. Always added: the clock.
The boards' RTC keeps UTC, and the TaishanPi 3M's holds no valid time at
all, so `RealTimeIsUniversal` is set to 1 and the Windows Time service to
start automatically, and SetupComplete.cmd syncs once and registers a task
that runs `w32tm /resync /force` a minute after every start. With the clock
behind, pnputil refuses test-signed drivers signed "in the future".
Added, all chosen on the "Windows setup" page:

- **Driver certificates.** The WinPE workflow signs each run's drivers with
  a new self-signed test certificate, and Plug and Play installs a driver
  without asking only when its publisher is trusted. The app takes the
  self-signed certificates out of every driver catalog it stages
  (`src/woa/certs.ts`, a small PKCS #7 reader; the thumbprint is checked
  against openssl's in the tests) and `woa-certs.cmd` writes them into the
  offline SOFTWARE hive under `Microsoft\SystemCertificates\ROOT` and
  `TrustedPublisher` (`Certificates\<SHA-1>`, value `Blob`: the certificate
  as serialized property 32), which is where `certutil -addstore` puts
  them. Whether Windows reads a blob with only that one property has not
  been seen on a board yet.
- **More drivers.** A folder the user picks (wddm-mali-g52, gt9271, ...) is
  staged under `extra-drivers\` and added with the same
  `dism /Add-Driver /Recurse /ForceUnsigned`; its certificates are trusted
  as above. gt9271 is in WinPE releases after 0.1.1.
- **First start.** "Windows setup (OOBE)" leaves Windows' own setup, which
  BypassNRO lets finish offline. "Skip setup" writes
  `\Windows\Panther\unattend.xml` (the implicit answer file location)
  with an oobeSystem pass: every OOBE page hidden (HideEULAPage,
  HideLocalAccountScreen, HideOnlineAccountScreens,
  HideWirelessSetupInOOBE, HideOEMRegistrationScreen, ProtectYourPC 3;
  the deprecated SkipMachineOOBE and SkipUserOOBE are not used), one local
  account in Administrators, AutoLogon once (or always, if chosen), and
  optional computer name (specialize pass), languages and time zone. Each
  component carries `processorArchitecture="arm64"`. Not validated against
  Microsoft's schema (no Windows SIM here): the tests check it is
  well-formed and has the elements above.
- **The password.** Never logged and not in `woa-stage.ini`. In the answer
  file it is encoded as Windows SIM encodes it (PlainText false, base64 of
  UTF-16LE password + "Password"): an encoding, not encryption. So
  SetupComplete.cmd deletes the answer file when setup is done, and the
  install script zeroes the staging copy (`fsutil file setzerodata`, best
  effort) before the staging volume is deleted. With "sign in by itself on
  every start" Windows keeps the password in the registry, as it does for
  any automatic sign-in; with it off, only the first start signs in by
  itself and Windows removes the stored password after that sign-in.
- **SSH.** On by default. The Win32-OpenSSH 9.5.0.0p1-Beta ARM64 zip
  (pinned URL, size and SHA-256 in `src/woa/setup-files.ts`) is downloaded
  once, unpacked on the PC, staged, and copied by the install script
  straight into `\Program Files\OpenSSH` of the new Windows, so the files
  inherit that folder's permissions. On the first start SetupComplete.cmd
  (as SYSTEM) runs the release's `install-sshd.ps1`, sets sshd to start
  automatically, opens TCP 22 on all firewall profiles and starts it. The
  shell stays sshd's default, cmd.exe. A pasted public key goes to
  `C:\ProgramData\ssh\administrators_authorized_keys` with inheritance
  removed and only SYSTEM and Administrators granted (by SID). This
  follows what worked by hand on the TaishanPi 3M; `Add-WindowsCapability
  OpenSSH.Server` hung for over 20 minutes there and is not used.

## Trimming Windows

A 4 GB board with an eMMC spends its first minutes on what Windows starts
by itself. woa-trim.cmd (src/woa/trim.ts) trims the applied image offline,
called from the shared CONFIGURE block, so the board's WinPE and the
Windows PC build do the same. Each item is a choice; Simple mode has one
switch, "Recommended trimming" (on), Advanced mode the list, starting at
the same recommended set:

| Item | What is done | Undo on the running Windows |
|---|---|---|
| Apps that run in the background | `dism /Remove-ProvisionedAppxPackage` for News, Weather, Teams, Phone Link, Mail and Calendar, Clipchamp, Solitaire, To Do, Maps, Feedback Hub, Tips, Office hub, Xbox app, Family, Power Automate, People, Cortana, new Outlook | install them from the Store |
| OneDrive | the default user's Run value OneDriveSetup deleted; `Policies\Microsoft\Windows\OneDrive` DisableFileSyncNGSC=1 | delete the value; run `%WINDIR%\System32\OneDriveSetup.exe` |
| Copilot | `Policies\Microsoft\Windows\WindowsCopilot` TurnOffWindowsCopilot=1 (machine and default user); Copilot app removed where present | delete both values |
| Widgets | `Policies\Microsoft\Dsh` AllowNewsAndInterests=0 | delete the value |
| Edge in the background | `Policies\Microsoft\Edge` StartupBoostEnabled=0, BackgroundModeEnabled=0 | delete both values |
| Suggested apps and tips | `Policies\Microsoft\Windows\CloudContent` DisableWindowsConsumerFeatures=1, DisableConsumerAccountStateContent=1; the default user's ContentDeliveryManager values 0 | delete the values |
| Diagnostic data | `Policies\Microsoft\Windows\DataCollection` AllowTelemetry=1 (Required; 0 is honoured only by Enterprise and Education) | delete the value |
| Search indexer | WSearch DelayedAutostart=1 | `sc config wsearch start= auto` |
| SysMain | SysMain Start=4 | `sc config sysmain start= auto` |
| Remove the Store (off) | Microsoft.WindowsStore and StorePurchaseApp removed | `wsreset -i` |
| Remove Edge (off) | the Edge package stub removed; `Program Files (x86)\Microsoft\Edge` and its uninstall entries and shortcuts deleted; `Policies\Microsoft\EdgeUpdate` Install/Update{56EB18F8-...}=0 and `Microsoft\EdgeUpdate` DoNotUpdateToEdgeWithChromium=1 | delete the policy values and install Edge from microsoft.com/edge |
| Chrome (off) | Google's arm64 enterprise MSI copied into the image, installed by SetupComplete.cmd when `Get-AuthenticodeSignature` says Valid and O=Google LLC; `Policies\Microsoft\Windows\System` DefaultAssociationsConfiguration points at an XML that gives ChromeHTML .htm, .html, .pdf, http, https and the like | uninstall Chrome, delete the value |

The policies are Microsoft's documented ones (Policy CSP and ADMX names in
trim.ts); the app list is ours. Nothing is taken from tiny11builder,
whose repository has no licence. Not touched: Windows Update, activation,
the drivers, WebView2 and Edge Update (other apps and the RK3576 tools need
WebView2, and Edge Update keeps it current).

Defender's real-time protection is not offered. On 22621 and 22631 Tamper
Protection is on by default and makes Windows ignore
DisableRealtimeMonitoring and DisableAntiSpyware whether they are set
offline or not, so the choice would not hold.

Removing Edge is not supported by Microsoft outside the EEA on these
versions. What stays: Windows feature updates and repairs can install Edge
again, a taskbar pin to Edge can be left as a dead icon, and `microsoft-
edge:` links have nothing to open them. Chrome is downloaded from Google
on the PC at write time (it is not ours to ship; Google publishes no
checksum, so the PC checks it is an Arm64 MSI and the board checks the
signature). No memory figure is shown on the page: it has not been
measured on these boards.

**RK3576 tools.** When the woa-rk3576 release has `rk3576-tools-arm64*.zip`
(checked against SHA256SUMS.txt and GitHub's digest like the WinPE image;
`WOA_IMAGER_RK3576_TOOLS_URL`, `_SHA256` and `_SIZE` point at another
build for testing), it is unpacked to `rk3576-tools\` on the staging
volume, CONFIGURE runs its `offline-install.cmd W:\` (without /hook, in a
cmd of its own; a failure is logged and the install goes on), and
SetupComplete.cmd calls `%ProgramFiles%\RK3576\setup\firstboot.cmd` once.
The interface is woa-rk3576's tools/rk3576-tools/README.md. The option is
on by default and greyed out when the release has no bundle.

## How much of the disk Windows gets

`src/woa/windows-layout.ts`. By default Windows takes all of it, as
before. For a staged install (eMMC, SD card or NVMe drive; not the build
on a Windows PC) the Windows setup step can instead set the Windows
partition's size, at least 32 GB (1 GB = 1024 MiB there), and say what the
rest becomes: unallocated, or a data partition (NTFS or exFAT, a label of
1 to 11 letters, digits, - or _), with an amount kept unallocated at the
very end for a Linux install later. On the disk, after the firmware
partition (eMMC sectors 64..131071) or from 1 MiB:

    ESP 260 MiB (FAT32) | MSR 16 MiB | Windows (NTFS) | data | free

The page shows the result before anything is written (with the board's
usual eMMC size, or the chosen drive's), the plan is made again on the
size the board or drive reports, and the confirmation states it. The
CM5-IO's eMMC (about 31 GB) has no room for anything beside a 32 GB
Windows, so there it is the whole disk only.

How the install script does it (woa-stage.ini): Windows is first made in
the gap before the staging partitions, at its size when that fits
(`windows_create_mb`), else as large as the gap allows and then grown over
the freed staging space by exactly the rest (`windows_extend_mb`); the
whole-disk default keeps `create partition primary` and `extend` as they
were. Then the data partition (`create partition primary size=`,
`format quick fs=ntfs|exfat label=`), one MiB under its computed size
against rounding; what is left stays unallocated.

## Which Windows images are taken

Everything is read on the PC before the board is involved
(`src/main/windows-image.ts`, `src/woa/wim.ts`, `src/woa/udf.ts`), in plain
TypeScript, no DISM or wimlib:

- The install image: `sources/install.wim` or `install.esd` inside the ISO
  (UDF), or the .wim/.esd itself. Its XML data (UTF-16, at the end of the
  file, never compressed, also in solid ESDs) gives each edition's ARCH,
  BUILD, SPBUILD and languages. The setup and WinPE images an ESD from
  Microsoft also holds are left out.
- Per edition: ARCH must be 12 (ARM64); 9 (x64), 0 (x86), 5 (ARM32) or a
  missing ARCH is refused. BUILD 26000 and above is refused: 24H2 (26100),
  25H2 (26200) and later need ARMv8.1 atomics (LSE), and RK3576's
  Cortex-A72/A53 are ARMv8.0. 22621 and 22631 (22H2, 23H2) are the tested
  ones and get no remark. Windows 11 21H2 (22000) and Windows 10 1809 to
  22H2 (17763 to 19045) are allowed with a notice (a custom alert): not
  tested on these boards with the current drivers, 23H2 recommended. The
  drivers have only been run on Windows 11. Below 17763 is refused (no
  ARM64 media before 1809), and so is a MAJOR below 10. Other builds in
  between are Insider previews: allowed with a warning.
- An ISO's `efi/boot` folder: bootx64.efi or bootia32.efi without
  bootaa64.efi means a PC ISO, refused as a whole even if its XML were to
  say otherwise; bootaa64.efi with no ARM64 edition inside is refused too.
- The page shows what was read: file, install image, architecture, builds
  with their release names, boot files, languages, how many editions can
  be installed, and the reason next to each refused or warned edition.

No SHA-256 of the ISO is compared with a list: people get the image from
many places, UUP dump builds it locally, and a match or mismatch says
nothing about whether it runs on the board. The XML is the gate.

**Getting Windows.** The app does not ship, mirror or download Windows.
The Windows step lists where a 23H2 ARM64 ISO can be had, from
`src/shared/windows-sources.json` (shown in its order, each with a date it
was last checked; the app opens only those URLs). As of 2026-11-23:
NTriver's Windows 11 page (works from China; the 23H2 ARM64 ISOs there are
the volume licence Pro media, SW_DVD9_Win_Pro_11_23H2.23_Arm64_..., and IoT
Enterprise 23H2 arm64; its 23H2 Consumer media is x64 only), UUP dump
(builds the ISO from Microsoft's update servers; api.uupdump.net listed
22631.7714 arm64 on 2026-11-13), Visual Studio subscriptions (not
checked), and Microsoft's own ARM64 ISO page, marked unsuitable: it offers
only the current release (26H2 on that date).

## Writing to an SD card or USB drive instead

Armbian can also go onto an SD card or USB drive in the computer, and the
release's SD card firmware (`<Board>-sdcard-edk2-<tag>.img`, CM5-IO and
TaishanPi 3M; the ROCK 4D has none) onto an SD card. That is Roxora
Imager's removable-drive path, as for the WinPE stick: the drive list
without the system disk, the elevated helper (authopen on macOS), and a
read-back compared against the image's SHA-256. The eMMC is not touched.
A factory update.img stays eMMC-only: it is a MaskROM partition write.

The page says what the boards do with such a card: the CM5-IO's BootROM
starts the eMMC first whenever it holds a bootloader, so the card starts
only once the eMMC's bootloader is erased, or through the UEFI firmware
(a one-shot "Armbian (U-Boot)" entry is planned in edk2-rk3576, branch
armbian-chainload, not released). The TaishanPi 3M's BootROM never boots
an SD card (strap eMMC then USB), so a card there needs a bootloader on
the eMMC that loads it.

## Upgrading the firmware, keeping Windows and the settings

`src/woa/edk2-image.ts`, `src/woa/upgrade-plan.ts`. The procedure used by
hand on both boards, for an eMMC that runs edk2-rk3576 with Windows (or
anything else) behind it:

1. The new image: the latest release's `<Board>-emmc-edk2-<tag>.img`
   (checked against the release's SHA-256) or a file chosen here. It must
   be 32 MiB with a FIT (d00dfeed) at sector 16384 holding edk2 and nvdata
   images, made for this board: the FIT's configuration names the device
   tree (rk3576-lckfb-tspi-3m, rk3576-armsom-cm5-io) and the edk2 image
   carries the build stamp `rk3576-<Board>-<version>` in UTF-16; both must
   name this board. The page shows the version before the board is
   connected.
2. Over MaskROM: `db`, then `rfi` (the eMMC's maker and size, shown in the
   confirmation), `rl 0 34` (the partition table must have the firmware
   partition at sector 64, or the upgrade could overwrite a partition),
   then the installed firmware's FIT and edk2 image are read the same way,
   so the confirmation says "installed X, new Y". All of it lies below
   32 MiB, where this loader's reads are trustworthy.
3. Keeping the settings (the default): the nvdata slot must be at the same
   sectors in both images (43648, 384 sectors in every build so far). It
   is read (`rl`, up to three tries: the first rl after db has failed with
   "Read LBA failed"), must hold a firmware volume (`_FVH` at 0x28), and is
   saved under the app's data folder (`nvdata-backups/<board>-nvdata-<time>.bin`)
   before anything is written. An all-0xFF slot means the board has no
   settings saved; that is said, and the image's empty slot goes on.
   "Reset the settings" writes the image as it is.
4. One `wl 64` of the image from sector 64 to its end with the saved slot
   in place of the image's empty one: the same bytes as writing the image
   and then `wl 43648` the backup, in one command. Sectors 0..63 (the GPT
   that belongs to Windows) are never written.
5. Everything written (sectors 64 to 65535) is read back and compared byte
   for byte, then `rd`.

In the rkdeveloptool built here `rl` takes a length in sectors (rktool-
webusb's main.cpp); the desktop build used by hand takes bytes.

The ROCK 4D keeps its firmware in SPI NOR with no Windows partition table
to protect; it has no upgrade entry.

## Putting the board back: Armbian or a factory image

Both replace everything on the eMMC (Windows, the UEFI firmware and its
saved settings), over MaskROM only: from the board itself they would
overwrite the system that is running. Going back to Windows is the
existing flow (UEFI firmware "whole image", then Windows).

**Armbian** (`src/woa/armbian-restore.ts`, `src/main/restore.ts`). Both
boards are official Armbian boards (lckfb-taishanpi-3m, armsom-cm5-io).
What to offer comes from Armbian's own image index,
`https://github.armbian.com/armbian-images.json` (generated by Armbian's CI
into the data branch of armbian/armbian.github.io; the older
all-images.json stopped being updated in December 2025). Every plain
`.img.xz` of the board is offered: each distribution (Debian trixie,
Ubuntu resolute on 2026-11-24), kernel branch (vendor, edge; current if
Armbian builds it) and variant (minimal, server, and each desktop: GNOME
and KDE Plasma today; Xfce, Cinnamon and others appear when Armbian
publishes them), the newest build of each. Images with a preinstalled
application (Home Assistant, OMV) are left out. Advanced mode shows the
whole list as a table; Simple mode shows one card per desktop on the
board maker's kernel, with a picture (resources/desktops), and one card
without a desktop. The recommended card is the desktop Armbian itself
marks as promoted for the board (vendor GNOME on Ubuntu resolute for both
boards); Xfce is not recommended because Armbian does not publish it for
these boards. The index only decides what is offered: for the chosen
image the app asks Armbian's redirector,
`https://dl.armbian.com/<board>/<Distro>_<branch>_<variant>`, for the
image's `.sha` and `.asc` (the redirector serves both next to the image)
and for its size with a HEAD request; the redirect target (GitHub
releases of armbian/community, or the mirror Armbian picks for the user's
region) is not trusted for anything. The file name in the `.sha` gives
the Armbian version, kernel and distribution, and must be the board's and
the branch's. The download is checked against the `.sha`'s SHA-256 as it
arrives (release-download.ts, also for a cached copy), then against the
detached OpenPGP signature with Igor Pecovnik's key
DF00FAF1C577104B50BF1D0093D6889F9F0E78D5, pinned in the source
(`src/shared/openpgp.ts`: v4 RSA signatures over binary data, no gpg
needed; tested against the real trunk.137 image on 2026-11-23). A copy
that fails is deleted. It is then decompressed into the cache (one image
kept) and written from sector 0 with its own U-Boot; the last 33 sectors
of the eMMC (the old GPT backup) are zeroed so no tool finds a stale table.
The decompressed size is read before the download from the `.xz` index at
the end of the file (one ranged request for its last 64 KiB; xz lists every
block's uncompressed size there): about 2.0 GB for a minimal image, 4.8 to
6.1 GB for a desktop. A disk must hold that plus room for Armbian to grow
its root file system on the first start, 1 GiB without a desktop and
4 GiB with one (`minimumDiskBytes`): about 3.1 GB and 9 to 10.4 GB. Smaller
SD cards and USB drives are listed but cannot be chosen, and the main
process checks again after the download; both eMMCs (32 and 64 GB) are
large enough. A server that does not answer the ranged request leaves the
check to after the download.

**Factory image** (`src/woa/rkfw.ts`). The app does not download vendor
images: LCKFB ships them through a cloud drive, ArmSoM through its
documentation site, and redistribution is not ours to decide. The user
chooses an `update.img`: the RKFW header (chip field "6753" = RK3576, as
in rk3576_spl_loader.bin), the loader inside it (RKBOOT, its chip too),
the RKAF archive and its parameter.txt are read, and the package is
refused for another chip, a part larger than its partition, or a part
reaching past the file. The MD5 the packer appends is checked before
writing. The rkdeveloptool built here (jjm2473/rktool-webusb) has no `uf`
(UpgradeFirmware) command, so the write does what RKDevTool's "Upgrade
Firmware" does, step by step: `gpt parameter.txt` (the partition table),
`ul` with the package's loader (the IDBlock at sector 64), then `wl` of
each partition image at the sector parameter.txt gives it (wl expands
sparse images itself). This path has not been run on a board yet; the
page says so.

**Checks.** The whole first 32 MiB of what was written is read back and
compared (`checkHeadBytes` in maskrom-regions.ts); past 32 MiB only
samples are read, and a sample that comes back as 0xCC filler or differs
is reported, not counted as a failure, because this loader's reads past
32 MiB are not trustworthy. Nothing claims a full read-back.

## A copy before the eMMC's start is replaced

Every write over MaskROM to an eMMC except the firmware upgrade (which
keeps its own copy of the settings) replaces the partition table, the
firmware with its UEFI settings, or both: Armbian and factory images, the
firmware "whole image" and "keep the partitions", the staged and the
PC-built Windows. Before planning such a write, the worker
(src/woa/pre-write-backup.ts) reads sectors 0..33 and, when the eMMC holds
edk2-rk3576 firmware, its nvdata slot, found from that firmware's own FIT
(43648, 384 sectors on the current TaishanPi 3M and CM5-IO releases); all
of it lies in the first 32 MiB, the part MaskROM reads back reliably. The
page saves the files into `<data>/nvdata-backups/<board>-before-write-
<time>/` with a backup.txt naming the board, the time, the firmware
version and each file's SHA-256, and shows the folder on the confirmation
card and the result. A copy that was read but could not be saved stops
the write ("Nothing was written"); an eMMC without edk2-rk3576 firmware
just has no settings to keep. Clear cache deletes these folders only when
asked, like the upgrade's copies. Putting a copy back is not in the app
yet: the upgrade carries settings over from the board itself, not from a
file.

## When something fails

No failure sends the user back to the start. The run page ends with Try
again (the same job with every choice kept: the board is looked for again,
the loader sent again, then the write; files already downloaded and
checked come from the cache, a broken-off download goes on with a Range
request, and short network failures are tried three times with growing
waits before an error is shown), Back to the steps (the Review or Confirm
step, choices kept), Report a problem and Save full log. A start that
throws ends on the same page instead of a run that waits for nothing.

A board that leaves the USB bus during a job is told apart: after a
failed rkdeveloptool command the worker runs `ld` once, and when no
device answers (or the board never came back after the loader) the
reason is "The board was disconnected." The page then shows the board's
MaskROM steps and the live MaskROM line, and Try again once it is green.

Report a problem opens github.com/gahingwoo/maskrom-studio/issues/new with
a title and body (version and commit, OS and CPU, board, mode, task, the
step that failed, the error, the last 50 lines of the log, cut further
until the link is under 8000 characters); Save full log writes the whole
job log to a file to attach. Both are scrubbed in the main process
(src/shared/report.ts): the home folder becomes ~, the user name <user>,
and e-mail and IP addresses, USB serial numbers, the app's file tokens and
anything after password=, token= or key= are removed. About has the same
link without a log. There are no mirrors for the release downloads
(GitHub releases; Armbian's redirector already picks a mirror).

## Shared with Roxora Imager

Written without the board list, to be offered to roxora-os/imager:
`src/shared/openpgp.ts` (detached signature check),
`src/woa/rkfw.ts` (update.img reader and plan),
the `before` and `checkHeadBytes` options of `src/woa/maskrom-regions.ts`
(Roxora's maskrom/sequence.ts would need the same two hooks), and
`planWhole` in `src/woa/restore-plan.ts` (a whole-disk image with the old
GPT backup cleared). The streaming download with SHA-256 and the xz
decompression are already Roxora's (release-download.ts, images.ts).
Not shared: the Armbian board list and key (`armbian-restore.ts`), the
image vetting policy for Windows, and the page.

## Languages

The page is in English and Simplified Chinese, following the system
language until the user picks one (masthead and Settings; kept in
localStorage). `src/shared/i18n.ts` is a small dependency-free helper
meant to be shared with Roxora Imager, which had none; the texts are in
`src/renderer/messages.ts`, both languages side by side, and a test fails
when a key the page uses is missing in either. Messages that come from the
shared code (src/woa, src/main) are English sentences; known ones are
shown in Chinese through patterns, unknown ones as they are.

## Terms

Settled in the November 2026 UX audit (D8). The page, the error messages
that come from src/woa and src/main, the command-line output and these
documents use them. The mode is written MaskROM everywhere; "Maskrom"
stays only in the product name Maskrom Studio and in code identifiers.

| English | 中文 | Note |
|---|---|---|
| flashing mode / MaskROM mode | 刷机模式（MaskROM） | Simple mode says "flashing mode" with a help popover; Advanced mode says "MaskROM mode"; both side by side where it first appears |
| built-in storage | 板载存储 | Simple mode; Advanced mode says eMMC |
| boot firmware / UEFI firmware | 启动固件 / UEFI 固件 | Simple / Advanced mode |
| factory system package (update.img) | 原厂系统包（update.img） | |
| image | 映像 | never 镜像 |
| loader | 引导组件 | |
| Windows build | 内部版本号 | as Microsoft's Chinese |
| Windows edition | 版本 | e.g. 专业版 |
| Windows release (23H2) | 版本 23H2 | |
| read back / verify | 读回 / 校验 | |
| erase | 清除 | |
| Stable / Prerelease / CI | 稳定版 / 预发布版 / CI 构建 | |
| Try again | 重试 | |

## Not in the first version

- Windows on the ROCK 4D itself: the drive can be prepared, its ACPI is
  not ready.
- Building on the PC from Linux or macOS (see above); there the page
  offers only the install on the board, with a note that building on the
  PC needs Windows.
- A USB stick that already holds the Windows image (the fallback stick is
  WinPE only, as today; the exFAT writer could add the image partition).
- Downloading Windows from Microsoft (UUP). Legal and automatable in
  principle (uupdump does it), but it means converting ESDs, and is left
  out.
- The web build. flash.gahingwoo.com remains the browser flasher.
