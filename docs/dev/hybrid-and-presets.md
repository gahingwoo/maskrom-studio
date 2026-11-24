# Design: Armbian presets, Windows + Armbian on one board

Status: design only (2026-11-25), on branch `design-hybrid`. Nothing here
is implemented. Decisions marked **(decided)** were made by the user on
2026-11-25; everything else is a proposal for review.

Prototype screens (static, rendered with PatternFly 6 classes; not the
app): `docs/dev/img/hybrid/1-install-mode.png` to `6-confirm.png`.

## What is asked for

1. Armbian installs that need no first-login questions: time zone, locale,
   keyboard, user, password, root password, host name, SSH on or off and a
   public key, Wi-Fi.
2. Windows and Armbian installed in one run, on one eMMC or on eMMC plus an
   SD card or NVMe drive. One system starts by default, the other from the
   firmware's boot manager.
3. Windows and Armbian customisation as choices: one recommended set in
   Simple mode, every item in Advanced mode.

## Decisions already made (2026-11-25)

- **(decided)** Hybrid default on the TaishanPi 3M's 58 GB eMMC: Windows
  32 GB, Armbian 24 GB, a slider between them.
- **(decided)** The default system is chosen in the app (Windows
  preselected) and can be changed later in the firmware.
- **(decided)** The Armbian edition (minimal, GNOME, KDE Plasma, shown with
  download and installed sizes) is **not** preselected; Next stays disabled
  until one is chosen.
- **(decided)** Adding Armbian to a board that already has Windows: the NTFS
  partition is shrunk on the board by WinPE, after the GPT and the UEFI
  nvdata are backed up on the PC.
- **(decided)** Armbian presets: time zone, locale, keyboard; user,
  password, root password; host name, SSH on/off, public key; Wi-Fi SSID
  and password. Passwords only as crypt hashes. The preset is deleted after
  the first start.
- **(decided)** Armbian extras: China mirrors (TUNA or USTC, suggested when
  the locale is zh_CN), charsiu preinstalled (no model), apt upgrade on the
  first start. No "TaishanPi peripherals" option: Armbian's board package
  already has them.
- **(decided)** Windows customisation on by default: recommended trimming,
  classic context menu, Edge removed and Chrome arm64 installed, no
  Microsoft account (a local account from the app, OOBE skipped through
  unattend.xml). Windows presets: time zone, language, keyboard. The
  RK3576 tools and charsiu (no model) installed automatically.
- **(decided)** No preinstalled models anywhere.
- **(decided)** The EC20 MBIM switch is a toggle inside the RK3576 tools,
  not something the installer does.
- **(decided)** One combined "RK3576 Windows driver package" becomes the
  only driver source the app uses (interface below).
- **(decided)** One shared ESP for both systems (Windows' ESP; Armbian
  gets none of its own).
- **(decided)** Armbian starts through the firmware's one-shot boot option
  "Armbian (U-Boot)" (edk2-rk3576 ArmbianOnce, request in eMMC sector
  0x3FFF), not through UEFI and GRUB.
- **(decided)** Armbian mounts the Windows NTFS partition read-only by
  default. An exFAT partition shared by both systems is offered, unchecked
  by default.
- **(decided)** Install targets: eMMC, NVMe, USB drive and SD card, as each
  board has them.
- **(decided)** Windows image: the user's ISO or ESD, or 23H2 ARM64
  downloaded from Microsoft's servers in the UUP way. The app never hosts
  or redistributes Windows.
- **(decided)** A self-test on each system's first desktop, with a report
  and a one-click issue.
- **(decided)** UI in Chinese and English, following the system language
  (as today).
- **(decided)** A full eMMC backup and restore is a separate tool; the
  install does not prompt for it (the automatic GPT and nvdata copy stays).

## 1. Armbian first-start presets

### What Armbian reads

`armbian-firstlogin` (armbian/build `packages/bsp/common/usr/lib/armbian/
armbian-firstlogin`, read on 2026-11-25) runs from
`/etc/profile.d/armbian-check-first-login.sh` when root logs in (the
console autologs root in on the first start) and `/root/.not_logged_in_yet`
exists. It **sources** that file as bash. Variables it uses:

