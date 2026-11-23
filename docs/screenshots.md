# Screenshots

Taken from the built app with `node scripts/readme-shots.mjs docs/imgs`
(1100x780, made-up releases, a fresh profile shown as
`/home/user/.config/Maskrom Studio`). The firmware upgrade runs against a
pretend TaishanPi 3M with edk2-rk3576 0.4.1 on its eMMC; nothing here is a
real board.

| | |
|---|---|
| ![The Board step: LCKFB TaishanPi 3M, ArmSoM CM5-IO and Radxa ROCK 4D](imgs/board.png) Board | ![The What to write step for the TaishanPi 3M with every task](imgs/task.png) What to write |
| ![A Windows 11 23H2 ARM64 ISO read: architecture, builds, boot files, editions; its 24H2 edition refused with the reason](imgs/windows-image.png) A Windows image, one edition refused | ![An x64 install.wim refused: "This edition is for x64, not ARM64"](imgs/windows-image-refused.png) An x64 image refused |
| ![Windows setup with a chosen disk layout: 40 GB Windows, an exFAT data partition, 8 GB kept for Linux](imgs/windows-setup.png) Disk layout | ![The Review step with the disk layout, what is erased and written](imgs/review.png) Review |
| ![Armbian for the TaishanPi 3M written to an SD card, with the note that this board does not start from an SD card by itself](imgs/armbian.png) Armbian to an SD card | ![The firmware upgrade's confirmation: eMMC SAMSUNG 62.0 GB, installed 0.4.1, new 0.4.2, UEFI settings kept with the path of the saved copy](imgs/upgrade-confirm.png) Firmware upgrade, confirmation |
| ![The finished firmware upgrade: the first 32.0 MiB read back equal](imgs/upgrade-done.png) Firmware upgrade, done | ![Settings: updates, downloads with Clear cache, appearance, language](imgs/settings.png) Settings |
| ![Clear the cache: downloaded images and loader pieces listed, the UEFI settings backups kept unless ticked](imgs/clear-cache.png) Clear cache | ![About Maskrom Studio](imgs/about.png) About |

Dark theme:

| | |
|---|---|
| ![What to write, dark](imgs/task-dark.png) | ![Disk layout, dark](imgs/windows-setup-dark.png) |
| ![Settings, dark](imgs/settings-dark.png) | ![About, dark](imgs/about-dark.png) |

简体中文:

| | |
|---|---|
| ![写入内容](imgs/task-zh-CN.png) | ![磁盘布局](imgs/windows-setup-zh-CN.png) |
| ![设置](imgs/settings-zh-CN.png) | ![关于](imgs/about-zh-CN.png) |
