# Installing Maskrom Studio

[简体中文](zh-CN/install.md)

Packages for Windows (x64, arm64), macOS and Linux (AppImage, .deb, .rpm;
x86_64 and arm64) are on the
[releases](https://github.com/gahingwoo/maskrom-studio/releases) page. On
macOS and Linux you can also run:

```sh
curl -fsSL https://raw.githubusercontent.com/gahingwoo/maskrom-studio/main/install.sh | sh
```

The script picks the package for the system, checks it against the SHA-256
GitHub publishes and installs the newest normal release. With `BETA=1`
(`... | BETA=1 sh`) it installs the newest pre-release (such as
0.1.5-beta.1). While no normal release exists, it installs the newest beta
and says so.

The packages do not include Rockchip's MaskROM loader. The first MaskROM
write downloads its pieces from rockchip-linux/rkbin
(raw.githubusercontent.com), checks them against pinned SHA-256 sums and
keeps the loader in the app's data folder (`loaders/`), so that first write
needs an internet connection.

The packages are not signed with a paid certificate, so each system warns
the first time.

## Windows

1. Run `maskrom-studio-<version>-windows-x64-setup.exe` (the zip holds the
   same app without an installer).
2. SmartScreen says "Windows protected your PC": click **More info**, then
   **Run anyway**.

MaskROM writing needs the WinUSB driver, once per computer:

1. Put the board in MaskROM mode and connect it (the Get ready step in
   Simple mode, or Review in Advanced mode, shows how and lists these
   steps).
2. Download Zadig from https://zadig.akeo.ie/ and run it.
3. Choose the device whose USB ID starts with 2207 (Options, List All
   Devices, if it is not shown), select **WinUSB** and click
   **Install Driver**.

The app does not install this driver itself. Zadig on Windows on Arm has
not been tested.

## macOS

With Homebrew, one cask per release tier (install only one; they
conflict):

```sh
brew trust gahingwoo/tap
brew install --cask gahingwoo/tap/maskrom-studio           # Stable
brew install --cask gahingwoo/tap/maskrom-studio@beta      # Prerelease
brew install --cask gahingwoo/tap/maskrom-studio@nightly   # CI: latest build of main, untested
```

The stable and beta casks appear once a tagged release exists. Or open the
DMG and drag Maskrom Studio to Applications. The app is not notarized, so
on first launch:

- macOS 15 and later: open the app once, click Done, then System Settings,
  Privacy and Security, **Open Anyway**.
- macOS 14 and earlier: right-click the app in Applications, choose Open.

MaskROM writing needs no driver on macOS.

Writing an SD card or USB drive asks for an administrator's password (or
Touch ID) once per write, in macOS's own dialog ("Maskrom Studio will erase
... and write the image to it."). The right is for that one drive
(`sys.openfile.readwrite./dev/rdiskN`), opened by Apple's
`/usr/libexec/authopen`; no part of the app runs as root and Full Disk
Access is not needed. If macOS offers to initialise or eject the drive
afterwards, choose Ignore or Eject.

## Linux

- `.deb` and `.rpm`: install with the package manager. They add a udev
  rule so MaskROM writing works without root.
- AppImage: make it executable and run it. For MaskROM writing add the
  udev rule once:

  ```sh
  echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-maskrom-studio.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

Writing an SD card asks for your password (pkexec).

## Coming from WoA RK3576 Imager

The app was called WoA RK3576 Imager before 2026-11-23. On the first start
its settings, theme, language and saved UEFI settings copies are copied
over; its download cache stays where it was and can be deleted. The app id
changed, so install this app, then remove the old one (the .deb and .rpm
do that themselves).

## Updates

At start, at most once a day, the app asks GitHub for its releases. A newer
version shows a notice above the steps with the first line of its notes and
an **Update** button (never while a write runs). Closing the notice hides
that version; Settings still offers it. Settings:

- **Check for a new version once a day**: on or off.
- **Release tier**, Stable by default: **Stable** (newest non-pre-release),
  **Prerelease** (pre-releases vX.Y.Z-beta.N included), **CI** (the rolling
  `ci` release, rebuilt from every green build of main, untested; offered
  when built from another commit than the running copy).
- **Firmware and WinPE**: the same three tiers for the edk2-rk3576 firmware
  and woa-rk3576 WinPE the writes use ([network.md](network.md)). Simple
  mode always uses Stable.
- **Check now**: asks at once and says the result.

Nothing is downloaded until you press Update and then **Download and
install**. Each download is checked against GitHub's SHA-256 and deleted if
it has none or it differs. Then:

| Installed as | Update |
| --- | --- |
| macOS, Homebrew cask | The app runs `brew update` and `brew upgrade --cask` for its cask (`--greedy` for `@nightly`, which is version :latest) as your user, shows the output, then **Restart now**. On failure it shows the error and the command. The tap can lag the release a little. |
| macOS, DMG or install.sh | The DMG goes to Downloads, is mounted out of sight, and its app replaces the running one (or goes to `~/Applications` if the folder cannot be written). Then **Restart now**. If that fails the DMG is opened for you to drag. |
| Windows, installer | The setup program is downloaded and started; the app closes. |
| Linux, AppImage | The new AppImage replaces the old file in one step. Restart. |
| Linux, .deb or .rpm | Installed with apt-get, dnf or zypper through pkexec; otherwise the app shows the command. Restart. |
| Windows zip, unpacked folder | Not updated: the notice links to the release page. |
