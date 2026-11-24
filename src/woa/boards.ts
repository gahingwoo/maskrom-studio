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

export interface WoaBoard {
  id: BoardId;
  name: string;
  webflash: WebflashBoard;
  /** Where the firmware goes: the eMMC, or the SPI NOR flash. */
  firmwareStorage: 'emmc' | 'spinor';
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
//   ROCK 4D: no eMMC (UFS), microSD, NVMe on M.2. Firmware on the 16 MB SPI NOR flash. MaskROM button.
export const WOA_BOARDS: WoaBoard[] = [
  {
    id: 'tspi3m', name: 'LCKFB TaishanPi 3M', webflash: wf('tspi3m'), firmwareStorage: 'emmc',
    firmwareAsset: 'TaishanPi3M-emmc-edk2-',
    // 62008590336 bytes on the boards tried; the deploy script accepts 57 to 63 GB.
    emmc: { bytes: 62008590336, minBytes: 57 * GB, maxBytes: 64 * GB },
    windowsTargets: ['emmc', 'sd'],
    sdBoot: 'spl-on-emmc',
    windowsBooted: true,
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
    maskromEntry: 'button',
    factoryPage: { en: 'https://docs.armsom.org/armsom-cm5-io', zh: 'https://docs.armsom.org/zh/armsom-cm5-io' },
    compatible: ['armsom,cm5-io'],
    smbios: ['CM5-IO'],
  },
  {
    id: 'rock4d', name: 'Radxa ROCK 4D', webflash: wf('rock4d'), firmwareStorage: 'spinor',
    firmwareAsset: 'ROCK4D-spi-edk2-',
    emmc: null,
    windowsTargets: ['nvme', 'sd'],
    sdBoot: 'spi-firmware',
    // Its ACPI tables are not in a release yet.
    windowsBooted: false,
    maskromEntry: 'button',
    compatible: ['radxa,rock-4d'],
    smbios: ['ROCK 4D'],
  },
];

export function woaBoard(id: string): WoaBoard | undefined {
  return WOA_BOARDS.find((b) => b.id === id);
}

/** The firmware choices of a board, from edk2-webflash, without U-Boot (Windows needs UEFI). */
export function firmwareTargets(b: WoaBoard): WebflashTarget[] {
  return b.webflash.targets.filter((t) => t.id === 'uefi' || t.id === 'uefi-keep');
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
