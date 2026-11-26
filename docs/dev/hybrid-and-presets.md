# Design: Windows + Armbian on one board, Armbian presets

What is built, what is decided but not built, and what still needs a board.
Main design: [design](design.md). Prototype screens (static PatternFly 6,
not the app): `docs/dev/img/hybrid/1-install-mode.png` to `6-confirm.png`.

## Built (not run on a board)

- **Hybrid on one eMMC**, TaishanPi 3M, Advanced mode, over MaskROM
  (`src/woa/armbian-hybrid.ts`, `stage-layout.ts`, `woa-stage.cmd`): the
  Armbian image's root partition at the end of the eMMC, its U-Boot FIT in
  the firmware slot at 0x10000, staging and Windows before it. The user
  picks the image (none preselected) and its size (slider, 24 GB default).
- **ROCK 4D: Windows on NVMe, Armbian on an SD card**, Advanced mode
  (`hybrid: 'nvme-and-sd'` in `src/woa/boards.ts`, `src/woa/armbian-once.ts`,
  `startHybridSd` in `App.tsx`): one job, three steps. (1) Over MaskROM,
  read only: `cs 9`, the SPI NOR size check, sectors 64..767 (the SPL, up to
  the FIT at 768) searched for `ArmbianOnce/1`; without it the job stops
  and nothing is written. (2) Windows staged on the NVMe drive (or built on
  a Windows PC), as without Armbian; `woa-stage.ini` gets `armbian_sd=1`
  so WinPE says how Armbian starts. (3) Armbian's whole image onto the SD
  card (`restore:write-drive`, SHA-256 and signature as for any card).
  Images: Armbian's `radxa-rock-4d`; vendor is only published as nightly
  builds (`dl.armbian.com/nightly/`, same signing key), marked so in the
  list. Both branches use mainline U-Boot v2026.04 with the FIT at sector
  16384 (checked in the 26.8.2 edge and 26.11.0-trunk.140 vendor images).
- **Default system:** Windows only, until the firmware has a default-system
  option; the page shows Armbian as default greyed out with the reason.
- **No presets:** Armbian's first login asks for passwords, user and time
  zone. So no ext4 writes: the file system UUID is the image's (do not keep
  the same image on an SD card in the board), no read-only NTFS mount, no
  mirror or extras.
- **Resize:** the Armbian partition ends within the last MiB of the eMMC,
  past the 99% line `armbian-resize-filesystem` computes, so that script
  never edits the partition table and only runs `resize2fs`
  (`resizeLeavesTableAlone`, checked when planning and in tests).
- **First-desktop self-test** (`src/woa/selftest.ts`): Device Manager
  without warnings (EC20 `MI_04` allowed), GPU on WDDM 2.0 at 594 MHz or
  more where maliwddm reports `GpuClkHz`, an audio output, network with
  name resolution, 64 MiB written and read back; a message box and a
  prefilled GitHub issue link. Nothing is uploaded. No NPU test.
- **Windows defaults**: the recommended trimming installs Chrome arm64 and
  keeps drivers out of Windows Update; Edge stays (removing it is off);
  OpenSSH on.

## Boot path and layout

Armbian starts only through the firmware's one-shot "Armbian (U-Boot)"
option (edk2-rk3576 ArmbianOnce, `RK_ARMBIAN_ONCE_ENABLE`, request in eMMC
sector 0x3FFF, docs/ARMBIAN-CHAINLOAD.md there): Armbian's own U-Boot,
boot.scr, kernel and DT, vendor or edge. That path passed on the
TaishanPi 3M from an SD card; the eMMC slot path has not run. The UEFI and
GRUB route (branch `armbian-uefi`) is not taken further. The CM5-IO needs
its SPL rebuilt with ArmbianOnce and SD-first.

