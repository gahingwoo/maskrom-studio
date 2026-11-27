# Design

How Maskrom Studio works: what each write puts on the board, the formats it
reads, and why. Using the app: [use](../use.md). Board status:
[testing](testing.md). Windows + Armbian: [hybrid-and-presets](hybrid-and-presets.md).

## Windows on the eMMC: stage, then the board installs itself

The user supplies one Windows ISO (or WIM or ESD); the app fetches the
firmware and woa-rk3576's WinPE itself. Over MaskROM it writes, behind the
firmware partition:

- `WOA-STAGE-BOOT`: woa-rk3576's WinPE FAT32 volume as released, except
  `woa-debug\collect.cmd`, replaced by a short launcher;
- `WOA-STAGE-DATA`: exFAT, with `install.wim` or `install.esd` (read
  straight out of the ISO), `woa-stage.ini` (edition, disk GUID, offsets,
  SHA-256) and `woa-stage.cmd`;
- a new GPT: the firmware entry copied unchanged, the two staging
  partitions at the end of the disk, the backup table.

The board boots WinPE from the eMMC. `woa-stage.cmd` is woa-rk3576's
`deploy-windows.cmd` (DISM apply, drivers, bcdboot, offline registry)
adapted to installing onto the disk the image is on; at the end it deletes
the staging partitions and extends Windows over them.

Why staging and not building the disk on the PC: it sends 3 to 6 GB of
compressed image instead of 10 to 12 GB of applied NTFS over USB 2.0,
needs no admin rights or native tools on any host (all PC-side work is
byte assembly in TypeScript), reuses DISM steps that already installed
Windows on both boards, and verifies on the device (DISM `/Verify`), since
MaskROM reads past 32 MiB are unreliable. A failure on the board leaves
WinPE showing its log, and a restart retries.

### How each step works

- **Booting WinPE once.** BootNext cannot be set over MaskROM. edk2-rk3576
  makes a boot option per block device ("eMMC User Data") that loads
  `\EFI\Boot\bootaa64.efi` from the first FAT volume with it
  (`BmExpandMediaDevicePath`). The new GPT has one such volume, so the next
  eMMC boot is WinPE; after the install only the new ESP has it. The SD
  slot and USB are tried first, so they must be empty. The firmware is not
  changed.
- **Starting with no one typing.** woa-rk3576's `startnet.cmd` calls
  `woa-debug\collect.cmd` from the first volume that has it. The staged
  copy has the launcher in that file (same clusters, FAT chain shortened,
  FSInfo free count adjusted; `src/woa/fat32.ts`). The launcher copies the
  script to X: and runs it there, since both staging volumes are deleted;
  WinPE runs from RAM.
- **Finding the disk.** The new GPT gets a random disk GUID, written into
  `woa-stage.ini`; the script takes the one disk with that `uniqueid`, then
  checks its size and the firmware partition (offset 32768, 67076096
  bytes). An SD card cannot be mistaken for it.
- **Layout.** ESP at 64 MiB (`create partition efi ... offset=65536`), MSR,
  NTFS up to the staging partitions; afterwards `delete volume override`
  and `extend`.
- **FAT32's 4 GiB limit.** The image goes on exFAT (`src/woa/exfat.ts`),
  which WinPE reads.
- **Verification.** Over MaskROM the app reads back sectors 0 to 33 and
  three 64 KiB samples per region; samples past 32 MiB that differ (0xCC
  filler or otherwise) are reported, not counted as failures. On the
  board, DISM `/Apply-Image /Verify` checks every file, and certutil checks
  the image's SHA-256 where WinPE has it. Running on the board itself,
  everything is read back after dropping the kernel cache.
- **Cut writes and power cuts.** The primary GPT is written last, so a cut write leaves
  the old table. After a power cut on the board the staging partitions are
  still there and the install reruns, first deleting partitions it does not
  know (anything but firmware and staging).
- **Throughput** over MaskROM (rkdeveloptool in WASM, WebUSB in a worker,
  1 MiB transfers) has not been measured.

## Running on the board itself

