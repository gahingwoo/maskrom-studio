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