| Variable | Used for |
|---|---|
| `PRESET_NET_CHANGE_DEFAULTS` | 1 to apply any `PRESET_NET_*` (netplan) |
| `PRESET_NET_ETHERNET_ENABLED`, `PRESET_NET_WIFI_ENABLED` | which interface; Wi-Fi wins |
| `PRESET_NET_WIFI_SSID`, `PRESET_NET_WIFI_KEY`, `PRESET_NET_WIFI_COUNTRYCODE` | Wi-Fi |
| `PRESET_NET_USE_STATIC`, `PRESET_NET_STATIC_{IP,MASK,GATEWAY,DNS}` | static IPv4 |
| `PRESET_CONNECT_WIRELESS` | answers "connect via wireless?"; `n` |
| `SET_LANG_BASED_ON_LOCATION`, `PRESET_LOCALE`, `PRESET_TIMEZONE` | locale and time zone |
| `PRESET_ROOT_PASSWORD`, `PRESET_ROOT_KEY` (a URL) | root |
| `PRESET_USER_NAME`, `PRESET_USER_PASSWORD`, `PRESET_USER_KEY` (a URL), `PRESET_DEFAULT_REALNAME`, `PRESET_USER_SHELL` | the user |
| `PRESET_CONFIGURATION` | a URL to fetch the preset from |

Setting `PRESET_ROOT_PASSWORD` or `PRESET_USER_NAME` makes the run
unattended. The marker is removed by an EXIT trap only after the run
succeeded, so a power cut re-runs it. `/root/provisioning.sh`, if present,
is sourced at the very end. Armbian documents all of this in
`docs/user-guide/autoconfig.md`; Armbian Imager writes the same file.

Facts that shape the design:

- **Passwords are plaintext there.** They are piped to `passwd`. There is
  no hash variable.
- **No host name, keyboard or SSH switch** in the preset.
- **`/root/provisioning.sh` does not run on desktop images** when the first
  login is the root autologin on tty1: the gdm3 and sddm branches end with
  `who -la | grep root | grep -q tty1 && exit 1`, before the provisioning
  line. It cannot be relied on.
- In the TaishanPi 3M trixie edge minimal image (26.11.0-trunk.137),
  `/root/.not_logged_in_yet` exists, is **empty with no data block**, mode
  0664; `/root` is 0700; `/etc/default/keyboard`, `/etc/hostname`,
  `/etc/hosts` exist; `/etc/ssh/sshd_config.d` exists and is empty;
  `ssh.service` is enabled.

### How the hashes requirement is met

Armbian's preset needs plaintext, the user wants only hashes on disk. The
proposal keeps `armbian-firstlogin` doing everything it does (user with the
right groups, locale generation, netplan, the desktop's display manager and
first autologin), and replaces the passwords right after it:

1. The preset gets `PRESET_USER_NAME`, `PRESET_DEFAULT_REALNAME`,
   `PRESET_LOCALE`, `PRESET_TIMEZONE`, `SET_LANG_BASED_ON_LOCATION="n"`,
   `PRESET_USER_SHELL="bash"`, `PRESET_CONNECT_WIRELESS="n"`, the Wi-Fi
   lines, and **two throwaway passwords**: 24 random characters each,
   generated per install by the app, never shown or logged, unrelated to
   anything the user typed.
2. `/root/.maskrom-firstboot` (0700, root) holds the user's choices that
   firstlogin cannot apply: the SHA-512 crypt hashes (`$6$`, computed on the
   PC), the public key, the SSH choices, the extras.
3. `/etc/profile.d/zz-maskrom-firstboot.sh` runs after Armbian's own
   profile script in the same root login: when `/root/.maskrom-firstboot`
   exists and `/root/.not_logged_in_yet` is gone (firstlogin succeeded),
   it runs it. That script:
   - `chpasswd -e` with the user's hash, and root's (or `passwd -l root`
     when no root password was given);
   - writes the public key to the user's `authorized_keys` (0700/0600);
   - starts the extras (below) as a transient unit with `systemd-run`, so
     the console and the desktop are not held up, logging to
     `/var/log/maskrom-firstboot.log`;
   - deletes itself and the profile hook (`shred -u` where available, else
     `rm`), then `sync`.
