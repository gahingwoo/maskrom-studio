// The boards, built on edk2-webflash's board list (src/web/webflash/boards.js,
// copied unchanged): its firmware choices, sectors and wording are the ones
// proven on these boards through flash.gahingwoo.com. What is added here is
// what Windows needs and what the app needs to recognise a board it runs on.

import { BOARDS, type WebflashBoard, type WebflashTarget } from '../web/webflash/boards';

export type BoardId = WebflashBoard['id'];

export interface WoaBoard {
  id: BoardId;
  name: string;
  webflash: WebflashBoard;
  /** Where the firmware goes: the eMMC, or the SPI NOR flash. */
  firmwareStorage: 'emmc' | 'spinor';
  /** The asset name prefix of the firmware in an edk2-rk3576 release ("TaishanPi3M-emmc-edk2-"). */
  firmwareAsset: string;
  /** Windows on this board's eMMC: the eMMC sizes it has been seen with, in bytes. */
  windows: { minBytes: number; maxBytes: number } | null;
  /** Why Windows is not offered, when it is not. */
  windowsNote?: string;
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

export const WOA_BOARDS: WoaBoard[] = [
  {
    id: 'tspi3m', name: 'LCKFB TaishanPi 3M', webflash: wf('tspi3m'), firmwareStorage: 'emmc',
    firmwareAsset: 'TaishanPi3M-emmc-edk2-',
    // 62008590336 bytes on the boards tried; the deploy script accepts 57 to 63 GB.
    windows: { minBytes: 57 * GB, maxBytes: 64 * GB },
    compatible: ['lckfb,tspi-3m-rk3576', 'lckfb,tspi-3m', 'lckfb,taishanpi-3m'],
    smbios: ['TaishanPi 3M'],
  },
  {
    id: 'cm5io', name: 'ArmSoM CM5-IO', webflash: wf('cm5io'), firmwareStorage: 'emmc',
    firmwareAsset: 'CM5IO-emmc-edk2-',
    // 31272730624 bytes on the board tried; the deploy script accepts 28 to 33 GB.
    windows: { minBytes: 28 * GB, maxBytes: 34 * GB },
    compatible: ['armsom,cm5-io'],
    smbios: ['CM5-IO'],
  },
  {
    id: 'rock4d', name: 'Radxa ROCK 4D', webflash: wf('rock4d'), firmwareStorage: 'spinor',
    firmwareAsset: 'ROCK4D-spi-edk2-',
    windows: null,
    windowsNote: 'The ROCK 4D has no eMMC. Windows on its NVMe drive is not in this version yet.',
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
