# 使用 Maskrom Studio

[English](../use.md)。安装应用本身见[安装](install.md)。

界面有英文和简体中文，默认跟随系统语言，顶部可以切换。**简单模式**（默认）四个步骤，全部用推荐设置：开发板、做什么、准备、确认。**高级模式**有全部选项：固件的各种写法、磁盘布局、SD 卡和 U 盘、发布类型、WinPE 启动 U 盘、出厂映像。

## 开始之前

- 装 Windows 需要一个 Windows 11 23H2 ARM64 ISO（见 [Windows 映像](#windows-映像)）。
- 开发板、一根接 MaskROM 口的 USB 线、USB 键盘和显示器。
- 开发板的 SD 卡槽和 USB 口保持空着：固件会先从它们启动，再轮到 eMMC。
- Windows 电脑：先用 Zadig 装一次 WinUSB 驱动（见[安装](install.md#windows)）。

各开发板进入 MaskROM 的方法（"准备"一步里也有）：

- **立创泰山派 3M：** 没有按键。断电，短接 `RK3576` 丝印下方的两个 `MSK` 焊盘，用标着 `OTG+DP` 的 USB-C 口连电脑，上电。已经装了 edk2-rk3576 的板子，也可以在启动倒计时按 F4。
- **ArmSoM CM5-IO：** 按住 MaskROM 键再上电；USB-C 口就是 MaskROM 口。
- **Radxa ROCK 4D：** 用 USB-A 对 USB-A 线，把上方的 USB 3.0 口接到电脑；按住 MaskROM 键再插电源。

"准备"页有一行实时状态，检测到 MaskROM 模式的 RK3576（2207:350e）时变绿。所有 RK3576 开发板的 USB ID 相同，请自己核对是不是选中的那块板。在 Windows 上，缺 WinUSB 驱动时它会提示。

## 把 Windows 装到 eMMC

eMMC 上要先有用完整映像写入的固件。没有的话，先写一次"UEFI 固件，完整映像"（见 [UEFI 固件](#uefi-固件)）。

1. **开发板。**
2. **做什么：** "安装 Windows"（高级模式：把 Windows 装到 eMMC）。
3. **Windows 映像：** 选择或拖入 ISO（或 install.wim / install.esd）。应用显示读到的内容并列出各个版本；默认专业版。
4. **Windows 设置：**
   - 首次启动："Windows 设置向导（OOBE）"，或"跳过设置向导，直接创建账户"，填用户名和密码（可选计算机名、语言、键盘、时区）。语言、键盘和时区从列表中选，可输入名称或代码搜索；时区默认是本机的，语言默认按本机区域（映像没有这个语言时用映像自己的）。
   - 自动登录（只在"跳过设置向导"时可选，默认关闭）：每次开机都自动登录，不只是第一次。
   - OpenSSH 服务器：默认开启；粘贴公钥可以免密码登录。
   - 驱动：自动安装。应用下载 woa-rk3576 发布页上的 RK3576 驱动包（`rk3576-drivers-arm64.zip`），校验后按板子安装：每块板子都装存储、以太网、GPU、视频解码、NPU、音频等，泰山派 3M 另装触摸屏和蓝牙，CM5-IO 和 ROCK 4D 另装电源键，ROCK 4D 另装 EEPROM。没有驱动包的发布版装 WinPE 映像自带的驱动（没有 GPU 和 NPU）。
   - 添加驱动文件夹（可选）：只用于驱动包里没有的驱动，选一个含 .inf、.cat、.sys 的文件夹。
   - 精简：推荐组合（见[精简 Windows](#精简-windows)）。
   - RK3576 工具（监视小组件、NPU 工具）：WinPE 发行版带有时默认安装。
5. **确认：** 检查要清除的内容，勾选，让开发板进入 MaskROM，然后开始。
6. 应用读取开发板，显示 eMMC 容量和要删除的分区。点"清除并写入"。
7. 开发板重启，从 eMMC 启动 WinPE，安装 Windows（20 到 40 分钟），再重启进入 Windows。

开发板上安装失败时，WinPE 停下并显示日志；暂存分区保留，重启就再试一次。要放弃，重新写一次"UEFI 固件，完整映像"。

装好后：日志在 `C:\Windows\Logs\woa-stage.log`；开了 SSH 的话 `ssh <用户名>@<开发板地址>` 进入 cmd.exe；桌面显示"测试模式"，因为驱动是测试签名的。Windows 按 UTC 读取时钟，每次开机后校时。

**密码去了哪里。** 选"跳过设置向导"时，密码只写进应答文件，按 Windows 的方式编码（不是加密），设置完成后应答文件被删除。密码不会写进日志。选"自动登录"时，第一次登录后运行一次的任务把密码存为 Windows 自动登录读取的 LSA 机密（和 Sysinternals Autologon 一样），然后删除任务和它的那份密码。

## Windows 映像

测试过的版本是 Windows 11 23H2（版本号 22631）。会被拒绝：不是 ARM64 的映像、版本号大于 25999 的（24H2 及以后需要 ARMv8.1）、早于 Windows 10 1809 的、PC 用的 ISO（有 bootx64.efi 没有 bootaa64.efi）。Windows 11 21H2 和 Windows 10 可以装，但会提示没有用当前驱动测试过。ISO 原地读取，不会复制。

Microsoft 官网的 ARM64 ISO 只有当前版本，太新。应用的 Windows 一步列出了 23H2 ARM64 的来源：[NTriver](https://ntriver.org/download-windows-11)（推荐：可直接下载，在中国大陆也能用；批量许可专业版和 IoT 企业版介质）和 [UUP dump](https://uupdump.net/known.php?q=22631+arm64)，后者在你自己的电脑上从 Microsoft 更新服务器生成 ISO（[详细步骤](windows-image.md)）。你需要有效的许可证。

## 磁盘布局

默认 Windows 占满整个磁盘。高级模式下可以给 Windows 设定大小（至少 32 GB），其余建成数据分区（NTFS 或 exFAT），或在末尾留一部分给 Linux。写入前会显示布局。CM5-IO 的 eMMC（约 31 GB）只放得下 Windows。

## 同一块 eMMC 上装 Windows 和 Armbian

泰山派 3M，高级模式，通过 MaskROM 把 Windows 装到 eMMC。在 Windows 设置一步勾选 **同时在 eMMC 上安装 Armbian**，选一个 Armbian 映像（不会预先选好），设定 Armbian 的空间（默认 24 GB；其余给 Windows，至少 32 GB）。

- 映像用 Armbian 的 SHA-256 和签名校验。只写入它的根分区，放在 eMMC 末尾；它的 U-Boot 放进固件在 32 MiB 处的槽位。UEFI 固件和设置保留。
- 默认启动 Windows。要启动 Armbian，在固件的启动管理器里选 **"Armbian (U-Boot)"**；这次运行 Armbian 自己的 U-Boot、内核和设备树，下一次启动又回到 Windows。
- Armbian 第一次启动时和普通映像一样询问 root 密码、用户和时区。不要同时在开发板上插一张写有同一个 Armbian 映像的 SD 卡：两者的文件系统 UUID 相同。
- 不要在这块 eMMC 的 Armbian 里运行 `armbian-install` 或更新引导程序：会覆盖 UEFI 固件。
- CM5-IO 不支持（eMMC 太小，固件也还没有这个启动项）。

## ROCK 4D：Windows 装到 NVMe，Armbian 写到 SD 卡

高级模式，把 Windows 装到 NVMe 硬盘（装在硬盘盒里接到电脑）。在 Windows 设置一步勾选 **同时把 Armbian 写到一张 SD 卡上**，选一个 Armbian 映像（厂商或 edge 内核）。最后一页选 NVMe 硬盘和 SD 卡；Armbian 占用整张卡。

- **需要新固件。** 只有用新版 U-Boot SPL（U-Boot v2026.10，单次启动请求放在 SD 卡上）构建的固件，ROCK 4D 才能从卡启动 Armbian。截至 2026-11-26，edk2-rk3576 还没有带它的发布版（在 `rock4d-parity` 分支上）。点开始后先通过 MaskROM 读取开发板上的 SPL，没有就停下，什么都不写。
- 启动方式：平时从 NVMe 硬盘启动 Windows。在启动管理器（倒计时期间按 Esc 或 F2）里选 **"Armbian (U-Boot)"**：固件在卡上写一个一次性的请求并重启，SPL 擦掉请求，从卡上加载 Armbian 的 U-Boot。下一次启动又回到 Windows。只有卡插着时才列出这一项。
- 等 Windows 装完再插卡。Windows 提示格式化这张卡时选否。
- 在 Armbian 里不要运行 `armbian-install`，也不要用 `armbian-config` 的引导程序更新：它们可能覆盖 SPI NOR 闪存上的固件。

## Windows 第一次进桌面：自检

第一次登录一分半钟后，Windows 检查：设备管理器没有警告（EC20 模块的 MI_04 没有驱动是正常的）、GPU 用 WDDM 2.0 且频率不低于 594 MHz（驱动报告频率时）、有声音输出、网络能解析域名、向系统盘写入 64 MiB 再读回核对。弹窗显示完整报告，可以打开预先填好的 GitHub 问题报告（不含用户名、计算机名和序列号）；只有你自己提交才会发送。报告也保存在桌面的 `RK3576-selftest.txt`。

## 精简 Windows

推荐组合（默认开启；简单模式一个开关，高级模式逐项列出）：删除后台应用、OneDrive 自动设置、Copilot 和小组件，关闭推荐应用、Edge 后台运行和 SysMain，延迟启动搜索索引，诊断数据设为"必需"，恢复经典右键菜单，不让 Windows 更新安装驱动，安装 Chrome arm64 作为默认浏览器。Edge 保留：它是有硬件视频解码的浏览器。删除 Edge 和删除应用商店是可选项，默认不选。不会动 Windows 更新本身、激活、驱动和 WebView2。每一项做了什么、怎么撤销：见[设计文档的"Trimming Windows"](../dev/design.md#trimming-windows)（英文）。

## 让 Edge、Chrome 和 WebView2 用上 GPU

GPU 驱动处于 WDDM 2.x（默认）时，Edge 和 Chrome 只有用 `--disable-direct-composition` 启动才会用 GPU 渲染。每次安装都带上 woa-rk3576 的开关：把这个参数加到开始菜单、桌面和任务栏快捷方式、打开链接和 PDF 的命令以及 WebView2 的参数里，并关掉 Edge 的启动增强和两个浏览器的后台运行。计划任务（`\RK3576\Browser GPU`）在浏览器更新后把参数加回去，GPU 不是 WDDM 2.x 时把它去掉。你自己装的 Chrome 也一样适用。

在板子上关掉：`HKLM\SOFTWARE\RK3576\BrowserGpu` 中 `Mode` = 0（DWORD），或在管理员命令提示符中运行 `powershell -ExecutionPolicy Bypass -File "%ProgramFiles%\RK3576\browser-gpu\rk3576-browser-gpu.ps1" -Action Disable`（`-Action Uninstall` 卸掉）。详情见 [woa-rk3576 的 BROWSER-GPU.zh-CN.md](https://github.com/gahingwoo/woa-rk3576/blob/main/tools/rk3576-tools/BROWSER-GPU.zh-CN.md)。

## 其他位置：SD 卡或 NVMe 硬盘

Windows 也可以装到电脑读卡器里的 SD 卡，或 USB 硬盘盒里的 NVMe 硬盘，写好后装到开发板上（只限有这个位置的开发板，见 README 的表）。开发板第一次从它启动时自己安装 Windows。在 Windows 电脑上，应用也可以直接用 DISM 生成装好的 Windows（需要管理员权限）。Windows 本身不能装到 U 盘。

## UEFI 固件

- **完整映像：** 用于新板子或让 eMMC 重来。替换分区表、已安装的全部内容和 UEFI 设置。
- **保留分区：** 只写固件，分区和设置保留。
- **升级并保留 Windows**（泰山派 3M、CM5-IO）：通过 MaskROM 读出已安装的版本，和新版本一起显示，把 UEFI 设置保存到电脑，写入新固件时把设置放回去，从不写分区表，写入的内容全部读回比较。"重置设置"则按映像原样写入。
- **Radxa ROCK 4D**（固件在 16 MiB 的 SPI NOR 上，只在高级模式里）："UEFI 固件"重写整个闪存，设置会重置。"UEFI 固件，保留设置"只写第 0 到 32255 扇区，设置（0xFC0000 到末尾）不动；闪存上还没有 edk2-rk3576 固件时会拒绝。两者都明确选中 SPI NOR，引导组件报告的是别的存储（UFS 模块）时就停下，先把整个闪存复制到电脑，写入的内容全部读回比较。硬盘从不写入。

简单模式始终写稳定版；高级模式按"设置"里的发布类型。

## 回到 Linux 或出厂系统

两者都会替换 eMMC 上的全部内容，包括 Windows 和固件。

- **Armbian：** Armbian 为泰山派 3M 或 CM5-IO 发布的任意映像（Debian 或 Ubuntu，厂商或 edge 内核，带或不带桌面），用 SHA-256 和 Armbian 的 OpenPGP 签名校验。也可以写到 SD 卡或 U 盘。CM5-IO 只有在 eMMC 上没有引导程序时才从这样的卡启动；泰山派 3M 自己从不从 SD 卡启动。
- **出厂映像**（只在高级模式）：开发板厂商的 `update.img`。应用拒绝其他芯片的包，按 RKDevTool"升级固件"的方式写入。

## 在开发板上直接运行

在开发板上从 SD 卡或 U 盘启动 Linux，安装 arm64 的 AppImage 或 .deb 后运行应用。第一页显示"本机就是开发板"；选"直接写入本机"。写入时要求管理员密码，写完全部读回比较。装 Windows 的话，写完关机，拔掉 SD 卡或 U 盘再开机，开发板从 eMMC 启动 WinPE。当前系统在 eMMC 上时，应用拒绝写 eMMC。ROCK 4D 的 SPI NOR 需要内核把它显示为 `/dev/mtd0`，否则应用会指向 MaskROM。

## 每次写入前的备份

在会替换 eMMC 开头部分的写入之前，应用把分区表和固件的 UEFI 设置（如果有）保存到数据文件夹下的 `nvdata-backups/<开发板>-before-write-<时间>/`，附带记录 SHA-256 的 `backup.txt`。确认页和结果页会显示这个文件夹。存不下来就不写入。应用里暂时还不能把备份写回去。

## 已知问题

**打开 .txt 文件时提示 "Package failed updates, dependency or conflict validation."** 出现在此修复之前、用 22621 ARM64 介质安装的开发板上：映像里的记事本应用只有 x64 版，它需要的 x64 框架（Microsoft.UI.Xaml.2.7）不在映像里，所以重新注册这个应用没有用。可以从应用商店安装最新的记事本（arm64）：

```powershell
Start-Process 'ms-windows-store://pdp/?ProductId=9MSMLRH6LZF3'
```

或者不联网，删掉这个坏掉的应用，让 .txt 用经典的 notepad.exe 打开（以管理员身份运行 PowerShell）：

```powershell
Get-AppxPackage -AllUsers Microsoft.WindowsNotepad | Remove-AppxPackage -AllUsers; Get-AppxProvisionedPackage -Online | Where-Object DisplayName -eq Microsoft.WindowsNotepad | Remove-AppxProvisionedPackage -Online
```

新安装的系统会自动做第二种处理。

## 出错时

任何失败都不会让你从头再来。结果页提供**重试**（同样的任务和选择；重新寻找开发板，下载好的或下到一半的文件从缓存取）、**返回步骤**、**报告问题**（GitHub issue，带版本、系统、失败的步骤和日志的最后几行；主目录、用户名、地址和序列号会被去掉）和**保存完整日志**。开发板从 USB 上掉了时，页面显示"开发板已断开"，并再次给出 MaskROM 步骤。

找不到开发板时，检查：是否真的进了 MaskROM（屏幕有画面就说明正常启动了）、数据线和接口、WinUSB 驱动或 udev 规则、是否只连了一个 Rockchip 设备。
