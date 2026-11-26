// The boards, built on edk2-webflash's board list (src/web/webflash/boards.js,
// copied unchanged): its firmware choices, sectors and wording are the ones
// proven on these boards through flash.gahingwoo.com. What is added here is
// what Windows needs and what the app needs to recognise a board it runs on.

import { BOARDS, type WebflashBoard, type WebflashTarget } from '../web/webflash/boards';

export type BoardId = WebflashBoard['id'];

/** Where Windows can be installed: the board's eMMC, an SD card, an NVMe drive. */
export type WindowsTarget = 'emmc' | 'sd' | 'nvme';

/**
 * How the board starts an SD card:
 * - bootrom-emmc-first: the BootROM tries the eMMC first and the card only when the eMMC holds no bootloader;
 *   the UEFI firmware on the eMMC starts a card that holds a system (CM5-IO).
 * - spl-on-emmc: the BootROM never starts the card; the SPL on the eMMC loads the firmware from it first
 *   and falls back to the eMMC (TaishanPi 3M).
 * - spi-firmware: the firmware is on the SPI NOR flash and starts the card (ROCK 4D).
 */
export type SdBoot = 'bootrom-emmc-first' | 'spl-on-emmc' | 'spi-firmware';

/** Where Windows and Armbian go when both are installed (WoaBoard.hybrid). */
export type HybridLayout = 'one-emmc' | 'nvme-and-sd';

export interface WoaBoard {
  id: BoardId;
  name: string;
  webflash: WebflashBoard;
  /** Where the firmware goes: the eMMC, or the SPI NOR flash. */
  firmwareStorage: 'emmc' | 'spinor';
  /**
   * The SPI NOR layout edk2-rk3576 builds (docs/dev/image-layout.md), on a board
   * whose firmware is there: the flash size, the FIT's sector and the first
   * sector of the UEFI settings (variable store, FTW working and spare blocks),
   * which run to the end of the flash. Writing sectors 0..nvdataLba-1 keeps them.
   */
  spi?: { bytes: number; fitLba: number; nvdataLba: number };
  /** The asset name prefix of the firmware in an edk2-rk3576 release ("TaishanPi3M-emmc-edk2-"). */
  firmwareAsset: string;
  /** The board's eMMC: the size seen on the boards tried, and the sizes accepted. Null: the board has no eMMC. */
  emmc: { bytes: number; minBytes: number; maxBytes: number } | null;
  /** Where Windows can go on this board, in the order offered. Every text about it is made from this list. */
  windowsTargets: WindowsTarget[];
  /** How the board starts an SD card. */
  sdBoot: SdBoot;
  /** Windows has started on this board (with the released firmware). */
  windowsBooted: boolean;
  /**
   * Armbian next to Windows, started by the firmware's one-shot boot option
   * "Armbian (U-Boot)" (edk2-rk3576 RK_ARMBIAN_ONCE_ENABLE,
   * docs/ARMBIAN-CHAINLOAD.md), or null when the board cannot have both:
   * - one-emmc: both on the eMMC; Armbian's U-Boot goes into the firmware's
   *   slot at eMMC sector 0x10000 (TaishanPi 3M).
   * - nvme-and-sd: Windows on the NVMe drive, Armbian on the SD card (its
   *   U-Boot at sector 0x4000 of the card, the request at sector 0x3FFF of
   *   the card). The firmware's SPL must carry the one-shot
   *   (PcdArmbianOnceRequestOnSd, the SPL with CONFIG_SPL_ROCKCHIP_ARMBIAN_ONCE_SD_REQUEST),
   *   which the app checks over MaskROM before writing (armbian-once.ts).
   */
  hybrid: HybridLayout | null;
  /** How to get into MaskROM: a button, or two pads to short (with F4 in the firmware once it runs). */
  maskromEntry: 'button' | 'pads';
  /** Where the board maker publishes the factory images (update.img); none for boards without a factory restore. */
  factoryPage?: { en: string; zh: string };
  /** Device tree compatible strings; any one identifies the board. */
  compatible: string[];
  /** SMBIOS product names edk2-rk3576 reports (PcdPlatformName). */
  smbios: string[];
}

const wf = (id: BoardId): WebflashBoard => {
  const b = BOARDS.find((x) => x.id === id);
  if (!b) throw new Error(`edk2-webflash has no board ${id}`);
  return b;
};

const GB = 1e9;