Under Linux on an RK3576 board (booted from SD or USB), the app offers to
write that board: firmware (eMMC whole image, keep the partitions, or the
ROCK 4D's SPI NOR) and Windows.

- Detection: `/proc/device-tree/compatible` (board compatibles,
  `rockchip,rk3576`) or the SMBIOS product name from edk2-rk3576 with ACPI
  (`/sys/class/dmi/id/product_name`).
- eMMC: the `mmcblkN` whose `device/type` is `MMC`. Refused while anything
  on it is mounted or used by LVM, RAID or ZFS (lsblk, Roxora Imager's
  rules), checked again by the elevated helper before writing.
- SPI NOR: an MTD device of type `nor`, written with `flashcp -v`. Needs
  `CONFIG_SPI_ROCKCHIP_SFC` and `CONFIG_MTD_SPI_NOR` (mainline ROCK 4D DT
  enables `sfc0`); whether Armbian's ROCK 4D kernels have both is not
  checked. Without an MTD device the app says what is missing and points
  to MaskROM.
- Windows: the same staged layout through the elevated helper (pkexec),
  read back in full. Staging rather than wimlib keeps one install path:
  boot-start driver injection (below) has no Linux equivalent.

## What is reused

- **edk2-webflash**: its board list (`boards.js`) and `prepare()`
  (`flash.js`), copied unchanged from its `src` into `src/web/webflash/`, so "whole
  image" and "keep the partitions" write what the web flasher writes. Its
  command sequence (db, wl, rd, no cs) is what `src/woa/maskrom-regions.ts`
  follows; storage is identified by its size from `rfi`. The ROCK 4D's
  writes add `cs 9` and refuse a storage that is not a 16 MiB SPI NOR, and
  "keep the settings" (sectors 0 to 32255, `src/woa/spi-image.ts`) is the
  app's own, as the web flasher only rewrites the whole flash.
- **Roxora Imager**: the Electron shell, rkdeveloptool WASM and byte-source
  devices (`src/maskrom/`), the loader built from rkbin (same SHA-256 as
  edk2-webflash's `rk3576_spl_loader.bin`), checked release downloads, the
  elevated helper, Linux disk safety rules, updates, the pretend Rockusb
  board.
- **woa-rk3576**: the WinPE image, its startnet.cmd hook, deploy-windows.cmd.

Written here in TypeScript: a GPT writer, a FAT32 single-file patch, an
exFAT writer (checked with fsck.exfat in tests), a UDF reader, a WIM header
and XML reader.

## Targets

| Target | Layout | Staged (default) | Built on the PC |
|---|---|---|---|
| eMMC, over MaskROM | firmware partition kept, Windows from 64 MiB | any host | Windows host: DISM into a VHD, then MaskROM |
| eMMC, on the board | as above | Linux on the board | no |
| SD card in the PC's reader | fresh GPT, Windows from 1 MiB | any host | Windows host: DISM onto the card |
| NVMe in a USB enclosure | fresh GPT, Windows from 1 MiB | any host | Windows host: DISM onto the drive |

A board's targets are `windowsTargets` in `src/woa/boards.ts`, the one
source for the page and the checks in stage-layout.ts and main.ts:
TaishanPi 3M eMMC and SD (its mini-PCIe slot is not M.2), CM5-IO eMMC, SD
and NVMe, ROCK 4D NVMe and SD. There is no USB-drive target for Windows.

**Staged onto SD or NVMe.** The eMMC layout without the firmware
partition, written through the elevated writer (etcher-sdk block device,
read back in full). WinPE installs onto the same disk, found by GUID. For
an SD target dwcmshc is made boot-start as well as sdstor. On macOS,
`planDiskStage` (src/helper/board-write.ts) plans the regions and
`maskrom-studio-rawdisk --regions` (src/helper/macos/rawdisk.c,
src/main/mac-write.ts `macWriteRegions`) writes them: the disk comes from
authopen after the password dialog, each region is preceded by a 16-byte
header (offset, length) with a zero-length end, every region is sent back
for comparison, and the disk is ejected afterwards.

**Drivers and configuration.** Both the board's WinPE and the PC build run
the shared `CONFIGURE` block (stage-scripts.ts; a test checks both scripts
contain it): `dism /Add-Driver` of the RK3576 drivers from the WinPE
release and the user's folder, bcdboot, test signing, boot-start services
(sdstor, dwcmshc for SD), registry settings, driver certificates, answer
file, OpenSSH. The only difference: the PC build applies an NVMe target
without /Compact.

**Built on a Windows PC.** `host-build.cmd` runs the same configure block
with the PC's DISM: diskpart (the chosen disk, or an expandable VHD the size
of the board's eMMC with 64 MiB free at the start), `/Apply-Image`, then as
above. The ISO is mounted with Mount-DiskImage. For the eMMC,
src/woa/vhd.ts reads the VHD and src/woa/host-image.ts sends only blocks
with data, with a partition table that keeps the firmware entry. The script
runs elevated (UAC); its console goes to a file the app follows.

**Why the PC build is Windows only.** The boot disk (eMMC or SD) sits
behind a test-signed boot-start driver. Offline `dism /Add-Driver` copies
the package into the DriverStore and `Windows\INF\oemN.inf`, registers it
in the DRIVERS hive (`DriverDatabase\DriverPackages`, `DriverInfFiles`,
`DeviceIds\<hardware ID>`), and for StartType 0 installs the service
(`Services\dwcsdhc`: Type 1, Start 0, ErrorControl, Group, ImagePath) and
copies the .sys. Windows 8 and later bind the boot device from those
DriverDatabase entries (no CriticalDeviceDatabase). The DRIVERS hive
records are undocumented, a mistake ends in INACCESSIBLE_BOOT_DEVICE, and a
BCD would need making without bcdboot, so Linux and macOS use the staged
install. NVMe (inbox stornvme) would only need a BCD; not done.

**Booting from SD.** The firmware boots the SD slot before the eMMC. On the
TaishanPi 3M the BootROM reads only the eMMC; its SPL tries SD first for
the firmware FIT and should fall back to the eMMC's when the card has no FIT
at sector 16384 (documented with the card out, not seen with a Windows card
in). A board whose firmware lives on the SD card cannot have Windows there.
On the CM5-IO an SD card in the slot caused WinPE freezes (fixed in
firmware at ExitBootServices). Windows from SD has not run on any board.

**NVMe.** stornvme is inbox; the firmware must boot NVMe and describe PCIe
in ACPI (done and verified on the CM5-IO and, since 2026-11-26, the ROCK
4D, whose ACPI is on edk2-rk3576 main but in no release yet). The app
still shows its "not started on this board yet" notice for the ROCK 4D.

## How the installed Windows comes out

From deploy-windows.cmd: the RK3576 drivers, test signing, dwcsdhc and
sdstor boot-start, sdbus off, hibernation and Fast Startup off, BypassNRO.
Always added: the clock. The RTC keeps UTC (the TaishanPi 3M's holds no
valid time), so `RealTimeIsUniversal` is 1, the Windows Time service starts
automatically, and SetupComplete.cmd syncs once and registers a task that
runs `w32tm /resync /force` a minute after every start. A clock behind
makes pnputil refuse drivers signed "in the future".

Chosen on the Windows setup page:

- **Driver certificates.** Each WinPE run signs its drivers with a new
  self-signed test certificate. `src/woa/certs.ts` (a small PKCS #7 reader;
  thumbprint checked against openssl in tests) takes them out of every
  staged catalog, and `woa-certs.cmd` writes them into the offline SOFTWARE
  hive under `Microsoft\SystemCertificates\ROOT` and `TrustedPublisher`
  (`Certificates\<SHA-1>`, value `Blob`, the certificate as serialized
  property 32), where `certutil -addstore` puts them. Not yet seen on a
  board whether Windows accepts a blob with only that property.
- **The driver package.** woa-rk3576's `rk3576-drivers-arm64*.zip`
  (its `tools/rk3576-drivers`; `src/woa/driver-package.ts`) is downloaded
  with the WinPE image and checked against the release's SHA-256. The
  board's default list in its `manifest.json` is staged under
  `rk3576-drivers\`, each file checked against the package's
  `SHA256SUMS.txt`; a package without `dwcsdhc` and `dwcmshc` for the board
  is refused. The install script adds that folder instead of the WinPE's
  `woa-drivers\`. Optional entries (untested on a board) are never
  installed. A release without the package (0.1.1) adds `woa-drivers\` and
  `woa-audio\` as before. For a build not yet released:
  `WOA_IMAGER_RK3576_DRIVERS_URL`, `_SHA256`, `_SIZE`.
- **More drivers.** A user folder is staged under `extra-drivers\` and
  added with `dism /Add-Driver /Recurse /ForceUnsigned`; its certificates
  are trusted as above.
- **First start.** "Windows setup (OOBE)" keeps Windows' setup (BypassNRO
  lets it finish offline). "Skip setup" writes `\Windows\Panther\unattend.xml`
  with an oobeSystem pass: HideEULAPage, HideLocalAccountScreen,
  HideOnlineAccountScreens, HideWirelessSetupInOOBE,
  HideOEMRegistrationScreen, ProtectYourPC 3 (not the deprecated
  SkipMachineOOBE/SkipUserOOBE), one local account in Administrators,
  AutoLogon, optional computer name (specialize), languages and time zone,
  each component `processorArchitecture="arm64"`. Not validated against
  Microsoft's schema; tests check it is well-formed.
- **Language, keyboard, time zone pickers.** Searchable selects
  (`src/renderer/picker.tsx`) over `src/shared/windows-intl.json`, made by
  `scripts/windows-intl-lists.mjs` from Microsoft's "Available language
  packs" and "Default input profiles" tables and CLDR's windowsZones.xml
  (with its bcp47 aliases). The values are the codes the answer file took
  before (zh-CN, 1409:00001409 or a language tag for an input method,
  New Zealand Standard Time); names come from Intl.DisplayNames in the
  page's language, time zones keep Windows' English display names. The
  time zone is preselected from the PC's IANA zone; the language from the
  PC's region (`app.getSystemLocale()`) only when the image has it as a
  display language, else the image's language of the same family, else
  none. A language the image cannot display stays allowed, with a warning,
  since UILanguage takes the same value.
- **The password.** Never logged, not in `woa-stage.ini`. In the answer
  file it is encoded as Windows SIM does (PlainText false, base64 of
  UTF-16LE password + "Password"), which is not encryption. SetupComplete.cmd
  deletes the answer file, a RunOnce value deletes any Panther copy after
  the first sign-in, and the staging copy is zeroed (`fsutil file
  setzerodata`, best effort). AutoLogon has LogonCount 1.
- **Sign in automatically.** `woa-autologon.ps1` goes to
  `\Windows\Setup\Scripts` (staging copy zeroed); SetupComplete.cmd limits
  it to SYSTEM and Administrators and makes a SYSTEM task that runs it half
  a minute after the first sign-in. It deletes AutoLogonCount, stores the
  password as LSA secret DefaultPassword (LsaStorePrivateData; an empty
  password gets an empty DefaultPassword value and no secret), deletes the
  plain-text DefaultPassword value, sets AutoAdminLogon 1, DefaultUserName,
  DefaultDomainName "." and PasswordLess\Device
  DevicePasswordLessBuildVersion 0, then deletes its task and itself. Log:
  `C:\Windows\Logs\woa-autologon.log`.
- **SSH** (on by default). Win32-OpenSSH 9.5.0.0p1-Beta ARM64 (URL, size
  and SHA-256 pinned in `src/woa/setup-files.ts`) is unpacked on the PC and
  copied into `\Program Files\OpenSSH` of the new Windows. On first start
  SetupComplete.cmd runs `install-sshd.ps1`, sets sshd automatic, opens TCP
  22 on every profile (rule "OpenSSH Server (sshd)", replaced if there; a
  first Ethernet network comes up Public, and the earlier Private/Domain
  rule blocked SSH on a ROCK 4D on 2026-11-26) and starts it. The
  shell is cmd.exe. A public key goes to
  `C:\ProgramData\ssh\administrators_authorized_keys`, inheritance removed,
  only SYSTEM and Administrators (by SID). `Add-WindowsCapability
  OpenSSH.Server` hung for over 20 minutes on the TaishanPi 3M and is not
  used.
- **Desktop folder** (always). `src/woa/desktop-tools.ts`: SetupComplete.cmd
  runs `woa-desktop-tools.ps1` as SYSTEM after the RK3576 tools and the
  browser switch cleanup; it makes "RK3576 Tools" / "RK3576 工具" (by the system UI
  language) on the Public Desktop with .lnk/.url files only, each only when
  its target exists. The scripts stay in `\Windows\Setup\Scripts`:
  `woa-diag.ps1` (read only) and `woa-ssh-fix.ps1` (both elevate through
  UAC). The drivers entry is a link to
  woa-rk3576 docs/drivers.md: no driver installer is left on the board.
- **RK3576 tools** (on when the release has them). `rk3576-tools-arm64*.zip`
  from the woa-rk3576 release (checked against SHA256SUMS.txt and GitHub's
  digest) is unpacked to `rk3576-tools\` on the staging volume; CONFIGURE
  runs its `offline-install.cmd W:\` in its own cmd (a failure is logged,
  the install goes on) and SetupComplete.cmd calls
  `%ProgramFiles%\RK3576\setup\firstboot.cmd` once. Interface:
  woa-rk3576's tools/rk3576-tools/README.md. For testing,
  `WOA_IMAGER_RK3576_TOOLS_URL`, `_SHA256` and `_SIZE` point at another
  build.

## Trimming Windows

`woa-trim.cmd` (src/woa/trim.ts) edits the applied image offline from the
CONFIGURE block, so WinPE and the PC build do the same. Simple mode has one
switch, "Recommended trimming" (on); Advanced mode lists each item, starting
from the recommended set. Logged in `woa-stage.log`.

| Item | Recommended | What is done | Undo on the running Windows |
|---|---|---|---|
| Background apps | on | `dism /Remove-ProvisionedAppxPackage` for News, Weather, Teams, Phone Link, Mail and Calendar, Clipchamp, Solitaire, To Do, Maps, Feedback Hub, Tips, Get Help, Office hub, Xbox app, Media Player, Movies & TV, Family, Power Automate, People, Cortana, new Outlook | install them from the Store |
| OneDrive | on | default user's Run value OneDriveSetup deleted; `Policies\Microsoft\Windows\OneDrive` DisableFileSyncNGSC=1 | delete the value; run `%WINDIR%\System32\OneDriveSetup.exe` |
| Copilot | on | `Policies\Microsoft\Windows\WindowsCopilot` TurnOffWindowsCopilot=1 (machine and default user); Copilot app removed | delete both values |
| Widgets | on | `Policies\Microsoft\Dsh` AllowNewsAndInterests=0 | delete the value |
| Edge in the background | on | `Policies\Microsoft\Edge` StartupBoostEnabled=0, BackgroundModeEnabled=0 | delete both values |
| Suggested apps and tips | on | `Policies\Microsoft\Windows\CloudContent` DisableWindowsConsumerFeatures=1, DisableConsumerAccountStateContent=1; default user's ContentDeliveryManager values 0 | delete the values |
| Diagnostic data | on | `Policies\Microsoft\Windows\DataCollection` AllowTelemetry=1 (Required; 0 only works on Enterprise and Education) | delete the value |
| Search indexer | on | WSearch DelayedAutostart=1 | `sc config wsearch start= auto` |
| SysMain | on | SysMain Start=4 | `sc config sysmain start= auto` |
| Classic right-click menu | on | empty default value at `CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32` in the user's classes: in the default profile's UsrClass.dat when present, and by a RunOnce value at each new user's first sign-in (HKCU\Software\Classes is UsrClass.dat, not NTUSER.DAT) | delete `HKCU\Software\Classes\CLSID\{86ca1aa0-...}`, sign in again |
| No drivers from Windows Update | on | `Policies\Microsoft\Windows\WindowsUpdate` ExcludeWUDriversInQualityUpdate=1, so updates cannot replace the test-signed RK3576 drivers | delete the value |
| Remove Edge | off | Edge package stub removed; `Program Files (x86)\Microsoft\Edge`, its uninstall entries and shortcuts deleted; `Policies\Microsoft\EdgeUpdate` Install/Update{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}=0 and `Microsoft\EdgeUpdate` DoNotUpdateToEdgeWithChromium=1 | delete the policy values, install Edge from microsoft.com/edge |
| Chrome | on | Google's arm64 enterprise MSI copied into the image, installed by SetupComplete.cmd when `Get-AuthenticodeSignature` says Valid and O=Google LLC; `Policies\Microsoft\Windows\System` DefaultAssociationsConfiguration points at an XML giving ChromeHTML .htm, .html, .pdf, http, https and the like | uninstall Chrome, delete the value |
| Remove the Store | off | Microsoft.WindowsStore and StorePurchaseApp removed | `wsreset -i` |

The policies are Microsoft's documented ones (Policy CSP and ADMX names in
trim.ts); the app list is ours (nothing from tiny11builder, which has no
licence). Never touched: Windows Update itself, activation, drivers,
WebView2 and Edge Update (WebView2 needs it).

No list may name a framework package (VCLibs, UI.Xaml, .NET Native,
Windows App Runtime and the like, `FRAMEWORK_PREFIXES`) or an app that
stays (`KEEP_APPS`). test/trim.test.ts checks the lists against
test/fixtures/appx-22621-iot-arm64.json, the provisioned packages and their
dependencies recorded from an IoT Enterprise 22621.2428 ARM64 install.wim.

Notepad, on every install whether trimmed or not (`notepadFixCmd`): that
image's Notepad app is x64 only and needs Microsoft.UI.Xaml.2.7 for x64,
which the image does not have (only arm64 and arm), so opening a .txt fails
with 0x80073CF3. When an image has exactly that, the Notepad app is
unprovisioned and .txt files open in the classic notepad.exe; the Store
installs the arm64 Notepad app when wanted.

- Chrome is downloaded from Google at write time (no published checksum:
  the PC checks it is an Arm64 MSI, the board checks the signature). The
  write stops when Chrome is chosen and its installer is missing.
- Removing Edge is not supported by Microsoft outside the EEA: feature
  updates and repairs can bring it back, a taskbar pin can stay as a dead
  icon, and `microsoft-edge:` links have no handler.
- Defender real-time protection is not offered: Tamper Protection (on by
  default on 22621 and 22631) ignores DisableRealtimeMonitoring and
  DisableAntiSpyware.
- No memory saving is shown: it has not been measured.

## Edge, Chrome and WebView2 on the GPU

They need no switch on the fixed maliwddm (wddm-mali-g52 2df1808 or later):
DirectComposition runs at 60 fps at 1440p. Version 1 of woa-rk3576's
`tools/rk3576-tools/setup/rk3576-browser-gpu.ps1` added
`--disable-direct-composition` to every launch path, with a scheduled task;
that switch never helped (wddm-mali-g52 `docs/EDGE-PRESENT.md`). Version 2
only takes out what version 1 added; its `BROWSER-GPU.md` is the reference.

A copy lives in `src/woa/browser-gpu/` (with its PowerShell tests), turned
into `src/woa/browser-gpu-script.ts` by `scripts/sync-browser-gpu.mjs`;
`test/browser-gpu.test.ts` fails when they disagree, and CI warns when the
copy differs from woa-rk3576's main. Every install puts it in
`\Windows\Setup\Scripts`; SetupComplete.cmd runs `-Action Install` after
Chrome and the RK3576 tools, then deletes the copy. It stays because a tools
bundle built before version 2 (the woa-rk3576 `ci` release has one) still
installs version 1 at its first boot; on a Windows without the switch it
changes nothing. `browserGpu: false` in `SetupOptions` leaves it out.

## Disk size for Windows

`src/woa/windows-layout.ts`. Default: the whole disk. For a staged install
(not the PC build) Windows can get a size of at least 32 GB (1 GB = 1024
MiB), the rest unallocated or a data partition (NTFS or exFAT, label of 1
to 11 letters, digits, - or _), with an amount kept free at the end. After
the firmware partition (eMMC sectors 64..131071) or from 1 MiB:

    ESP 260 MiB (FAT32) | MSR 16 MiB | Windows (NTFS) | data | free

The plan is shown with the board's usual eMMC size (or the drive's), made
again on the size the board reports, and stated on the confirmation. The
CM5-IO's eMMC (about 31 GB) is whole-disk only.

In `woa-stage.ini`: Windows is created in the gap before staging at its
size when that fits (`windows_create_mb`), else as large as possible and
then extended over the freed staging space by the rest
(`windows_extend_mb`). Then the data partition (`create partition primary
size=`, `format quick fs=ntfs|exfat label=`), one MiB under its size against
rounding.

## Which Windows images are taken

Read on the PC in TypeScript (`src/main/windows-image.ts`, `src/woa/wim.ts`,
`src/woa/udf.ts`), before the board is involved:

- The install image: `sources/install.wim` or `install.esd` inside the ISO
  (UDF), or the file itself. Its XML (UTF-16, at the end, never compressed,
  also in solid ESDs) gives each edition's ARCH, BUILD, SPBUILD and
  languages. Setup and WinPE images in an ESD are skipped.
- Per edition: ARCH must be 12 (ARM64). BUILD 26000 and above is refused
  (24H2 26100, 25H2 26200 and later need ARMv8.1 LSE atomics; RK3576 is
  ARMv8.0). 22621 and 22631 get no remark. 22000 (21H2) and 17763 to 19045
  (Windows 10 1809 to 22H2) are allowed with a notice. Below 17763 or MAJOR
  below 10 is refused. Builds in between are Insider: allowed with a
  warning.
- An ISO with bootx64.efi or bootia32.efi and no bootaa64.efi is refused as
  a PC ISO; bootaa64.efi with no ARM64 edition is refused too.
- No ISO checksum list: images come from many places and UUP dump builds
  them locally. The XML is the gate.

The app does not ship, mirror or download Windows. The sources the Windows
step lists come from `src/shared/windows-sources.json` (in order, each with
a last-checked date; the app opens only those URLs): NTriver (recommended
for everyone: direct downloads that also work from mainland China; 23H2
ARM64 VL Pro and IoT Enterprise media, its Consumer 23H2 is x64 only),
UUP dump, Visual Studio subscriptions (not checked) and Microsoft's
ARM64 ISO page, marked unsuitable (current release only).

## Armbian or the firmware onto an SD card or USB drive

Armbian, or the release's SD card firmware (`<Board>-sdcard-edk2-<tag>.img`,
CM5-IO and TaishanPi 3M), can go to a removable drive: Roxora Imager's path
(drive list without the system disk, elevated helper or authopen,
read-back against SHA-256). The eMMC is not touched. The CM5-IO's BootROM
starts the eMMC first whenever it holds a bootloader, so the card starts
only once that is erased, or through the firmware's "Armbian (U-Boot)"
entry (on edk2-rk3576 main for the TaishanPi 3M only). The TaishanPi 3M's
BootROM never boots SD (eMMC, then USB), so a card needs a bootloader on
the eMMC that loads it.

## Upgrading the firmware, keeping Windows and the settings

`src/woa/edk2-image.ts`, `src/woa/upgrade-plan.ts`. For an eMMC that runs
edk2-rk3576 with anything behind it:

1. The new image (latest `<Board>-emmc-edk2-<tag>.img`, checked against the
   release's SHA-256, or a chosen file) must be 32 MiB with a FIT
   (d00dfeed) at sector 16384 holding edk2 and nvdata images, and name this
   board twice: the FIT's device tree (rk3576-lckfb-tspi-3m,
   rk3576-armsom-cm5-io) and the UTF-16 build stamp
   `rk3576-<Board>-<version>` in the edk2 image.
2. Over MaskROM: `db`, `rfi` (maker and size), `rl 0 34` (the firmware
   partition must be at sector 64), then the installed FIT and edk2 image,
   so the confirmation says "installed X, new Y". All below 32 MiB.
3. Keeping the settings (default): the nvdata slot must be at the same
   sectors in both images (43648, 384 sectors so far). It is read with up
   to three tries (the first rl after db has failed with "Read LBA
   failed"), must hold a firmware volume (`_FVH` at 0x28), and is saved to
   `nvdata-backups/<board>-nvdata-<time>.bin` first. All 0xFF means no
   saved settings; the image's empty slot is used and the page says so.
4. One `wl 64` from sector 64 to the image's end with the saved slot in
   place. Sectors 0..63 (Windows' GPT) are never written.
5. Sectors 64 to 65535 are read back and compared byte for byte, then `rd`.

The rkdeveloptool built here takes `rl` lengths in sectors (rktool-webusb's
main.cpp); the desktop build takes bytes. The ROCK 4D (SPI NOR, no Windows
table to protect) has no upgrade entry.

## Putting the board back: Armbian or a factory image

Both replace everything on the eMMC, over MaskROM only.

**Armbian** (`src/woa/armbian-restore.ts`, `src/main/restore.ts`). The
offer comes from Armbian's index `https://github.armbian.com/armbian-images.json`
(the older all-images.json stopped in December 2025): every plain `.img.xz`
of the board (lckfb-taishanpi-3m, armsom-cm5-io), newest build per
distribution, kernel branch and variant; images with a preinstalled
application (Home Assistant, OMV) are left out. Advanced mode shows a
table; Simple mode one card per desktop on the vendor kernel
(resources/desktops) plus one without, recommending the one Armbian marks
promoted (vendor GNOME on Ubuntu resolute).

For the chosen image the app asks the redirector
`https://dl.armbian.com/<board>/<Distro>_<branch>_<variant>` for `.sha`,
`.asc` and the size (HEAD); the redirect target is trusted for nothing. The
`.sha` file name must match board and branch. The download is checked
against the SHA-256 as it arrives (also for a cached copy), then against
the detached OpenPGP signature with Igor Pecovnik's key
DF00FAF1C577104B50BF1D0093D6889F9F0E78D5 pinned in `src/shared/openpgp.ts`
(v4 RSA over binary data, no gpg). A failing copy is deleted. It is
decompressed into the cache (one image kept), written from sector 0 with
its own U-Boot, and the last 33 sectors (old backup GPT) are zeroed.

The decompressed size comes from the `.xz` index (one ranged request for
the last 64 KiB): about 2.0 GB minimal, 4.8 to 6.1 GB desktop. A disk must
hold that plus 1 GiB (no desktop) or 4 GiB (desktop) for the first-start
resize (`minimumDiskBytes`); smaller drives are listed but disabled, and
checked again after the download.

**Factory image** (`src/woa/rkfw.ts`, not run on a board). The app does not
download vendor images. It reads the RKFW header (chip "6753" = RK3576),
the RKBOOT loader inside (its chip too), the RKAF archive and parameter.txt,
refuses another chip, a part larger than its partition or past the file
end, and checks the appended MD5. This rkdeveloptool has no `uf`, so the
write does RKDevTool's "Upgrade Firmware" by hand: `gpt parameter.txt`,
`ul` with the package's loader, then `wl` of each partition at its sector
(wl expands sparse images).

**Checks.** The first 32 MiB of what was written is read back and compared
(`checkHeadBytes` in maskrom-regions.ts); past that only samples, and a
differing sample is reported, not a failure.

## A copy before the eMMC's start is replaced

Every MaskROM eMMC write except the upgrade (Armbian, factory image, both
firmware writes, staged and PC-built Windows) first runs
`src/woa/pre-write-backup.ts`: it reads sectors 0..33 and, when the eMMC
holds edk2-rk3576, its nvdata slot found from that firmware's FIT (43648,
384 sectors on current releases), all within 32 MiB. The page saves them in
`<data>/nvdata-backups/<board>-before-write-<time>/` with a backup.txt
(board, time, firmware version, each file's SHA-256) and names the folder
on the confirmation and result. A copy that cannot be saved stops the write
("Nothing was written"). Clear cache deletes these only when asked.
Restoring from a copy is not in the app.

## When something fails

The run page ends with Try again (same job; board looked for again, loader
resent; checked downloads from the cache, a broken download resumed with a
Range request, short network failures retried three times with 1, 2 and 4
s waits, 404 not retried), Back to the steps, Report a problem and Save
full log. A start that throws ends on the same page.

After a failed rkdeveloptool command the worker runs `ld` once; when no
device answers (or the board never came back after the loader) the reason
is "The board was disconnected.", and the page shows the MaskROM steps and
the live MaskROM line.

Report a problem opens github.com/gahingwoo/maskrom-studio/issues/new with
version and commit, OS and CPU, board, mode, task, failed step, error and
the last 50 log lines, cut until the URL is under 8000 characters. Both it
and Save full log are scrubbed in the main process (src/shared/report.ts):
home folder to ~, user name to <user>, and e-mail and IP addresses, USB
serials, file tokens and anything after password=, token= or key= removed.

## Shared with Roxora Imager

Written to be offered upstream: `src/shared/openpgp.ts`, `src/woa/rkfw.ts`,
the `before` and `checkHeadBytes` options of `src/woa/maskrom-regions.ts`,
and `planWhole` in `src/woa/restore-plan.ts`. Not shared: the Armbian board
list and key, the Windows vetting policy, the page.

## Languages

English and Simplified Chinese, following the system until the user picks
one (kept in localStorage). `src/shared/i18n.ts` is a small helper; texts
are in `src/renderer/messages.ts`, both languages side by side, and a test
fails when a key is missing in either. Messages from src/woa and src/main
are English; known ones are shown in Chinese through patterns.

## Terms

The page, error messages, CLI output and these documents use these. The mode
is written MaskROM; "Maskrom" only in the product name and code identifiers.

| English | 中文 | Note |
|---|---|---|
| flashing mode / MaskROM mode | 刷机模式（MaskROM） | Simple mode says "flashing mode" with a help popover; Advanced says "MaskROM mode"; both where it first appears |
| built-in storage | 板载存储 | Simple mode; Advanced says eMMC |
| boot firmware / UEFI firmware | 启动固件 / UEFI 固件 | Simple / Advanced |
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

## Not done

- Building on the PC from Linux or macOS.
- A USB stick holding the Windows image (the stick is WinPE only).
- Downloading Windows from Microsoft (UUP): shelved.
- A web build: flash.gahingwoo.com is the browser flasher.
