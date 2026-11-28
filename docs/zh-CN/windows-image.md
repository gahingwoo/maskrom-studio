# 获取 Windows 11 23H2 ARM64 映像（UUP dump）

[English](../windows-image.md)

Maskrom Studio 需要 **ARM64** 版 Windows 11 **23H2**（版本号 22631）。应用本身不下载、不托管、也不分发 Windows。微软官网的 ARM64 ISO 页面只提供最新版本（24H2 及以后），它们需要 ARMv8.1，不能在 RK3576 上运行。[UUP dump](https://uupdump.net) 可以用微软更新服务器公开的文件，在你自己的电脑上生成 23H2 ARM64 ISO。使用生成的系统需要有效的 Windows 许可证。

更快的办法是直接从 [NTriver](https://ntriver.org/download-windows-11) 下载现成的 ISO，应用向所有人推荐这个来源。本页是另一种办法：自己生成。

## 1. 生成下载包

1. 打开 <https://uupdump.net/known.php?q=22631+arm64>。
2. 选最新的、名称类似 **"Windows 11, version 23H2 (22631.xxxx) arm64"** 的条目。不要选 26100、26200 或标着 Insider 的版本：那些是 24H2 及以后的版本。
3. 选择语言（例如 "Chinese (Simplified)" 或 "English (United States)"），点 Next。
4. 选择版本。只选 **Windows Pro** 就够了；每多一个版本映像就更大。点 Next。
5. 下载方式选 **"Download and convert to ISO"**，保留 "Include updates" 的勾。点 **Create download package**，会下载一个很小的 zip 文件。

## 2. 生成 ISO

把 zip 解压到路径短、不含空格的文件夹，并留出约 20 GB 空间。生成过程需要 20 到 60 分钟，取决于网速。

- **Windows**（x64 或 ARM64）：运行 `uup_download_windows.cmd`，允许它以管理员身份运行。
- **Linux**：安装 `aria2`、`cabextract`、`wimtools`（wimlib）、`chntpw` 和 `genisoimage`（Debian/Ubuntu 的包名），然后运行 `bash uup_download_linux.sh`。
- **macOS**：`brew install aria2 cabextract wimlib cdrtools`，然后运行 `bash uup_download_macos.sh`。

结果是同一个文件夹里的一个 ISO，文件名类似 `22631.xxxx_CLIENT_PROFESSIONAL_A64FRE_ZH-CN.ISO`。

## 3. 使用

在应用的 "Windows 映像" 步骤里选择这个 ISO（或者把它拖进窗口）。应用会先读取映像，如果不是 ARM64 或不是支持的版本，会在动开发板之前告诉你。

应用的 Windows 步骤里还列出了其他提供 23H2 ARM64 ISO 的来源（每个都注明最后核对的日期）。

## Windows 10 22H2

步骤相同，从 <https://uupdump.net/known.php?q=19045+arm64> 开始：选最新的 **"Feature update to Windows 10, version 22H2 (19045.xxxx) arm64"**。Windows 10 暂时不能用 NVMe 硬盘和 Wi-Fi（它们的 Windows 10 驱动还没有发布）；推荐 Windows 11 23H2。