// Board facts: edk2-rk3576 docs/HARDWARE.md and docs/FLASHING.md.
//   TaishanPi 3M: 58 GiB eMMC, microSD, a mini-PCIe slot (no M.2, so no NVMe). BootROM: eMMC, then USB, never SD.
//     No MaskROM button: the MSK pads, or F4 in the firmware.
//   CM5-IO: eMMC on the CM5 module, microSD, NVMe on M.2. The BootROM tries the eMMC before the SD card.
//     MaskROM button.
//   ROCK 4D: no eMMC (a UFS module connector; Radxa: "eMMC modules are not supported"), microSD, NVMe on
//     M.2 through the PCIe FPC connector. Firmware on the 16 MB SPI NOR flash. MaskROM button, with a USB-A to
//     USB-A cable on the upper USB 3.0 port (the USB-C port carries power only).
export const WOA_BOARDS: WoaBoard[] = [
  {
    id: 'tspi3m', name: 'LCKFB TaishanPi 3M', webflash: wf('tspi3m'), firmwareStorage: 'emmc',
    firmwareAsset: 'TaishanPi3M-emmc-edk2-',
    // 62008590336 bytes on the boards tried; the deploy script accepts 57 to 63 GB.
    emmc: { bytes: 62008590336, minBytes: 57 * GB, maxBytes: 64 * GB },
    windowsTargets: ['emmc', 'sd'],
    sdBoot: 'spl-on-emmc',
    windowsBooted: true,
    hybrid: 'one-emmc',
    maskromEntry: 'pads',
    factoryPage: {
      en: 'https://wiki.lckfb.com/en/tspi-3-rk3576/img-download/finished-image.html',
      zh: 'https://wiki.lckfb.com/zh-hans/tspi-3-rk3576/img-download/finished-image.html',
    },
    compatible: ['lckfb,tspi-3m-rk3576', 'lckfb,tspi-3m', 'lckfb,taishanpi-3m'],
    smbios: ['TaishanPi 3M'],
  },
  {
    id: 'cm5io', name: 'ArmSoM CM5-IO', webflash: wf('cm5io'), firmwareStorage: 'emmc',
    firmwareAsset: 'CM5IO-emmc-edk2-',
    // 31272730624 bytes on the board tried; the deploy script accepts 28 to 33 GB.
    emmc: { bytes: 31272730624, minBytes: 28 * GB, maxBytes: 34 * GB },
    windowsTargets: ['emmc', 'sd', 'nvme'],
    sdBoot: 'bootrom-emmc-first',
    windowsBooted: true,
    // Its SPL is not built with ArmbianOnce yet, and its 31 GB eMMC has no room for both.
    hybrid: null,
    maskromEntry: 'button',
    factoryPage: { en: 'https://docs.armsom.org/armsom-cm5-io', zh: 'https://docs.armsom.org/zh/armsom-cm5-io' },
    compatible: ['armsom,cm5-io'],
    smbios: ['CM5-IO'],
  },
  {
    id: 'rock4d', name: 'Radxa ROCK 4D', webflash: wf('rock4d'), firmwareStorage: 'spinor',
    // edk2-rk3576 docs/dev/image-layout.md and the board-session flash-keep-nv.sh: GPT at 0, SPL at sector 64,
    // FIT at sector 768, the UEFI settings from 0xFC0000 (sector 32256) to the end.
    spi: { bytes: 16 * 1024 * 1024, fitLba: 768, nvdataLba: 32256 },
    firmwareAsset: 'ROCK4D-spi-edk2-',
    emmc: null,
    windowsTargets: ['nvme', 'sd'],
    sdBoot: 'spi-firmware',
    // Windows 11 23H2 installed to NVMe by this app reached the desktop on 2026-11-26, with
    // edk2-rk3576 main (ACPI for the ROCK 4D is not in a release yet: 0.4.1 has none).
    windowsBooted: true,
    // The SPL and the firmware are on the SPI NOR flash and there is no eMMC: the one-shot request and
    // Armbian's U-Boot are on the SD card (docs/ARMBIAN-CHAINLOAD.md "SPI NOR boards"). Only firmware built
    // with the U-Boot v2026.10 SPL (edk2-rk3576 c81c13f, branch rock4d-parity) has it; the app checks.
    hybrid: 'nvme-and-sd',
    maskromEntry: 'button',
    compatible: ['radxa,rock-4d'],
    smbios: ['ROCK 4D'],
  },
];

export function woaBoard(id: string): WoaBoard | undefined {
  return WOA_BOARDS.find((b) => b.id === id);
}

/**
 * On an SPI NOR board, the firmware without the saved UEFI settings: the same
 * image file as "UEFI firmware", sectors 0..nvdataLba-1 of it, written from
 * sector 0. edk2-webflash has no such choice (it rewrites the whole flash);
 * the sectors are those of flash-keep-nv.sh "rock4d" used on the board.
 */
function spiKeepTarget(b: WoaBoard): WebflashTarget | null {
  const whole = b.webflash.targets.find((t) => t.id === 'uefi');
  if (!b.spi || !whole) return null;
  const end = b.spi.nvdataLba * 512;
  return {
    id: 'uefi-keep', label: 'UEFI firmware, keep the settings', image: whole.image, file: whole.file, lba: 0, slice: [0, end],
    note: 'For a board that already runs this firmware. Only the firmware is written; the saved UEFI settings stay.',
    erases: `Sectors 0 to ${b.spi.nvdataLba - 1} of the SPI NOR flash (partition table, SPL and firmware) are rewritten. `
      + `The saved UEFI settings, from sector ${b.spi.nvdataLba} (0x${end.toString(16).toUpperCase()}) to the end, are not written. Disks are not touched.`,
    done: 'The board restarts into the new firmware, with its settings.',
  };
}

/** The firmware choices of a board, from edk2-webflash, without U-Boot (Windows needs UEFI). */
export function firmwareTargets(b: WoaBoard): WebflashTarget[] {
  const out = b.webflash.targets.filter((t) => t.id === 'uefi' || t.id === 'uefi-keep');
  const keep = out.some((t) => t.id === 'uefi-keep') ? null : spiKeepTarget(b);
  return keep ? [...out, keep] : out;
}

/** The board a device tree compatible list or an SMBIOS product name names, if any. */
export function boardFromIds(compatible: string[], smbiosProduct: string | null): WoaBoard | null {
  for (const b of WOA_BOARDS) {
    if (compatible.some((c) => b.compatible.includes(c))) return b;
  }
  if (smbiosProduct) {
    const p = smbiosProduct.trim().toLowerCase();
    for (const b of WOA_BOARDS) if (b.smbios.some((s) => s.toLowerCase() === p)) return b;
  }
  return null;
}
