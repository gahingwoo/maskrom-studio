# Installing Maskrom Studio

Get the package for your system from the
[releases](https://github.com/gahingwoo/maskrom-studio/releases), or on macOS and
Linux run:

```sh
curl -fsSL https://raw.githubusercontent.com/gahingwoo/maskrom-studio/main/install.sh | sh
```

The script picks the package for the system and checks the download against
the SHA-256 GitHub publishes for it. It installs the newest normal release.
To get the newest beta version instead (a pre-release on GitHub, such as
0.1.5-beta.1), run it with `BETA=1`:

```sh
curl -fsSL https://raw.githubusercontent.com/gahingwoo/maskrom-studio/main/install.sh | BETA=1 sh
```

While no normal release exists yet, the script installs the newest beta and
says so.

The packages do not include Rockchip's Maskrom loader. The first Maskrom
write downloads its pieces from Rockchip's rkbin repository
(raw.githubusercontent.com), checks them against pinned SHA-256 sums and keeps
the loader in the app's user data folder (`loaders/`), so that first write
needs an internet connection.

The packages are not signed with a paid certificate, so each system warns
the first time.

## Windows

1. Run `maskrom-studio-<version>-windows-x64-setup.exe`.
2. Windows SmartScreen says "Windows protected your PC". Click
   **More info**, then **Run anyway**.

The zip holds the same app without an installer.

For Maskrom writing Windows needs the WinUSB driver for the board:

1. Put the board in Maskrom mode and connect it (see the app's Review
   page).
2. Download Zadig from https://zadig.akeo.ie/ and run it.
3. Choose the device whose USB ID starts with 2207 (Options, List All
   Devices, if it is not shown), select **WinUSB** and click
   **Install Driver**.

This is needed once per computer. Whether the app could install the driver
itself (with libwdi, which Zadig is built on) has not been tested yet.

## macOS

With Homebrew, from the tap gahingwoo/tap, one cask per release tier:

```sh
brew trust gahingwoo/tap
brew install --cask gahingwoo/tap/maskrom-studio           # Stable
brew install --cask gahingwoo/tap/maskrom-studio@beta      # Prerelease
brew install --cask gahingwoo/tap/maskrom-studio@nightly   # CI: the latest build of main, untested
```

Install one of the three; they conflict with each other. The stable and beta
casks appear once a tagged release exists. Or by hand: open the DMG and drag
Maskrom Studio to Applications. On first launch macOS
may say the app cannot be opened, because it is not notarized:

- macOS 15 and later: open the app once, click Done, then System Settings,
  Privacy and Security, **Open Anyway**.
- macOS 14 and earlier: right-click the app in Applications, choose Open.

macOS needs no driver for Maskrom writing.

Writing an SD card or USB drive asks for an administrator's password (or
Touch ID) once per write, in the dialog of macOS itself. The dialog carries
the sentence "Maskrom Studio will erase ... and write the image to it." with
the name of the drive. The right you grant is for that one drive
(`sys.openfile.readwrite./dev/rdiskN`): Apple's `/usr/libexec/authopen`
opens it, and no part of Maskrom Studio runs as root. Full Disk Access is not
needed, and the app does not ask for it. If macOS offers to initialise or
eject the drive when the write is done, choose Ignore or Eject.

## Linux

- `.deb` (Debian, Ubuntu) and `.rpm` (Fedora, openSUSE): install with the
  package manager. They install a udev rule so the board can be written in
  Maskrom mode without root.
- AppImage: make it executable and run it. For Maskrom writing add the udev
  rule once:

  ```sh
  echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-maskrom-studio.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

Writing an SD card asks for your password (pkexec), as Etcher does.

## The Windows image

The app does not download Windows. Give it a Windows 11 23H2 ARM64 ISO, or
the `install.wim` or `install.esd` from one, on the **Windows image** step
(or drop the file on the window). It reads the editions from the image and
refuses x64 images and builds newer than 25999 (Windows 11 24H2 and later
cannot run on RK3576, which is ARMv8.0). An ISO is read in place: the app
finds `sources\install.wim` inside it and never copies the file.

## Updates

The app asks GitHub for the list of Maskrom Studio releases when it starts,
at most once a day. When a newer version is out, a notice above the steps
names it, with the first line of its release notes, a link to the notes and
an **Update** button. Closing the notice hides that version; Settings still
offers it. No notice appears while a write is running. In Settings:

- **Check for a new version once a day** turns the check off or on.
- **Release tier**, Stable by default:
  - **Stable**: the newest release that is not a pre-release.
  - **Prerelease**: the newest release, pre-releases (vX.Y.Z-beta.N) included.
  - **CI**: the rolling release tagged `ci`, rebuilt from every successful
    build of main and untested; offered when it was built from another
    commit than the copy you run.
- **Firmware and WinPE** in Settings uses the same three tiers for the
  edk2-rk3576 firmware and the woa-rk3576 WinPE the writes use (see
  [network.md](network.md)). Simple mode always uses Stable.
- **Check now** asks at once and answers in words: the new version, "You
  have the newest version", or that GitHub could not be reached.

Nothing is downloaded or installed until you press Update and then
**Download and install**. Every download is compared with the SHA-256 that
GitHub lists for the file; a file without one, or with a different one, is
deleted and not installed. The download shows its progress and can be
cancelled. What happens then depends on how the app was installed:

| Installed as | Update |
| --- | --- |
| macOS, Homebrew cask | The app runs Homebrew for you, as your user: `brew update`, then `brew upgrade --cask` with the cask that installed it (`maskrom-studio`, `maskrom-studio@beta`, or `--greedy maskrom-studio@nightly`, which is version :latest). Its output is in the dialog. Then **Restart now**. If Homebrew is not found or fails, the dialog shows its error and the command to copy. Homebrew only has a new version once its tap lists it, which can be a little after the release. |
| macOS, DMG or install.sh | The DMG for this Mac's CPU goes to the Downloads folder, is mounted out of sight, and its app is copied in place of the running one (into `~/Applications` if the app's folder cannot be written). Then **Restart now**. The old app is kept until the new one is in place. If that is not possible the DMG is opened and you drag the app yourself. |
| Windows, installer | The setup program is downloaded and started, and Maskrom Studio closes so that it can be replaced. |
| Linux, AppImage | The new AppImage is downloaded into the same folder and put in place of the old file in one step. Restart the app. |
| Linux, .deb or .rpm | The package is downloaded and installed with apt-get, dnf or zypper through pkexec, which asks for your password. If that is not possible the app shows the command to run in a terminal. Restart the app. |
| Windows zip, an unpacked folder | Not updated by the app: the notice links to the release page. |