4. If firstlogin fails, nothing is deleted and the next start tries again
   (Armbian's own behaviour).

The throwaway passwords are valid for the seconds between firstlogin
creating the accounts and the hook replacing them, on a board that until
then also has Armbian's default root password, as every Armbian image does.
They are the only plaintext secrets ever written, and they protect nothing
the user owns.

The Wi-Fi password is not stored as typed either: the app derives the
WPA-PSK (PBKDF2-HMAC-SHA1, SSID as salt, 4096 rounds, 32 bytes) and writes
the 64 hex digits as `PRESET_NET_WIFI_KEY`. netplan and NetworkManager take
64 hex digits as the raw PSK (to verify on the board). The PSK still lets
anyone join that network; the dialog says so.

Hash format: `$6$` with 5000 rounds and a random 16-character salt. Debian
trixie and Ubuntu resolute default to yescrypt, but libxcrypt and PAM
accept `$6$`. A pure TypeScript sha512-crypt (Drepper's algorithm on
@noble/hashes' SHA-512) with the spec's test vectors and a comparison with
`openssl passwd -6` in the tests.

### Written offline into the image

Everything that is a plain file is changed before the write, so the first
start does not depend on network or scripts:

| Path | Change |
|---|---|
| `/root/.not_logged_in_yet` | the preset, mode 0600 (was 0664, empty) |
| `/root/.maskrom-firstboot` | new, 0700 |
| `/etc/profile.d/zz-maskrom-firstboot.sh` | new, 0644 |
| `/etc/hostname`, `/etc/hosts` | the host name (both overwrite existing files) |
| `/etc/default/keyboard` | `XKBLAYOUT`/`XKBVARIANT` |
| apt sources (Armbian's deb822 files) | TUNA or USTC, when chosen |
| `/etc/ssh/sshd_not_to_be_run` | new, empty, when SSH is off (Debian's `ssh.service` has `ConditionPathExists=!` on it) |
| `/etc/ssh/sshd_config.d/10-maskrom.conf` | new, `PermitRootLogin prohibit-password` when chosen |
| `/etc/fstab`, `/boot/armbianEnv.txt` | new file system UUID (hybrid only, below) |
| `/root/.rootfs_resize` | hybrid only, below |

Extras run by the first-start hook after the accounts: `apt-get update`
and `apt-get -y full-upgrade` (when chosen), charsiu from a pinned URL with
size and SHA-256 (no model), with three tries. A failure is logged and
does not undo anything else.

### Getting the files into ext4 from Windows, macOS and Linux

| Option | For | Against |
|---|---|---|
| **A. ext4 writer in TypeScript, `src/woa/ext4.ts` (proposed)** | Same code on all three hosts, no admin rights, no native tools; fits the existing pure-TS writers (GPT, FAT32, exFAT); scope can be kept small | New code that writes a file system; needs careful tests |
| B. Armbian Imager's `armbian-write-conf` (Rust, MIT, an `ext4_rs` fork), built to WASM | Already used by Armbian Imager on Armbian images | A Rust toolchain in CI; its block device API panics on I/O errors; ext4_rs is a small project; still needs our own overlay and verification |
| C. lwext4 built to WASM | Mature C library, full ext4 | Large surface for a few small files; emscripten build; GPL parts in some files (fine for GPL-2.0, but more to audit) |
| D. Loop mount | Simplest on Linux | Root, Linux only; three code paths |
| E. A FAT boot partition | | **None exists**: the rk35xx images (TaishanPi 3M, CM5-IO) have one GPT partition, `rootfs` (arm64 root type B921B045), from sector 32768, ext4, U-Boot at sector 64. `BOOTFS_TYPE` is unset for this family |
| F. A helper partition read on the board | | Armbian reads nothing like it; it would need a change inside Armbian |

Recommended: **A**, with **B** kept as the fallback if A's tests show
trouble. e2fsprogs (the armbian-uefi branch's approach) stays as the test
oracle only; it is not available on Windows and macOS.

Scope of `ext4.ts`, refusing everything else:

- Read: superblock, group descriptors (64-bit), inodes, extent trees of any
  depth, linear and htree directories (lookup only).
- Write: (1) overwrite an existing regular file's content and mode;
  (2) create a regular file in an existing **linear** directory (the ones
  used: `/root`, `/etc/profile.d`, `/etc/ssh`, `/etc/ssh/sshd_config.d`);
  (3) change the file system UUID. Files up to 64 KiB, extents in the inode
  only, inline data never. Allocation: first free inode and blocks in the
  directory's group, bitmaps, group descriptor counts and checksums,
  superblock counts, inode and directory block crc32c (the image has
  `metadata_csum`).
- Refuse: a dirty file system (journal needs recovery, `s_state` not
  clean), unknown incompat features, htree insertion, `inline_data`,
  encryption, a file that is not a regular file.
- UUID change: the images have `metadata_csum_seed` (measured on the
  TaishanPi 3M trixie edge minimal, trunk.137), so the checksum seed is
  stored and the new UUID touches the superblock only. An image without
  that feature is refused for the hybrid install (the UUID change is not
  needed for a whole-disk Armbian install).

How it cannot break the image:

- **Copy-on-write overlay.** The cached, SHA-256 and signature checked
  image is never modified. All writes go to an in-memory map of 4 KiB
  blocks; the writer that sends the image to the eMMC or drive replaces
  those blocks as they pass. The read-back compare (whole drive on SD/USB,
  first 32 MiB plus samples over MaskROM) is against image plus overlay.
- **Verified before anything is written to the board.** After editing,
  the overlay is checked by a separate read path (not the writer's
  structures): every changed file read back by path and compared byte for
  byte, every changed metadata block's checksum recomputed, free counts of
  bitmaps against descriptors and superblock, and the list of changed
  blocks must be only the expected kinds (superblock, its backups untouched,
  descriptors, bitmaps, inode table blocks, the directory blocks, the new
  data blocks). Any mismatch stops with "Nothing was written".
- **CI oracle.** Tests run on Linux with e2fsprogs: real Armbian images for
  both boards (minimal, kept small by tests reading only metadata) and
  made-up file systems (`mke2fs` with and without `metadata_csum`, 1 KiB and
  4 KiB blocks, full groups), each edited by `ext4.ts` and then
  `e2fsck -fn` must report clean and `debugfs` must read the same files.
- Never logs file contents; the preset buffer is zeroed after use.

### Where presets apply

Every Armbian write: whole eMMC over MaskROM, SD card or USB drive in the
PC, and the hybrid installs. The page offers presets whenever the chosen
image has `/root/.not_logged_in_yet` (checked in the image, as Armbian
Imager does); without it the option is off and says why.

## 2. Windows + Armbian

### Which boot path

Two ways for edk2-rk3576 to start Armbian:

| | U-Boot once ("Armbian (U-Boot)", edk2-rk3576 docs/ARMBIAN-CHAINLOAD.md) | UEFI directly (GRUB, branch `armbian-uefi` of this repo) |
|---|---|---|
| What runs | Armbian's own SPL-loaded U-Boot, boot.scr, Armbian's kernel and DT; the firmware is not involved | GRUB from the ESP, Armbian's kernel with the firmware's DT |
| Board support | TaishanPi 3M: on main (`RK_ARMBIAN_ONCE_ENABLE`), **passed on the board 2026-11-24 from an SD card**. eMMC partition (slot) path not yet run. CM5-IO: design applies, SPL not rebuilt yet. ROCK 4D: impossible (SPL on SPI NOR) | Any board with the firmware; GRUB route run by hand on the TaishanPi 3M (Armbian edge 7.3.4, 2026-11-21) |
| Kernels | vendor and edge, as Armbian supports them | edge only (vendor DT does not match the firmware's) |
| Hardware under Linux | as Armbian (GPU, display, sound, Wi-Fi, NPU all worked on the 11-24 test) | known gaps on the TaishanPi 3M: GPU off in the firmware DT, the screen service loops, UCM names, HDMI untried (edk2-rk3576 docs/linux.md) |
| Default system | needs a small firmware change (below) | the Boot#### order, or GRUB's default |
| Upgrades | Armbian's normal; the slot copy refreshes itself on each use | needs our kernel hook in the rootfs to rewrite the GRUB menu |
| One-shot from Windows | not on the TaishanPi (no RTC power: BootNext does not survive) | same limitation |

Armbian's generic `uefi-arm64` and `uefi-arm64-dt` images (current 6.18,
edge 7.3.5, GRUB, ESP + root) are a third choice: no board package at all.
Not offered: nothing board-specific works out of the box there.

**Decided: U-Boot once is the only path** (TaishanPi 3M now, CM5-IO once
its SPL is rebuilt). The GRUB work on branch `armbian-uefi` is not taken
further; its layout and `woa-stage.cmd` changes are reused, its GRUB
binary, ESP files and kernel hook are not. Consequence: the ROCK 4D, whose
SPL is on SPI NOR, gets no hybrid install; Armbian alone and Windows alone
stay available there.

**One ESP.** On this path Armbian needs no ESP at all (U-Boot reads
`/boot/boot.scr` from the ext4 root), so the disk has exactly one, the
ESP Windows' bcdboot fills. Nothing of Armbian goes onto it.

### Default system **(decided: chosen in the app, changeable in firmware)**

The "Armbian (U-Boot)" option is never picked by BootOrder (it is not
active, by design), so "Armbian by default" needs a firmware change in
edk2-rk3576:

- A setup option "Default system: Windows / Armbian (U-Boot)" (a UEFI
  variable). When it is Armbian and Armbian is present, the boot manager,
  after the usual countdown and only if no key was pressed, runs the
  ArmbianOnce path by itself. Windows is reached from the boot manager.
- The app cannot write UEFI variables over MaskROM (the nvdata store
  format is not reproduced, and a wrong store costs every setting). It
  writes a **hint sector** instead: sector 0x3FFE (next to the request
  sector 0x3FFF, in the same zero gap), a record `"MSKDFLT1"`, version,
  default (1 Windows, 2 Armbian), CRC-32. The firmware imports it into its
  variable on the next start and zeroes the sector. Flashing clears it as
  it clears 0x3FFF.
- Until that firmware exists, the page offers only "Windows" and says why.

### Layouts

TaishanPi 3M eMMC, 62008590336 bytes (121110528 sectors, 57.75 GiB):

    0..33          GPT (written last)
    64..131071     firmware partition (64 MiB), not touched:
                     64..         SPL
                     0x3FFE       default-system hint (new)
                     0x3FFF       ArmbianOnce request
                     16384..      firmware FIT; nvdata 43648..44031 (384 sectors)
                     0x10000..0x17FFF  ArmbianOnce slot (32..48 MiB): Armbian's FIT copy
    131072..       ESP 260 MiB, MSR 16 MiB, Windows NTFS
                   (during the install: WOA-STAGE-BOOT, WOA-STAGE-DATA at the end of the Windows area)
    ..             Armbian rootfs, type B921B045, legacy BIOS bootable attribute
    end-33..end-1  backup GPT

- **The slot needs no new space.** It lies inside the firmware partition,
  above the 32 MiB the firmware images cover; ArmbianOnce accepts it
  because the only partition overlapping it is the firmware one. Nothing
  else in this app writes 32..64 MiB (the firmware upgrade stops at sector
  65535).
- No Windows recovery partition, as today's installs.
- **Sizes (decided):** Armbian 24 GB by default, Windows the rest (about
  33 GiB, the mockup rounds to 32). Slider in 1 GB steps; Windows at least
  32 GB (`MIN_WINDOWS_CHOSEN`); Armbian at least the image's root plus
  1 GiB (minimal, about 3 GB) or 4 GiB (desktop, about 10 GB), as
  `minimumDiskBytes` for whole-disk installs.
- Armbian last on the disk, so Windows (before it) is created and extended
  by the existing `windows_create_mb` / `windows_extend_mb` logic with the
  Armbian partition kept, as the armbian-uefi branch already does in
  `stage-layout.ts` and `woa-stage.cmd` (`linux_offset`: never delete that
  partition when clearing leftovers).

CM5-IO eMMC (31 GB) has no room for both. ROCK 4D has no eMMC.

### The Armbian partition

- Only the image's root partition is written (its sector 0, GPT and U-Boot
  are not), into a partition at least as large as the image's.
- **New file system UUID** (superblock only, see 1), `/etc/fstab` and
  `rootdev=` in `/boot/armbianEnv.txt` rewritten: the same image on an SD
  card would otherwise give two roots with one UUID, and boot.scr finds the
  root by `rootdev=UUID=`.
- **Resize.** `armbian-resize-filesystem` grows the partition with fdisk
  keystrokes written for MBR (`d`, `n`, `p`, ...) when the root is the last
  partition, and then runs `resize2fs`. On a disk shared with Windows that
  must not run. The partition is made at its final size, ending on a 16 MiB
  boundary minus one sector, and `/root/.rootfs_resize` holds that end
  sector plus one with `s`: the script's own arithmetic then gives "Same
  size. Skip", and it goes on to `resize2fs` the file system online to the
  partition. (The armbian-uefi branch used `.no_rootfs_resize` plus its own
  service; this needs no new service.) To verify on the board.
- **U-Boot finds it.** On this path the SPL sets U-Boot's bootcmd to
  `setenv bootmeths script extlinux; bootflow scan -lb`, so Windows' ESP is
  not started through EFI. The partition gets the legacy BIOS bootable
  attribute (GPT bit 2) so bootstd scans it first. To verify on the board
  with Windows on the same eMMC.
- **The slot is filled by the app** with Armbian's FIT (image sector 16384,
  length from the FIT's images), so the boot option appears on the first
  start (the firmware lists the option only if a U-Boot is found on an SD,
  USB or NVMe disk, or in the slot). Over MaskROM the slot (past 32 MiB)
  cannot be read back reliably, but a bad copy is harmless: the SPL checks
  the FIT's hashes and falls back to the firmware, and ArmbianOnce copies
  `/usr/lib/linux-u-boot-*/u-boot-rockchip.bin` from the root file system
  into the slot again on each use when it differs.
- Armbian must never install its bootloader onto this eMMC
  (`armbian-install`, `FORCE_UBOOT_UPDATE=yes`): it would overwrite the
  firmware (ARMBIAN-CHAINLOAD R5). The first-start hook writes a note to
  `/etc/motd.d` (or `/etc/update-motd.d`) saying so; nothing can enforce it.

### Sharing files between the systems

- **Windows read-only in Armbian (default on).** The Windows partition's
  GPT GUID is only known after WinPE's diskpart made it, so the line is
  added by the first-start hook, not offline: it finds the NTFS partition
  of type EBD0A0A2 on the root file system's disk (`lsblk -o
  PARTTYPE,FSTYPE,UUID`), creates `/mnt/windows` and appends
  `UUID=<ntfs uuid> /mnt/windows ntfs3 ro,nofail,x-systemd.automount 0 0`
  to `/etc/fstab` (the kernel's ntfs3; `ntfs-3g` as a fallback when the
  kernel lacks it). Read-only also means a Windows that was not shut down
  cleanly cannot be damaged from Linux; Fast Startup and hibernation are
  already off in our installs.
- **exFAT shared partition (default off).** Taken from Armbian's share of
  the slider, size and label chosen. Created and formatted by WinPE's
  diskpart with the existing data-partition code (`format quick fs=exfat
  label=`), placed between Windows and Armbian so Armbian stays last;
  Windows gives it a drive letter. In Armbian the hook mounts it read-write
  at `/mnt/shared` with `uid=` and `gid=` of the user.

### Install order, fresh eMMC (both new)

One MaskROM session, then the board alone:

1. Before writing: GPT (0..33) and nvdata backed up to the PC (existing
   `pre-write-backup.ts`).
2. Over MaskROM: the Armbian partition (root image plus overlay), the slot,
   the hint sector, the staging volumes, the GPT last.
3. The board starts WinPE from the eMMC, installs Windows into the area
   before Armbian, deletes staging, extends Windows up to Armbian.
4. Next start: the default system. Armbian's first start applies the
   presets.

MaskROM bytes: about 6 GB (staging) plus the root image (2.0 GB minimal,
5.8 to 6.1 GB desktop). Possible saving later: send only the blocks the
ext4 bitmaps mark used, plus metadata.

### Windows on eMMC, Armbian on SD or NVMe

The Armbian image is written whole to the SD card or the NVMe drive (in a
USB enclosure) on the PC, with the presets, as the existing "Armbian onto
an SD card or USB drive" path; Windows as today. No partition work at all.
On the TaishanPi 3M the SD case is exactly what passed on 2026-11-24.

### Adding Armbian to an existing Windows **(decided: WinPE shrinks)**

Over MaskROM nothing past 32 MiB reads back reliably, and NTFS cannot be
shrunk safely from the PC. So:

1. **PC, MaskROM, read only:** GPT and nvdata saved (both under 32 MiB);
   the app checks the layout is ours (firmware at 64, ESP, MSR, Windows).
2. **PC:** a one-shot WinPE medium (SD card on the TaishanPi 3M and CM5-IO,
   USB stick on any board) with woa-rk3576's WinPE and `woa-shrink.cmd`:
   find the eMMC by disk GUID (read in step 1), `shrink querymax`, refuse
   with a clear message if Windows cannot give the asked size,
   `shrink desired= minimum=` (same number), `create partition primary
   size= id=b921b045-1df0-41c3-af44-4c6f280d3fae`, then a log file on the
   medium and shut down. The disk is never formatted. Hibernation is
   already off in our installs; pagefile and System Restore are the usual
   unmovable files, so the script turns System Restore off and sets the
   pagefile to start empty before the shrink (offline registry, undone
   afterwards).
3. **PC, MaskROM again:** the GPT is read and compared with step 1 (only
   C: smaller and one new partition of our type), then the Armbian root
   image is written into the new partition, the slot and the hint sector,
   and the GPT entry gets its name "Armbian" and the bootable attribute.
4. Windows keeps its files. Its `bcdedit` and recovery are untouched.

Two MaskROM sessions and one WinPE boot. Estimated 15 to 30 minutes.

### Board by board

| Board | Windows on | Armbian on | Boot path | Status |
|---|---|---|---|---|
| TaishanPi 3M | eMMC | eMMC (split) | U-Boot once, slot | firmware ready; slot path untested |
| TaishanPi 3M | eMMC | SD card | U-Boot once, SD | passed 2026-11-24 |
| CM5-IO | eMMC (31 GB, whole) | SD card | U-Boot once | needs the CM5-IO SPL rebuilt with ArmbianOnce and SD-first |
| CM5-IO | eMMC | NVMe | U-Boot once, slot copied from NVMe | same; NVMe untested |
| CM5-IO | NVMe | eMMC | U-Boot once, slot | same; Windows on NVMe runs |
| CM5-IO | eMMC split | | | no: 31 GB |
| CM5-IO | eMMC | USB drive | U-Boot once, slot copied from USB | same; USB-A only (no FUSB302 driver in U-Boot) |
| ROCK 4D | | | | no hybrid: SPL on SPI NOR, no U-Boot once (GRUB not used, decided) |
| TaishanPi 3M | | NVMe | | no M.2 slot |

The page builds the choices from a per-board list in `src/woa/boards.ts`
(`hybridTargets`), as `windowsTargets` does today.

## 3. Customisation

### Windows (default on, decided)

Existing pieces, mostly a change of defaults:

| Item | Today | New default |
|---|---|---|
| Recommended trimming (trim.ts list) | on | on |
| Classic context menu | in the recommended set | on |
| Remove Edge | off | **on** |
| Chrome arm64, default browser | off | **on** |
| Skip OOBE, local account | choice | **on**, name and password asked |
| Time zone, language, keyboard | optional | prefilled from the PC's settings; display language limited to the image's languages (WIM XML) |
| RK3576 tools | on when the release has them | on |
| charsiu | none | **on**, program only, no model |

Safety rule: if Chrome cannot be downloaded or is not a valid Arm64 MSI,
Edge removal is turned off for that install, so Windows is never left
without a browser. The confirmation says so.

### Armbian

Simple mode: one switch "Armbian: recommended" (mirror suggested by
locale, SSH on, apt upgrade on first start, charsiu). Advanced: each item,
plus root password, SSH key, root SSH login, Wi-Fi.

Mirrors: TUNA (`mirrors.tuna.tsinghua.edu.cn`) or USTC
(`mirrors.ustc.edu.cn`) for Debian (`/debian`), Ubuntu ports
(`/ubuntu-ports`) and Armbian (`/armbian`); suggested when the locale is
zh_CN, never forced. Only deb822 files in the format Armbian ships are
rewritten; anything else greys the option out with the reason.

### Simple mode

One page for both systems: one account (Armbian name lower-cased), one
password, host name, time zone, language, keyboard, and the two
recommended switches. Wi-Fi and SSH key are Advanced only.

## 4. The RK3576 Windows driver package (interface)

One release asset becomes the only driver source:
`rk3576-windows-drivers-<version>.zip`, published by woa-rk3576 with
`SHA256SUMS.txt` (checked against GitHub's digest as the WinPE image is
today). At its root, `manifest.json`:

```json
{
  "schema": 1,
  "version": "1.2.0",
  "windows": { "minBuild": 22000, "maxBuild": 25999 },
  "boards": ["tspi3m", "cm5io", "rock4d"],
  "drivers": [
    {
      "id": "dwcsdhc",
      "path": "drivers/dwcsdhc",
      "inf": "dwcsdhc.inf",
      "boards": ["tspi3m", "cm5io"],
      "bootCritical": true,
      "bootStart": { "eMMC": true, "sd": false },
      "testSigned": true,
      "requires": []
    }
  ],
  "apps": [
    { "id": "rk3576-tools", "path": "apps/rk3576-tools", "install": "offline-install.cmd", "firstBoot": "setup\\firstboot.cmd" },
    { "id": "charsiu", "path": "apps/charsiu", "install": "install.cmd", "models": false }
  ],
  "certificates": ["certs/woa-test-2026.cer"]
}
```

Rules the app applies: refuse an unknown `schema`; pick drivers whose
`boards` include the board; every `path` must exist and stay inside the
zip; `bootCritical` drivers are added in WinPE and made boot-start for the
boot target as `bootStart` says (replacing the hard-coded dwcsdhc / sdstor
/ dwcmshc logic in stage-scripts.ts); certificates come from the manifest
first and from the catalogs as today otherwise. Apps are installed only
when the user left them on. The user's extra driver folder stays as is.
Until the package exists, the app keeps today's sources behind the same
interface (an adapter that builds a manifest from the WinPE release).

## 5. Windows image source

Two sources, both read by the existing checks (`windows-image.ts`: ARM64,
build 22621/22631, editions from the WIM XML):

- **The user's ISO, WIM or ESD** (today).
- **Download 23H2 ARM64 from Microsoft (new).** The way UUP dump and
  uup-converter work: ask Windows Update (through UUP dump's public API,
  `api.uupdump.net`, which only returns Microsoft URLs) for the file list
  of build 22631 arm64, the chosen language and edition; download each file
  from Microsoft's servers and check it against the SHA-1 Windows Update
  publishes; then assemble an install image locally. Nothing is hosted or
  mirrored by us. Open work: the 22631 UUP set is cab and ESD based, and
  turning it into one `install.esd` (or applying it directly in WinPE with
  DISM, which can apply the edition ESD and add the cabs) needs either a
  WIM writer here or a WinPE-side step. Proposal: stage the edition ESD
  plus cabs and let the board's DISM do the assembly (`/Apply-Image` then
  `/Add-Package`), so no WIM writing in TypeScript. The URLs UUP dump
  returns expire after a while, so the download starts right before the
  write. Licensing stays with the user as for an ISO.

## 6. Self-test on the first desktop

- **Windows:** a scheduled task at the first sign-in (registered by
  SetupComplete.cmd) runs `woa-selftest.ps1`: devices with a problem code
  (`Get-PnpDevice` / `pnputil /enum-devices /problem`), which RK3576
  drivers bound and their versions, display adapter and resolution, audio
  endpoints, network up and DNS, time synced, free space on C:, the trim
  and setup steps' logs. It writes `Desktop\RK3576 自检报告.html` (and
  .txt) and shows a toast. "Report a problem" opens
  github.com/gahingwoo/maskrom-studio/issues/new with a prefilled body:
  board, firmware version, Windows build, app version, the failed checks
  only, scrubbed as `src/shared/report.ts` does today (user name, host
  name, MACs, IPs, serials removed), under 8000 characters.
- **Armbian:** the first-start hook, after the extras, runs the same kind
  of checks (`systemctl --failed`, kernel errors at level err from
  `journalctl -k -b`, network, sound cards, the display driver, the presets
  applied), writes `~/rk3576-selftest.txt`, prints a one-line summary on
  the console and in a desktop notification when there is a desktop, with
  the same prefilled issue link.
- Nothing is sent by itself; the user opens the link.

## 7. Full eMMC backup and restore (separate tool)

Not part of the install flow and never prompted there. Limit to solve
first: this loader's MaskROM reads are not trustworthy past 32 MiB, so a
full backup over MaskROM is not possible today. Options: from Linux on the
board (SD card), which the app already supports for writing; or after the
loader problem is understood. Designed and estimated separately.

## 8. UI

New steps (prototypes in `docs/dev/img/hybrid/`):

- Language: Chinese or English from the system, as today; the prototypes
  are the Chinese pages.
- **Simple mode:** Board, What to do (now: only Windows, only Armbian,
  Windows + Armbian, add Armbian to an existing Windows, update the
  firmware; `1-install-mode.png`), **Systems and disk** (where, split,
  default system, Armbian edition with sizes, none preselected;
  `2-disk-and-boot.png`), **Settings** (one account and region for both,
  two recommended switches; `3-settings-simple.png`), Get ready, Confirm
  (`6-confirm.png`).
- **Advanced mode:** Board, What to write, Windows image, **Disk and
  boot**, **Windows customisation** (`4-windows-custom.png`), **Armbian
  customisation** (`5-armbian-custom.png`), Review.
- Only-Armbian installs get the Armbian customisation step too.
- The confirmation states the layout bar, both systems, the extras, the
  default system and how to reach the other one, the backup folder, and
  what each phase does, including the self-test.
- The Windows image step gets a second choice, "Download Windows 11 23H2
  ARM64 from Microsoft", next to "Choose a file" (not drawn).

## 9. Phases and effort

Estimates are working days for one developer, including tests, excluding
waiting for hardware.

| Phase | Content | Days |
|---|---|---|
| 1 Armbian presets | `ext4.ts` with overlay and verification, sha512-crypt, PSK, preset and first-start hook, offline file edits, UI (Simple and Advanced), on every Armbian write path | 12 to 15 |
| 1b board test | TaishanPi 3M and CM5-IO, minimal and GNOME, SD and eMMC: presets applied, hashes in place, preset gone, SSH and Wi-Fi | 2 |
| 2 Windows customisation defaults | new defaults, Chrome safety rule, region presets from the PC, charsiu, driver package adapter | 4 to 6 |
| 3 Windows eMMC + Armbian SD | the two writes chained in one job, one confirmation | 3 |
| 4 Hybrid on one eMMC (TaishanPi 3M) | port `stage-layout` and `woa-stage.cmd` changes from `armbian-uefi`, root partition copy, UUID, resize rule, slot, bootable attribute, layout slider | 8 to 10 |
| 4b firmware | default-system option and hint sector in edk2-rk3576 | 2 to 3 |
| 4c board test | three cold boots each way, Armbian upgrade of `linux-u-boot-*`, Windows update | 3 |
| 5 Add Armbian to existing Windows | WinPE shrink medium and script, the two-session flow, GPT comparison | 8 to 10 |
| 6 CM5-IO | SPL with ArmbianOnce and SD-first (edk2-rk3576 `build-spl.sh`), then the CM5-IO rows of the board table | 4 to 6 |
| 7 Shared files | read-only NTFS mount, optional exFAT partition | 2 |
| 8 Self-test | Windows script and task, Armbian checks, report and issue link | 4 to 5 |
| 9 Windows from Microsoft (UUP) | file list, download with SHA-1, staged ESD plus cabs, DISM assembly in WinPE | 10 to 15 |
| 10 Full backup tool | separate design first (32 MiB read limit) | not estimated |

Order: 1, 1b, 2 (independent, can go in parallel), 3, 4 with 4b and 7, 8,
5, 6, 9.

## 10. Not verified, to check on a board

- `chpasswd -e` from the profile hook runs before the user can sign in on
  the GNOME and KDE images (the first autologin happens in the same root
  session).
- netplan / NetworkManager accept a 64-hex PSK from `PRESET_NET_WIFI_KEY`.
- `ssh.service` stays down with `sshd_not_to_be_run` and firstlogin's
  `systemctl restart ssh.service` does not fail on it.
- The `.rootfs_resize` "Same size" path and online `resize2fs` on a GPT
  shared with Windows.
- Armbian's U-Boot picks the eMMC Armbian partition with the bootable
  attribute and Windows on the same disk; the slot path end to end.
- Edk2 Ext4Dxe (ArmbianOnce reads the root file system) with the changed
  UUID and the `metadata_csum_seed` feature.
- Windows shrink amounts that 23H2 on these boards actually allows.
- Every apt source file name in each Armbian variant (Debian and Ubuntu,
  minimal and desktop).
- ntfs3 in Armbian's vendor 6.1 kernel config for these boards.
