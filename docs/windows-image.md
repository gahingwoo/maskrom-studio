# Getting a Windows 11 23H2 ARM64 image (UUP dump)

[简体中文](zh-CN/windows-image.md)

Maskrom Studio needs Windows 11 **23H2** (build 22631) for **ARM64**. It does
not download, host or pass on Windows itself. Microsoft's own ARM64 ISO page
only offers the current release (24H2 and later), which needs ARMv8.1 and
does not run on RK3576. [UUP dump](https://uupdump.net) builds a 23H2 ARM64
ISO on your own computer from the files Microsoft's update servers publish.
You need a valid Windows licence for the result.

## 1. Make the download package

1. Open <https://uupdump.net/known.php?q=22631+arm64>.
2. Choose the newest entry named like **"Windows 11, version 23H2
   (22631.xxxx) arm64"**. Do not take 26100, 26200 or anything marked
   Insider: those are 24H2 and later.
3. Choose the language (for example "Chinese (Simplified)" or "English
   (United States)") and press Next.
4. Choose the editions. **Windows Pro** is enough; every extra edition
   makes the image larger. Press Next.
5. Download method: **"Download and convert to ISO"**. Keep "Include
   updates" ticked. Press **Create download package**: a small zip file
   arrives.

## 2. Build the ISO

Unpack the zip into a folder with a short path and no spaces, with about
20 GB free. Building takes 20 to 60 minutes, depending on the connection.

- **Windows** (x64 or ARM64): run `uup_download_windows.cmd` and allow it to
  run as administrator.
- **Linux**: install `aria2`, `cabextract`, `wimtools` (wimlib), `chntpw`
  and `genisoimage` (Debian/Ubuntu package names), then run
  `bash uup_download_linux.sh`.
- **macOS**: `brew install aria2 cabextract wimlib cdrtools`, then
  `bash uup_download_macos.sh`.

The result is an ISO in the same folder, named like
`22631.xxxx_CLIENT_PROFESSIONAL_A64FRE_ZH-CN.ISO`.

## 3. Use it

Choose the ISO in the app's "Windows image" step (or drop it on the
window). The app reads the image and says if it is not ARM64 or not a
build it supports, before the board is touched.

Other sources that serve 23H2 ARM64 ISOs are listed in the app's Windows
step (with the date each was last checked).
