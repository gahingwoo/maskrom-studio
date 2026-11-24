# 安装 Maskrom Studio

[English](../install.md)（本页对应 2026-11-24 的英文版）

从 [Releases](https://github.com/gahingwoo/maskrom-studio/releases) 下载对应系统的安装包；macOS 和 Linux 上也可以运行：

```sh
curl -fsSL https://raw.githubusercontent.com/gahingwoo/maskrom-studio/main/install.sh | sh
```

脚本会挑选适合本机的安装包，并用 GitHub 公布的 SHA-256 校验下载。它安装最新的正式版。要安装最新的测试版（GitHub 上的预发布版，比如 0.1.5-beta.1），加上 `BETA=1`：

```sh
curl -fsSL https://raw.githubusercontent.com/gahingwoo/maskrom-studio/main/install.sh | BETA=1 sh
```

还没有正式版时，脚本会安装最新的测试版，并说明这一点。

安装包不包含 Rockchip 的 MaskROM loader。第一次 MaskROM 写入时，应用会从 Rockchip 的 rkbin 仓库（raw.githubusercontent.com）下载所需文件，用固定的 SHA-256 校验，并把 loader 保存在应用的用户数据文件夹（`loaders/`）里，所以第一次写入需要联网。

安装包没有用付费证书签名，所以每个系统第一次运行时都会提示。

## Windows

1. 运行 `maskrom-studio-<版本>-windows-x64-setup.exe`。
2. Windows SmartScreen 提示"Windows 已保护你的电脑"。点**更多信息**，再点**仍要运行**。

zip 包里是同样的应用，只是没有安装程序。

Windows 上进行 MaskROM 写入需要给开发板装 WinUSB 驱动：

1. 让开发板进入 MaskROM 模式并连上电脑（简单模式的"准备"一步，或高级模式的"检查"一步会说明怎么做；在 Windows 上那里也列出了下面这些步骤）。
2. 从 https://zadig.akeo.ie/ 下载 Zadig 并运行。
3. 选择 USB ID 以 2207 开头的设备（如果没显示，点 Options，勾选 List All Devices），选 **WinUSB**，点 **Install Driver**。

每台电脑只需要做一次。应用能否自己安装这个驱动（用 Zadig 所基于的 libwdi）还没有测试过。

## macOS

用 Homebrew，从 gahingwoo/tap 安装，每种发布类型一个 cask：

```sh
brew trust gahingwoo/tap
brew install --cask gahingwoo/tap/maskrom-studio           # 稳定版
brew install --cask gahingwoo/tap/maskrom-studio@beta      # 预发布版
brew install --cask gahingwoo/tap/maskrom-studio@nightly   # CI：main 的最新构建，未经测试
```

三者只能装一个。稳定版和测试版的 cask 要等有了带标签的发行版才会出现。也可以手动安装：打开 DMG，把 Maskrom Studio 拖进"应用程序"。第一次打开时 macOS 可能提示无法打开，因为应用没有经过公证：

- macOS 15 及以后：先打开一次应用，点"完成"，然后在"系统设置"的"隐私与安全性"里点**仍要打开**。
- macOS 14 及以前：在"应用程序"里右键点应用，选"打开"。

macOS 上进行 MaskROM 写入不需要驱动。

写入 SD 卡或 U 盘时，每次写入会在 macOS 自己的对话框里要求一次管理员密码（或 Touch ID）。对话框里写着"Maskrom Studio will erase ... and write the image to it."和驱动器的名字。你授予的权限只针对这一个驱动器（`sys.openfile.readwrite./dev/rdiskN`）：由 Apple 的 `/usr/libexec/authopen` 打开它，Maskrom Studio 没有任何部分以 root 身份运行。不需要"完全磁盘访问权限"，应用也不会请求。写完后如果 macOS 提示初始化或推出驱动器，选"忽略"或"推出"。

## Linux

- `.deb`（Debian、Ubuntu）和 `.rpm`（Fedora、openSUSE）：用包管理器安装。它们会装好 udev 规则，不需要 root 就能在 MaskROM 模式下写入。
- AppImage：加上可执行权限后运行。要进行 MaskROM 写入，先添加一次 udev 规则：

  ```sh
  echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-maskrom-studio.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

写入 SD 卡时会要求输入你的密码（pkexec），和 Etcher 一样。

## 从早期版本升级

第一次启动时，早期版本数据文件夹里的设置、主题和语言、UEFI 设置备份会被复制过来（2026-11-23 之前应用叫 WoA RK3576 Imager）。它的下载缓存留在原处，可以删掉。应用 ID 变了，所以早期版本不会被原地更新：先安装这个版本，再删除旧应用（.deb 和 .rpm 会自动处理）。

## Windows 映像

应用不下载 Windows。在 **Windows 映像** 一步里提供一个 Windows 11 23H2 ARM64 ISO，或其中的 `install.wim` / `install.esd`（也可以把文件拖进窗口）。应用会读取映像中的版本，拒绝 x64 映像和版本号大于 25999 的映像（Windows 11 24H2 及以后无法在 ARMv8.0 的 RK3576 上运行）。ISO 会被原地读取：应用在里面找到 `sources\install.wim`，不会复制整个文件。

## 更新

应用启动时会向 GitHub 查询 Maskrom Studio 的发行版，每天最多一次。有新版本时，步骤上方会出现提示，写明版本号和发行说明的第一行，附带说明链接和**更新**按钮。关闭提示会隐藏这个版本；"设置"里仍然可以更新。写入进行中不会出现提示。在"设置"里：

- **每天检查一次新版本**：打开或关闭检查。
- **发布类型**，默认稳定版：
  - **稳定版**：最新的非预发布版本。
  - **预发布版**：最新的版本，包括预发布版本（vX.Y.Z-beta.N）。
  - **CI**：标签为 `ci` 的滚动发行版，由 main 的每次成功构建重建，未经测试；当它和你正在运行的版本来自不同提交时才会提示。
- "设置"里的**固件和 WinPE** 对应用写入的 edk2-rk3576 固件和 woa-rk3576 WinPE 使用同样的三种类型（见 [network.md](../network.md)，英文）。简单模式始终使用稳定版。
- **立即检查**：马上查询，并用文字告诉你结果：新版本号、"已是最新版本"，或者无法连接 GitHub。

在你点**更新**、再点**下载并安装**之前，不会下载或安装任何东西。每个下载都会和 GitHub 列出的 SHA-256 比较；没有校验值或校验值不同的文件会被删除，不会安装。下载会显示进度，也可以取消。接下来怎么做取决于应用的安装方式：

| 安装方式 | 更新 |
| --- | --- |
| macOS，Homebrew cask | 应用以你的身份替你运行 Homebrew：`brew update`，然后对安装它的 cask 运行 `brew upgrade --cask`（`maskrom-studio`、`maskrom-studio@beta`，或 `--greedy maskrom-studio@nightly`，它的版本是 :latest）。输出显示在对话框里。然后点**立即重启**。如果找不到 Homebrew 或它失败了，对话框会显示错误和可复制的命令。Homebrew 要等它的 tap 列出新版本才有更新，可能比发行版晚一点。 |
| macOS，DMG 或 install.sh | 适合本机 CPU 的 DMG 下载到"下载"文件夹，在后台挂载，用其中的应用替换正在运行的应用（如果应用所在文件夹不可写，就放到 `~/Applications`）。然后点**立即重启**。新应用就位之前旧应用会保留。如果做不到，会打开 DMG 让你自己拖。 |
| Windows，安装程序 | 下载并启动安装程序，Maskrom Studio 关闭以便被替换。 |
| Linux，AppImage | 新的 AppImage 下载到同一个文件夹，一步替换旧文件。重启应用。 |
| Linux，.deb 或 .rpm | 下载安装包，通过 pkexec 用 apt-get、dnf 或 zypper 安装，会要求输入密码。做不到时应用会显示要在终端里运行的命令。重启应用。 |
| Windows zip，解压出来的文件夹 | 应用不会自己更新：提示里链接到发行版页面。 |
