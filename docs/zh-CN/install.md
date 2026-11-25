# 安装 Maskrom Studio

[English](../install.md)

Windows（x64、arm64）、macOS 和 Linux（AppImage、.deb、.rpm；x86_64 和 arm64）的安装包在 [Releases](https://github.com/gahingwoo/maskrom-studio/releases) 页面。macOS 和 Linux 上也可以运行：

```sh
curl -fsSL https://raw.githubusercontent.com/gahingwoo/maskrom-studio/main/install.sh | sh
```

脚本挑选适合本机的安装包，用 GitHub 公布的 SHA-256 校验，安装最新的正式版。加 `BETA=1`（`... | BETA=1 sh`）安装最新的预发布版（比如 0.1.5-beta.1）。还没有正式版时，脚本安装最新的测试版并说明这一点。

安装包不包含 Rockchip 的 MaskROM loader。第一次 MaskROM 写入时，应用从 rockchip-linux/rkbin（raw.githubusercontent.com）下载所需文件，用固定的 SHA-256 校验，把 loader 保存在应用数据文件夹（`loaders/`）里，所以第一次写入需要联网。

安装包没有用付费证书签名，所以每个系统第一次运行时都会提示。

## Windows

1. 运行 `maskrom-studio-<版本>-windows-x64-setup.exe`（zip 包里是同样的应用，没有安装程序）。
2. SmartScreen 提示"Windows 已保护你的电脑"：点**更多信息**，再点**仍要运行**。

MaskROM 写入需要 WinUSB 驱动，每台电脑装一次：

1. 让开发板进入 MaskROM 模式并连上电脑（简单模式的"准备"一步或高级模式的"检查"一步有说明，也列出了下面这些步骤）。
2. 从 https://zadig.akeo.ie/ 下载 Zadig 并运行。
3. 选择 USB ID 以 2207 开头的设备（没显示的话点 Options，勾选 List All Devices），选 **WinUSB**，点 **Install Driver**。

应用不会自己安装这个驱动。Windows on Arm 上的 Zadig 还没有测试过。

## macOS

用 Homebrew，每种发布类型一个 cask（只装一个，它们互相冲突）：

```sh
brew trust gahingwoo/tap
brew install --cask gahingwoo/tap/maskrom-studio           # 稳定版
brew install --cask gahingwoo/tap/maskrom-studio@beta      # 预发布版
brew install --cask gahingwoo/tap/maskrom-studio@nightly   # CI：main 的最新构建，未经测试
```

稳定版和测试版的 cask 要等有了带标签的发行版才会出现。也可以打开 DMG，把 Maskrom Studio 拖进"应用程序"。应用没有经过公证，第一次打开时：

- macOS 15 及以后：先打开一次应用，点"完成"，然后在"系统设置"的"隐私与安全性"里点**仍要打开**。
- macOS 14 及以前：在"应用程序"里右键点应用，选"打开"。

macOS 上 MaskROM 写入不需要驱动。

写入 SD 卡或 U 盘时，每次写入会在 macOS 自己的对话框里要求一次管理员密码（或 Touch ID），对话框写着"Maskrom Studio will erase ... and write the image to it."。权限只针对这一个驱动器（`sys.openfile.readwrite./dev/rdiskN`），由 Apple 的 `/usr/libexec/authopen` 打开；应用没有任何部分以 root 身份运行，也不需要"完全磁盘访问权限"。写完后如果 macOS 提示初始化或推出驱动器，选"忽略"或"推出"。

## Linux

- `.deb` 和 `.rpm`：用包管理器安装。它们会装好 udev 规则，不需要 root 就能进行 MaskROM 写入。
- AppImage：加上可执行权限后运行。要进行 MaskROM 写入，先添加一次 udev 规则：

  ```sh
  echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-maskrom-studio.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

写入 SD 卡时会要求输入你的密码（pkexec）。

## 从 WoA RK3576 Imager 升级

2026-11-23 之前应用叫 WoA RK3576 Imager。第一次启动时，它的设置、主题、语言和 UEFI 设置备份会被复制过来；下载缓存留在原处，可以删掉。应用 ID 变了，所以先安装这个应用，再删除旧应用（.deb 和 .rpm 会自动处理）。

## 更新

应用启动时向 GitHub 查询自己的发行版，每天最多一次。有新版本时，步骤上方出现提示，写明发行说明的第一行，带**更新**按钮（写入进行中不会出现）。关闭提示会隐藏这个版本；"设置"里仍然可以更新。"设置"里：

- **每天检查一次新版本**：打开或关闭。
- **发布类型**，默认稳定版：**稳定版**（最新的非预发布版本）、**预发布版**（包括 vX.Y.Z-beta.N）、**CI**（滚动的 `ci` 发行版，由 main 的每次成功构建重建，未经测试；和正在运行的版本来自不同提交时才提示）。
- **固件和 WinPE**：对写入用的 edk2-rk3576 固件和 woa-rk3576 WinPE 使用同样的三种类型（见 [network.md](../network.md)，英文）。简单模式始终用稳定版。
- **立即检查**：马上查询并告诉你结果。

点**更新**、再点**下载并安装**之前不会下载任何东西。每个下载都用 GitHub 的 SHA-256 校验，没有校验值或不一致就删除。然后：

| 安装方式 | 更新 |
| --- | --- |
| macOS，Homebrew cask | 应用以你的身份运行 `brew update` 和对应 cask 的 `brew upgrade --cask`（`@nightly` 加 `--greedy`，它的版本是 :latest），显示输出，然后点**立即重启**。失败时显示错误和命令。tap 可能比发行版晚一点。 |
| macOS，DMG 或 install.sh | DMG 下载到"下载"文件夹，在后台挂载，用其中的应用替换正在运行的应用（文件夹不可写时放到 `~/Applications`）。然后点**立即重启**。做不到时打开 DMG 让你自己拖。 |
| Windows，安装程序 | 下载并启动安装程序，应用关闭。 |
| Linux，AppImage | 新的 AppImage 一步替换旧文件。重启应用。 |
| Linux，.deb 或 .rpm | 通过 pkexec 用 apt-get、dnf 或 zypper 安装；做不到时显示命令。重启应用。 |
| Windows zip、解压出来的文件夹 | 不会自己更新：提示里链接到发行版页面。 |
