# 使用 Maskrom Studio

应用每项功能的具体步骤。[English](../use.md)（本页对应 2026-11-24 的英文版）

截至 2026-11-24，应用的任何功能都还没有在开发板上跑过；下面写的是应用会要求你做什么、它自己做什么。安装应用本身见[安装](install.md)。

## 开始之前

- 装 Windows 需要一个 Windows 11 23H2 ARM64 ISO（见 [Windows 映像](#windows-映像)）。
- 开发板、一根接 MaskROM 口的 USB 线、USB 键盘和显示器。
- 开发板的 SD 卡槽和 USB 口保持空着：固件会先从它们启动，再轮到 eMMC。
- Windows 电脑：先用 Zadig 给 MaskROM 设备装一次 WinUSB 驱动（见[安装](install.md#windows)）。

各开发板进入 MaskROM 的方法（应用的"准备"一步里也有同样的说明）：

- **立创泰山派 3M：** 没有按键。断电，短接 `RK3576` 丝印下方标着 `MSK` 的两个焊盘，用标着 `OTG+DP` 的 USB-C 口连接电脑，然后上电。已经在跑 edk2-rk3576 的板子，也可以在启动倒计时按 F4 进入 MaskROM。
- **ArmSoM CM5-IO：** 按住 MaskROM 键再上电；USB-C 口就是 MaskROM 口。
- **Radxa ROCK 4D：** 用 USB-A 对 USB-A 线，把上方的 USB 3.0 口接到电脑；按住 MaskROM 键再插电源。

## 把 Windows 装到 eMMC

eMMC 上要先有固件，并且是用完整映像写的。还没有的话，先写一次"UEFI 固件，完整映像"（见 [UEFI 固件](#uefi-固件)）。

1. **开发板：** 选择开发板。
2. **做什么：** 选"安装 Windows"（高级模式下：把 Windows 装到 eMMC）。
3. **Windows 映像：** 选择 ISO，或者把它拖进窗口。应用会显示从映像里读到的架构、版本号、启动文件和语言，并列出其中的各个版本；选一个（默认是专业版）。
4. **Windows 设置：**
   - 首次启动："Windows 设置向导（OOBE）"，或者"跳过设置向导，直接创建账户"，填写用户名和密码（以及可选的计算机名、语言、键盘、时区）。
   - OpenSSH 服务器：默认开启；粘贴一行公钥可以免密码登录。
   - 更多驱动：一个含 .inf、.cat、.sys 文件的文件夹，比如 [wddm-mali-g52](https://github.com/gahingwoo/wddm-mali-g52) 或 gt9271。
   - 精简：默认使用推荐的组合（见[精简 Windows](#精简-windows)）。
   - RK3576 工具（监视小组件、NPU 工具）：WinPE 发行版带有工具包时默认安装。
5. **确认：** 检查要清除和写入的内容，按卡片上的说明让开发板进入 MaskROM，然后点"连接并写入"。
6. 应用先读取开发板，显示 eMMC 容量和将要删除的分区。点"清除并写入"。
7. 开发板重启，从 eMMC 启动 WinPE，安装 Windows（20 到 40 分钟），再重启进入 Windows。

如果在开发板上安装失败，WinPE 会停下并显示日志；暂存分区会保留，重启开发板就会再试一次。要彻底放弃，重新写一次"UEFI 固件，完整映像"。

装好后：

- 安装日志在 `C:\Windows\Logs\woa-stage.log`；
- 开启了 SSH 的话，用 `ssh <用户名>@<开发板地址>` 登录，进入的是 cmd.exe；
- 桌面右下角显示"测试模式"：驱动需要测试签名。

### 密码去了哪里

选"跳过设置向导，直接创建账户"时，密码只写进 eMMC 上的应答文件，按 Windows 自己的方式编码（不是明文，但也不是加密），Windows 设置完成后应答文件会被删除。密码不会出现在任何日志里。选了"每次开机自动登录"时，Windows 会像平常设置自动登录那样把密码存在注册表里。

## Windows 映像

测试过的版本是 Windows 11 23H2（版本号 22631）。应用会拒绝：不是 ARM64 的映像、版本号大于 25999 的映像（Windows 11 24H2 及以后需要 ARMv8.1，而 RK3576 是 ARMv8.0）、早于 Windows 10 1809 的映像。Windows 11 21H2 和 Windows 10 可以安装，但会提示没有用当前驱动测试过。

Microsoft 官网的 ARM64 ISO 只有当前版本，太新，用不了。应用的 Windows 一步里列出了可以获取 23H2 ARM64 ISO 的地方：[NTriver](https://ntriver.org/download-windows-11)（中国大陆可用；其中 23H2 ARM64 的是批量许可专业版和 IoT 企业版介质）和 [UUP dump](https://uupdump.net/known.php?q=22631+arm64)（在你自己的电脑上从 Microsoft 更新服务器生成 ISO）。你需要有效的许可证。

在 Windows、macOS 或 Linux 上用 UUP dump 生成映像的详细步骤：[获取 Windows 11 23H2 ARM64 映像](windows-image.md)。

## 磁盘布局

默认情况下 Windows 占满整个磁盘。在高级模式下，Windows 设置一步可以给 Windows 设定大小（至少 32 GB），其余空间建成数据分区（NTFS 或 exFAT），或在末尾留出一部分给 Linux。写入前会显示分区布局。CM5-IO 的 eMMC（约 31 GB）只放得下 Windows。

## 同一块 eMMC 上装 Windows 和 Armbian

适用于泰山派 3M，高级模式，通过 MaskROM 把 Windows 装到 eMMC。在 Windows 设置一步勾选 **同时在 eMMC 上安装 Armbian**，选一个 Armbian 映像（不会替你预先选好；列表是 Armbian 为这块板发布的映像），再设定 Armbian 占用的 eMMC 空间（默认 24 GB；其余给 Windows，Windows 至少 32 GB）。

- Armbian 映像从 Armbian 下载，写入前核对 SHA-256 和签名。只写入它的根分区，放在 eMMC 末尾；它的 U-Boot 放进固件在 32 MiB 处的槽位。UEFI 固件和设置保留。
- Windows 照常安装，到 Armbian 分区之前为止。
- **默认启动 Windows。** 要启动 Armbian，在固件的启动管理器里选 **“Armbian (U-Boot)”**。这次启动运行 Armbian 自己的 U-Boot、内核和设备树；再下一次启动又回到 Windows。把 Armbian 设为默认需要一个尚未发布的固件选项。
- Armbian 里没有预设任何内容：第一次启动时和普通 Armbian 映像一样，会询问 root 密码、用户和时区。
- 不要在这块 eMMC 上的 Armbian 里运行 `armbian-install` 或更新引导程序：那会把 Armbian 的引导程序写到 UEFI 固件上。
- CM5-IO（eMMC 放不下两个系统，固件也还没有这个启动项）和 ROCK 4D（固件在 SPI NOR 上）不支持。

## Windows 第一次进桌面：自检

第一个用户登录后，Windows 等一分半钟再检查自己：设备管理器里没有警告（EC20 模块的 MI_04 接口没有驱动是正常的）、GPU 用的是 WDDM 2.0 驱动且频率不低于 594 MHz（驱动报告频率时）、有可用的声音输出、网络已连接且能解析域名、向系统盘写入 64 MiB 再读回核对。弹窗会说明全部通过，或者列出问题，并可以在浏览器里打开预先填好的 GitHub 问题报告。只有你自己在那里提交时才会发送；报告里没有用户名、计算机名或序列号。报告也会保存到桌面上的 `RK3576-selftest.txt`。

## 精简 Windows

安装 Windows 的同时，应用可以关掉 4 GB 内存的开发板首次启动时忙着做的事：后台运行的应用、OneDrive 自动设置、Copilot、小组件、推荐应用、Edge 后台运行、SysMain；并恢复经典右键菜单。默认使用推荐的组合。高级模式里可以逐项选择，也可以删除 Edge 并安装 Chrome（默认不选）。不会动 Windows 更新、激活、驱动和 WebView2。

每一项做了什么、在运行中的 Windows 里怎么撤销：见[设计文档的"Trimming Windows"](../dev/design.md#trimming-windows)（英文）。

## 其他位置：SD 卡或 NVMe 硬盘

Windows 也可以装到插在电脑读卡器里的 SD 卡，或装在 USB 硬盘盒里的 NVMe 硬盘，写好后再装到开发板上（只限有这个位置的开发板，见 README 里的表）。开发板第一次从它启动时自己安装 Windows。在 Windows 电脑上，应用也可以直接用 DISM 生成装好的 Windows，开发板开机就进入 Windows。

## UEFI 固件

- **完整映像：** 用于新板子，或想让 eMMC 完全重来。会替换分区表、已安装的全部内容和 UEFI 设置。
- **保留分区：** 只写固件，保留分区和设置。
- **升级并保留 Windows**（泰山派 3M、CM5-IO）：应用通过 MaskROM 读出已安装的版本，和新版本一起显示，把开发板的 UEFI 设置保存到电脑，写入新固件时把设置放回去，从不写分区表，并把写入的内容全部读回比较。

简单模式始终写入稳定版；高级模式按"设置"里选的发布类型。

## 回到 Linux 或出厂系统

两者都会替换 eMMC 上的全部内容，包括 Windows 和 UEFI 固件。

- **Armbian：** Armbian 为泰山派 3M 或 CM5-IO 发布的任意映像（Debian 或 Ubuntu，厂商内核或主线内核，带或不带桌面），从 Armbian 下载，用 SHA-256 和 Armbian 的 OpenPGP 签名校验。也可以写到 SD 卡或 U 盘。
- **出厂映像：** 你从开发板厂商下载的 `update.img`。应用会读取它，拒绝其他芯片的包，按 RKDevTool"升级固件"的方式写入。只在高级模式里；还没有在开发板上跑过。

## 在开发板上直接运行

在开发板上从 SD 卡或 U 盘启动 Armbian、Fedora 等 Linux，安装 arm64 的 AppImage 或 .deb 后运行应用。第一页会显示"本机就是开发板"；选"直接写入本机"。写入时会要求管理员密码，写完全部读回比较。装 Windows 的话，写完后关机，拔掉 SD 卡或 U 盘再开机，开发板就会从 eMMC 启动 WinPE。

如果当前系统是从 eMMC 启动的，应用会拒绝写入 eMMC。

## 每次写入前的备份

在会替换 eMMC 开头部分的写入之前，应用会把分区表和固件的 UEFI 设置（如果有）保存到它的数据文件夹下（`nvdata-backups/<开发板>-before-write-<时间>/`，附带记录 SHA-256 的 `backup.txt`）。确认页和结果页会显示这个文件夹。应用里暂时还不能把备份写回去。

## 出错时

任何失败都不会让你从头再来。结果页提供：

- **重试：** 保留所有选择，再做一次同样的任务；重新寻找开发板，已经下载好的文件直接从缓存取。
- **返回步骤**，保留所有选择。
- **报告问题：** 打开一个 GitHub issue，带上版本、系统、失败的步骤和日志的最后几行；主目录、用户名、地址和序列号都会被去掉。
- **保存完整日志**，附在 issue 里。

如果开发板从 USB 上掉了，页面会显示"开发板已断开"，并再次给出它的 MaskROM 步骤。