ROCK 4D (ARMBIAN-CHAINLOAD.md "SPI NOR boards"): the SPL and the firmware
are on the SPI NOR flash and there is no eMMC, so the request is sector
0x3FFF of the SD card and the only target is the FIT at sector 0x4000 of
that card (`PcdArmbianOnceRequestOnSd`,
`CONFIG_SPL_ROCKCHIP_ARMBIAN_ONCE_SD_REQUEST`). No slot, no copy from NVMe,
USB or a file system: Armbian can only be a whole Armbian SD card, so
Windows and Armbian on one NVMe drive is not possible. What the firmware
must provide, and whether it exists (2026-11-26):

| Needed | Where | Exists |
|---|---|---|
| SPL with ArmbianOnce and the SD request, tag `ArmbianOnce/1` in SPI 0x8000..0x5FFFF | edk2-rk3576 c81c13f, U-Boot v2026.10 (`scripts/build-spl.sh rock4d`) | branch `rock4d-parity` only (CI build has the tag at 0x3807c); no release, never run on a board |
| `RK_ARMBIAN_ONCE_ENABLE` and `PcdArmbianOnceRequestOnSd` in ROCK4D.dsc | same commit | same |
| ArmbianOnceLib SD request path | main 5e0c941 | merged, off by default |

The board test firmware (branch `rock4d-win-test`, PR #11) has the old SPL
(U-Boot 2026.04, no tag): the check refuses it, and its firmware has no
"Armbian (U-Boot)" entry. The app reads the tag, not the build stamp: no
version number says whether a ROCK 4D image has the new SPL.

Risks on the ROCK 4D: Armbian's U-Boot keeps its environment on the SPI
NOR at 0xC00000 (Armbian's `rock4d_enable_ufs_and_spi_env`), inside the UEFI
firmware; it only reads it (bad CRC, default environment) unless someone
runs `saveenv`, which would break the firmware. `armbian-install` can flash
`u-boot-rockchip-spi.bin` to `/dev/mtd0`, the same. A one-shot from Windows does not work
on the TaishanPi (no RTC power, BootNext does not survive).

There is one ESP, Windows'; Armbian needs none (U-Boot reads `/boot/boot.scr`
from ext4).

TaishanPi 3M eMMC, 62008590336 bytes (121110528 sectors):

    0..33          GPT (written last)
    64..131071     firmware partition (64 MiB), not touched:
                     64..         SPL
                     0x3FFE       default-system hint (planned)
                     0x3FFF       ArmbianOnce request
                     16384..      firmware FIT; nvdata 43648..44031
                     0x10000..0x17FFF  ArmbianOnce slot (32..48 MiB): Armbian's FIT
    131072..       ESP 260 MiB, MSR 16 MiB, Windows NTFS (staging at its end during the install)
    ..             Armbian rootfs, type B921B045, legacy BIOS bootable attribute
    end-33..end-1  backup GPT

- The slot is inside the firmware partition above the 32 MiB the firmware
  images cover; nothing else here writes 32..64 MiB (the upgrade stops at
  sector 65535).
- Windows at least 32 GB (`MIN_WINDOWS_CHOSEN`); Armbian at least the image's
  root plus 1 GiB (minimal) or 4 GiB (desktop), as `minimumDiskBytes`.
- Armbian is last, so `windows_create_mb` / `windows_extend_mb` build
  Windows before it, and `linux_offset` stops the script deleting it.
- Only the root partition is written. The bootable attribute (GPT bit 2)
  makes bootstd scan it first (the SPL sets `bootmeths script extlinux;
  bootflow scan -lb`, so Windows' ESP is not started through EFI).
- The slot gets Armbian's FIT (image sector 16384). It cannot be read back
  over MaskROM, but a bad copy is harmless: the SPL checks the FIT hashes
  and falls back, and ArmbianOnce recopies
  `/usr/lib/linux-u-boot-*/u-boot-rockchip.bin` from the root file system
  when it differs.
- Armbian must never install its bootloader on this eMMC (`armbian-install`,
  `FORCE_UBOOT_UPDATE=yes`): it would overwrite the firmware.
- CM5-IO eMMC (31 GB) has no room for both. Per board: `hybrid` in
  `src/woa/boards.ts` (`one-emmc`, `nvme-and-sd` or none).

## Decided, not built

- **Default system** chosen in the app, changeable in the firmware: a setup
  option "Default system: Windows / Armbian (U-Boot)" in edk2-rk3576 that
  runs ArmbianOnce after the countdown when no key is pressed. The app
  cannot write UEFI variables over MaskROM, so it writes a hint sector at
  0x3FFE: `"MSKDFLT1"`, version, default (1 Windows, 2 Armbian), CRC-32; the
  firmware imports and zeroes it. Flashing clears it.
- **Armbian presets**: time zone, locale, keyboard, user, password, root
  password, host name, SSH on/off and key, Wi-Fi. Only crypt hashes on
  disk; the preset is deleted after the first start. Details below.
- **Armbian extras**: TUNA or USTC mirrors (suggested for zh_CN, never
  forced; only Armbian's deb822 files rewritten), charsiu without a model,
  apt full-upgrade on first start.
- **Windows defaults**: OOBE skipped with a local account by default,
  region presets from the PC, charsiu installed. No preinstalled models. The EC20 MBIM switch belongs
  in the RK3576 tools.
- **Adding Armbian to an existing Windows**: GPT and nvdata saved over
  MaskROM; a one-shot WinPE medium runs `woa-shrink.cmd` (disk by GUID,
  `shrink querymax`, refuse if too small, `shrink desired= minimum=`,
  `create partition primary id=b921b045-1df0-41c3-af44-4c6f280d3fae`,
  System Restore off and the pagefile emptied first, undone after); then a
  second MaskROM session compares the GPT, writes the root image, slot and
  hint, and names the entry "Armbian".
- **Sharing**: Windows mounted read-only in Armbian by default (the
  first-start hook adds `UUID=<ntfs> /mnt/windows ntfs3
  ro,nofail,x-systemd.automount 0 0`, ntfs-3g as fallback); an optional exFAT
  partition between Windows and Armbian, made by WinPE's diskpart, mounted
  at `/mnt/shared` with the user's uid and gid.
- **Windows on eMMC with Armbian on SD or NVMe**: two existing writes in
  one job.
- **Driver package**: one woa-rk3576 asset
  `rk3576-windows-drivers-<version>.zip` with `SHA256SUMS.txt` and a
  `manifest.json` (`schema`, `version`, `windows.minBuild/maxBuild`,
  `boards`, `drivers[]` with `id`, `path`, `inf`, `boards`, `bootCritical`,
  `bootStart` per target, `testSigned`, `requires`; `apps[]` with `install`
  and `firstBoot`; `certificates`). The app refuses an unknown schema and
  paths leaving the zip, and uses `bootStart` instead of the hard-coded
  dwcsdhc / sdstor / dwcmshc logic. Until it exists, an adapter builds a
  manifest from the WinPE release.
- **Windows image**: the UUP download is shelved; `docs/windows-image.md`
  explains UUP dump.
- **Full eMMC backup**: a separate tool, blocked by the 32 MiB MaskROM read
  limit (could run from Linux on the board).

## Armbian presets: how they would work

`armbian-firstlogin` (armbian/build `packages/bsp/common/usr/lib/armbian/`)
runs at the root autologin when `/root/.not_logged_in_yet` exists and
sources it as bash. Variables: `PRESET_NET_CHANGE_DEFAULTS`,
`PRESET_NET_ETHERNET_ENABLED`, `PRESET_NET_WIFI_ENABLED`,
`PRESET_NET_WIFI_SSID`, `PRESET_NET_WIFI_KEY`, `PRESET_NET_WIFI_COUNTRYCODE`,
`PRESET_NET_USE_STATIC`, `PRESET_NET_STATIC_{IP,MASK,GATEWAY,DNS}`,
`PRESET_CONNECT_WIRELESS`, `SET_LANG_BASED_ON_LOCATION`, `PRESET_LOCALE`,
`PRESET_TIMEZONE`, `PRESET_ROOT_PASSWORD`, `PRESET_ROOT_KEY`,
`PRESET_USER_NAME`, `PRESET_USER_PASSWORD`, `PRESET_USER_KEY`,
`PRESET_DEFAULT_REALNAME`, `PRESET_USER_SHELL`, `PRESET_CONFIGURATION`
(Armbian's `docs/user-guide/autoconfig.md`). Passwords there are plaintext;
there is no host name, keyboard or SSH variable; `/root/provisioning.sh`
does not run on desktop images. The marker is removed only after success.

Plan:

1. The preset carries user name, real name, locale, time zone,
   `SET_LANG_BASED_ON_LOCATION="n"`, `PRESET_USER_SHELL="bash"`,
   `PRESET_CONNECT_WIRELESS="n"`, Wi-Fi, and two random 24-character
   throwaway passwords.
2. `/root/.maskrom-firstboot` (0700) holds the `$6$` sha512-crypt hashes
   (5000 rounds, 16-character salt, computed on the PC in TypeScript),
   the key, SSH choices and extras.
3. `/etc/profile.d/zz-maskrom-firstboot.sh` runs it after firstlogin
   succeeded: `chpasswd -e` (or `passwd -l root`), `authorized_keys`, extras
   via `systemd-run` logging to `/var/log/maskrom-firstboot.log`, then
   deletes itself (`shred -u` or `rm`).
4. Wi-Fi is written as the 64-hex WPA-PSK (PBKDF2-HMAC-SHA1, SSID salt,
   4096 rounds), not as typed.

Offline file edits: `/root/.not_logged_in_yet` (0600), the two new files,
`/etc/hostname`, `/etc/hosts`, `/etc/default/keyboard`, apt sources,
`/etc/ssh/sshd_not_to_be_run` (SSH off), `/etc/ssh/sshd_config.d/10-maskrom.conf`
(`PermitRootLogin prohibit-password`), and for the hybrid a new file system
UUID in `/etc/fstab` and `rootdev=` in `/boot/armbianEnv.txt`.

The rk35xx images have no FAT boot partition (one ext4 `rootfs` from sector
32768, U-Boot at 64), so this needs an ext4 writer. Chosen: a small
TypeScript `src/woa/ext4.ts` (fallback: Armbian Imager's Rust
`armbian-write-conf` in WASM). Scope: read superblock, 64-bit descriptors,
extents, linear and htree directories; write only file contents and modes,
new files up to 64 KiB in existing linear directories, and the UUID (the
images have `metadata_csum_seed`, so only the superblock changes); refuse a
dirty file system, unknown incompat features, `inline_data` and encryption.
Writes go to an in-memory copy-on-write overlay over the verified image,
checked by a separate read path before anything is written, with
`e2fsck -fn` and `debugfs` as the CI oracle.

## To check on a board

ROCK 4D (nothing of it has run on a board):

- The SPL from `rock4d-parity` on a ROCK 4D at all (U-Boot v2026.10, XMC
  flash on v1.12 boards), then the check over MaskROM passing on it.
- "Armbian (U-Boot)" listed with the card in, the request on the card, our
  SPL loading Armbian's v2026.04 FIT, `boot.scr` found on the card with
  Windows on the NVMe (the bootcmd override).
- WinPE installing to the NVMe; the card put in afterwards; Windows not
  touching the card; the text WinPE shows at the end.
- Armbian's vendor (nightly) and edge images on the card.

- The eMMC slot path end to end; U-Boot picking the bootable Armbian
  partition with Windows on the same disk.
- The resize leaving the table alone, and online `resize2fs` on a GPT
  shared with Windows.
- For presets: `chpasswd -e` running before the first desktop sign-in on
  GNOME and KDE; netplan and NetworkManager taking a 64-hex PSK;
  `sshd_not_to_be_run` not breaking firstlogin's ssh restart; Ext4Dxe with
  a changed UUID; ntfs3 in Armbian's vendor 6.1 kernel; apt source names in
  each variant.
- How far 23H2's shrink goes on these boards.
