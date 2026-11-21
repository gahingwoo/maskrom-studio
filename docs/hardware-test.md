# Hardware test

Nothing in this app has run on a board yet. Run these on the LCKFB
TaishanPi 3M first, from a build of `main`, and note the commit.

## What you need

- The TaishanPi 3M, its USB-C port marked OTG+DP connected to the PC, a USB
  keyboard and an HDMI screen (or LCKFB's DSI screen), the serial console
  at 1500000 baud.
- The SD card slot and the USB-A ports empty: the firmware boots them
  before the eMMC.
- A Windows 11 23H2 ARM64 ISO (build 22631), or its install.wim or
  install.esd. 24H2 and later are refused. Enterprise 22631.2428 is what
  installed before by hand.
- The eMMC already holding edk2-rk3576 0.4.1 written as "UEFI firmware,
  whole image" (the app's own firmware write is test 1).

## 1. Firmware over Maskrom (about 2 minutes)

Board, TaishanPi 3M; What to write, "UEFI firmware, keep the partitions";
Review, Connect and write. Put the board in Maskrom (F4 in the firmware's
countdown, or the MSK pads).

Watch: the run page goes through "Sending the loader", "Waiting for the
board to come back", then "Erase and write?" with the eMMC size. Expect
62008590336 bytes (57.7 GiB). Confirm. Note the result line about samples.

Serial: the board resets and the new firmware banner appears.

Also try "keep the partitions" on an eMMC without the edk2-rk3576 table:
it must refuse before writing.

## 2. Staged Windows install over Maskrom

Board, TaishanPi 3M; Windows 11 on the eMMC; choose the ISO; pick the
edition; Review, Connect and write.

| Step | Expected time | Watch |
|---|---|---|
| WinPE download (352 MB) and unpack (541 MB) | 1 to 3 minutes, once | progress in the first bar |
| Hashing the Windows image | under a minute from an SSD | second bar |
| Loader and reconnect | under 30 seconds | "Erase and write?" names the eMMC size and the partitions it removes (on a fresh firmware write: "data") |
| Writing | 5 to 15 minutes, not measured yet | bytes per second: please note the total time |
| Samples | seconds | the result says how many samples matched and how many came back as 0xCC; please note the numbers |
| Reset | | the board restarts |

Serial console after the reset: the firmware banner, then the boot from
"eMMC User Data" loading `\EFI\Boot\bootaa64.efi`. Then WinPE takes the
screen; the serial line stays quiet (WinPE does not use it).

On the screen, in WinPE:

1. "WoA RK3576 Imager: installing <edition>" and a 15 second pause.
2. "eMMC: disk N. Firmware partition found at sector 64; it is kept."
3. "Creating the Windows partitions." then "Applying the image" (20 to 40
   minutes on the eMMC).
4. "Adding the RK3576 drivers.", "Writing the boot files.", the registry
   steps.
5. "Removing the staging partitions and extending the Windows partition."
6. "Done." and a restart after 15 seconds.

Then Windows sets itself up (a few minutes, one restart) and OOBE
finishes offline. The desktop shows "Test Mode".

Afterwards, in Windows: `C:\Windows\Logs\woa-stage.log` is the install
log; Disk Management shows firmware (64 MiB, no letter), EFI, MSR and C:
up to the end of the eMMC, no staging partitions.

If WinPE stops: the log is on the screen and in `X:\woa-stage\woa-stage.log`.
Restarting the board runs the install again. To give up, write the
firmware with "whole image".

Things that would show a wrong assumption, worth a note each:

- The firmware boots something other than the staged WinPE (it should be
  the only FAT volume on the eMMC with `\EFI\Boot\bootaa64.efi`).
- WinPE starts but nothing runs: startnet.cmd did not find
  `woa-debug\collect.cmd`, or the launcher could not find `woa-stage.ini`
  (is the exFAT volume given a letter?).
- "Expected one disk with GUID": diskpart's `uniqueid disk` output differs
  from what the script looks for.
- Leftover-partition cleanup: diskpart's `detail partition` must print
  "Offset in Bytes".
- `delete volume override` or `extend` fails at the end.

## 2b. The options of the Windows setup page

Repeat test 2 (or run it once with these on):

- Skip setup with a user name and password: the board should start
  straight to the desktop, signed in. Afterwards
  `C:\Windows\Panther\unattend.xml` must be gone and
  `C:\Windows\Logs\woa-setupcomplete.log` should end with "done".
- SSH on, with your public key: `ssh <user>@<board>` from the PC with the
  key, and with the password. `sc query sshd` RUNNING, `netsh advfirewall
  firewall show rule name="OpenSSH Server (sshd)"`. The key file's ACL:
  `icacls C:\ProgramData\ssh\administrators_authorized_keys` lists only
  SYSTEM and Administrators.
- Certificates: `certutil -store Root` and `certutil -store
  TrustedPublisher` list "woa-rk3576 test signing"; Device Manager shows
  no driver waiting for approval.
- An extra driver folder (for example gt9271 from a newer WinPE run, or
  wddm-mali-g52): the device has the driver after the first start.

## 2c. Other targets and the PC build

Each is new; note per target whether the board started WinPE, finished
the install, and booted Windows.

- **SD card, staged (Linux or Windows PC).** A card of 32 GB or more in
  the PC's reader. What to write: Windows 11, "An SD card in this
  computer's card reader", "On the board". The write is read back in full.
  Put the card in the TaishanPi 3M with the edk2-rk3576 firmware on the
  eMMC. Watch serial: the SPL prints "Trying to boot from MMC2", should
  fail to find a FIT there and go on to the eMMC firmware. Then WinPE from
  the card, the install onto the card, Windows from the card.
- **NVMe, staged.** An NVMe drive in a USB enclosure; then in the CM5-IO.
  If the board boots something else, pick the NVMe in the boot manager.
- **Windows PC, built here (needs administrator rights).** The same two
  targets with "Finished here": the console of host-build.cmd shows in the
  app; the log stays in the app's data folder (host-build\host-build.log)
  on failure. The card or drive should start straight into Windows.
- **Windows PC, built here, eMMC.** About 15 GB free in the app's data
  folder. After the DISM build the app connects over Maskrom; the confirm
  card shows the eMMC and what is removed; the write sends only the
  virtual disk's blocks with data (note the size and time). The board
  restarts into Windows.

## 3. On the board itself

Boot Armbian (vendor or edge) or Fedora from an SD card on the TaishanPi 3M,
install the arm64 AppImage or .deb, and run it. Expect "This computer is the
board: LCKFB TaishanPi 3M" on the first page.

- With the system on the SD card: "Write this board directly", firmware
  "keep the partitions". It asks for the password (pkexec), writes, reads
  back. Reboot with the SD card in: the firmware banner shows the version.
- Windows from the board: the same as test 2, the write is read back in
  full. Then shut down, take the SD card out, power on: WinPE as above.
- Boot Linux from the eMMC instead: the app must refuse the eMMC (it is
  mounted).

## 4. CM5-IO

Test 2 on the CM5-IO (Maskrom button). The eMMC should report about
31272730624 bytes.

## 5. Armbian next to Windows (TaishanPi 3M)

From the `armbian-uefi` branch. Needs a Linux PC (or macOS with
`brew install e2fsprogs`): the option is greyed out on Windows. The write
lays out the whole eMMC again: **everything on it except the firmware
partition goes**, including a hand-made Windows and Armbian.

Before you start:

- Firmware: edk2-rk3576 main (the device tree with audio, touch, backlight
  and the DSI panel, and the DSI handoff fix), "Force UEFI GOP Display" off.
- A boot option "Armbian" made by hand earlier points at the old EFI
  partition, whose GUID changes. Remove it first: Esc/F2, Boot Maintenance
  Manager, Boot Options, Delete Boot Option (or `bcfg boot dump`, then
  `bcfg boot rm N` in the Shell). Otherwise there are two "Armbian" entries
  and the old one fails with "Not Found".
- SD card slot and USB ports empty.

Steps:

1. Board TaishanPi 3M; What to write: Windows 11, the board's eMMC, on the
   board (WinPE); tick "Also install Armbian next to Windows".
2. Windows image as in test 2. Windows setup: "Skip setup" with a user and
   password (Armbian takes the same password), SSH on, paste your public
   key.
3. Armbian page: choose `Armbian-unofficial_26.11.0-trunk_Lckfb-taishanpi-3m_trixie_edge_7.3.4_gnome_desktop.img.xz`.
   It copies the root partition out (about 6 GB in the app's data folder,
   `~/.config/WoA RK3576 Imager/armbian/`; about 2 minutes on a PC here,
   note how long it takes). The
   line under the button should say Armbian 26.11.0-trunk for the Taishan
   Pi 3M, Linux 7.3.4-edge-rockchip64. Size 6 GiB. Pick the default system
   (try Windows first). The Linux user name is the Windows one in lower
   case; time zone from this PC.
   Also try an image for another board (any other Armbian .img.xz): it
   must be refused with the board name.
4. Review shows the Armbian row and the accounts row. Connect and write.
   The confirm card lists "Armbian gets 6.4 GB at the end of the eMMC".
   Note the total time: about 6.2 GB more than test 2.
5. WinPE, as in test 2. Extra lines to watch for: "Putting Armbian's boot
   loader on the EFI partition." after "Writing the boot files.", and at
   the end the note about F1.
6. Windows starts as before. In Windows, Disk Management: firmware, EFI,
   MSR, C:, then a 6 GB partition at the end with no letter. C: must end
   where the Armbian partition begins (no free space between). Optional:
   `mountvol S: /s` and `dir S:\EFI\armbian` (grubaa64.efi, grub.cfg), and
   `S:\startup.nsh`.
7. Restart and press F1 in the countdown. On serial:
   - `Press ESC in 5 seconds to skip startup.nsh` (do not press anything),
   - `bcfg: Add Boot000N as <n>`: with Windows as the default, n is the
     number of boot options before it (last place); with Armbian, 0,
   - `Moving FS0:\startup.nsh -> fs0:\EFI\armbian\startup.nsh.done`,
   - `Boot option Armbian added. Starting it.`, then the GRUB menu with
     "Armbian, Linux 7.3.4-edge-rockchip64", "Armbian, the kernel /vmlinuz
     names", "Windows", "UEFI firmware settings".
   If the Shell's FS0 is not the eMMC's EFI partition, the script still
   finds it (fs0 to fs9). If nothing happens, type
   `bcfg boot add 99 fs0:\EFI\armbian\grubaa64.efi "Armbian"` by hand and
   note what `map -r` showed.
8. The kernel log follows on serial (console=ttyS0,1500000). Watch for: no
   "lckfb-tspi-3m-screen" starting and no reboot; "Starting
   armbian-uefi-firstboot.service", resize2fs "On-line resizing" lines;
   armbian-firstlogin making the accounts; then GDM on the DSI screen.
9. In Armbian (ssh root@<board> with your key, or the user with the
   password):
   - `findmnt /`, `blkid`: the root UUID is a new one, not
     0bb4374f-5bdf-42c2-b951-03fc3cb84ca8 (the image's);
     `cat /proc/cmdline` has `root=UUID=<that>` and
     `systemd.mask=lckfb-tspi-3m-screen.service`.
   - `df -h /`: about 6 GB (grown from 5.75 GiB).
     `journalctl -b -u armbian-uefi-firstboot` shows resize2fs;
     `ls /var/lib/armbian-uefi/` is empty;
     `systemctl is-enabled armbian-resize-filesystem` says disabled.
   - `sudo sgdisk -p /dev/mmcblk0` (or the eMMC's name) and `sudo sgdisk
     -v`: the Armbian partition still has type 8300 and its name "Armbian",
     no problems found.
   - `systemctl is-enabled lckfb-tspi-3m-screen.service`: masked.
   - `id <user>`, `locale`, `timedatectl`: the values from the app.
     `ls /root/.not_logged_in_yet` must be gone.
   - Touch on the DSI screen works with no rule (GNOME rotates it).
   - `aplay -l` shows the cards named LCKFB-TaishanPi3M-0;
     `alsaucm -c <card> list _verbs` for the ES8388 card should list a
     verb now. Audio itself is not expected to work.
   - `cat /boot/grub/armbian-uefi.cfg`.
10. Kernel upgrade, simulated: `sudo cp /boot/vmlinuz-7.3.4-edge-rockchip64
    /boot/vmlinuz-7.3.99-test; sudo cp /boot/initrd.img-7.3.4-edge-rockchip64
    /boot/initrd.img-7.3.99-test; sudo /etc/kernel/postinst.d/zz-armbian-uefi-grub`.
    The menu now has 7.3.99-test first; reboot and pick it (it is the same
    kernel), then remove the two files and run the hook again. A real
    `apt upgrade` that brings a new kernel should do the same through the
    hook.
11. Boot order: with "Windows" as the default the board starts Windows;
    Esc/F2, Boot Manager, "Armbian" starts GRUB. In GRUB, the "Windows"
    entry chainloads Windows' boot manager: not tried on these boards
    before, note whether it works.
12. Repeat with "Armbian" as the default on a second run: the board starts
    GRUB by itself (5 seconds, then Armbian).
