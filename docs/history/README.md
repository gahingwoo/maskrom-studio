# History

A few lines per topic. The docs describe `main`; this is how it got there.
Full texts are in the git history.

## 2026-11-21: the fork

Forked from Roxora Imager to put Windows 11 23H2 on the eMMC of the
TaishanPi 3M and CM5-IO from a PC, with no USB stick. Staging WinPE and
the image on the eMMC won over building the disk on the PC (less over USB,
no admin rights or native tools, DISM on the board does the driver
injection). See [design](../dev/design.md).

## 2026-11-23: renamed

WoA RK3576 Imager became Maskrom Studio (repository
gahingwoo/maskrom-studio, app id com.gahingwoo.MaskromStudio). Settings
are carried over on the first start.

## 2026-11-24: UX audit

Three kinds of user (beginner in Simple mode on Windows, developer in
Advanced mode, Chinese user) were walked through the built app at 1100x780,
1093x614 and 720x480, both languages and themes, without a board. Fixed:
failures now say what to do and offer Try again and Back to the steps; a
checklist when no board is found; Zadig as numbered steps; a confirmation
before stopping a write or closing the window; the board's confirmation
card above the progress; times on Simple mode's confirm page; Chinese terms
(内部版本号 for build) and untranslated strings; Clear cache lists only what
exists; board photos with empty alt text.

Decisions taken after it:

- D1: factory restore only in Advanced mode until it runs on a board.
- D2: a live MaskROM line on Get ready (WebUSB every 1.5 s, 2207:350e;
  warns on other Rockchip chips, several devices, or a missing WinUSB
  driver). Next stays enabled.
- D3: no bundled libwdi driver install (certificate store, untested on
  arm64); Zadig steps instead.
- D4: downloads keep `.part` and resume with HTTP Range; network errors
  and 5xx retried three times; full SHA-256 still checked.
- D5: one confirmation: Review lists what is erased behind a tick box; the
  board's own sizes are confirmed again after connecting.
- D6: GPT and nvdata copied to the PC before every eMMC write.
- D7: minimum window 720x560.
- D8: the terms table in [design](../dev/design.md#terms); MaskROM spelled
  so everywhere except the product name.

Open from the audit: speed and time left in progress bars, the failed step
marked in red, Chinese patterns for every low-level error, a warning style
for the erase line on Review, drag and drop of the Windows file in Simple
mode, "字节" for small sizes.

## 2026-11-25: Windows + Armbian, self-test, defaults

The hybrid install on one TaishanPi 3M eMMC, the first-desktop self-test
and new Windows defaults (Edge replaced by Chrome, no drivers from Windows
Update, OpenSSH on) were merged without a board run. Armbian presets and
the UUP download were deferred. See
[hybrid-and-presets](../dev/hybrid-and-presets.md).
