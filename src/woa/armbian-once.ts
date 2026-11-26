// Does the firmware on a board start Armbian's U-Boot once from the SD card?
//
// On the ROCK 4D (WoaBoard.hybrid 'nvme-and-sd') Armbian next to Windows
// works only with an SPL that takes the one-shot request on the SD card
// (edk2-rk3576 docs/ARMBIAN-CHAINLOAD.md, "SPI NOR boards": U-Boot v2026.10
// with uboot/v2026.10/0001 and 0002, CONFIG_SPL_ROCKCHIP_ARMBIAN_ONCE_SD_REQUEST).
// Every SPL that can do it prints, and so contains, "ArmbianOnce/1"
// (ARMBIAN_ONCE_SPL_TAG in Silicon/Rockchip/Include/ArmbianOnce.h). The
// firmware's own ArmbianOnce application refuses to write a request unless
// the SPL in the SPI NOR, 0x8000..0x5FFFF, has that tag; the app checks the
// same bytes over MaskROM before it writes anything. Without the tag the
// firmware shows no "Armbian (U-Boot)" entry and an Armbian card in the slot
// is never started (the SPL boots the firmware from the SPI NOR first).
//
// The tag says the SPL has the one-shot; it does not say whether the SPL takes
// the request on the SD card or on the eMMC. The ROCK 4D has no eMMC, and an
// SPL built for it with the eMMC request would find no eMMC and boot the
// firmware: harmless, but Armbian would not start. Only the edk2-rk3576 build
// for the ROCK 4D (boards/rock4d.conf) has the tag, and it has the SD request.

import type { WoaBoard } from './boards';

export const ARMBIAN_ONCE_SPL_TAG = 'ArmbianOnce/1';
/** Where the SPL is on the SPI NOR flash: sector 64 (0x8000) up to the firmware FIT. */
export const SPL_LBA = 64;

const SECTOR = 512;
const TAG = new TextEncoder().encode(ARMBIAN_ONCE_SPL_TAG);

/** The tag's byte offset in `b`, or -1. */
export function findTag(b: Uint8Array): number {
  const first = TAG[0];
  for (let i = b.indexOf(first); i >= 0 && i <= b.length - TAG.length; i = b.indexOf(first, i + 1)) {
    let j = 1;
    while (j < TAG.length && b[i + j] === TAG[j]) j++;
    if (j === TAG.length) return i;
  }
  return -1;
}

/** The sectors of the SPI NOR flash that hold the SPL, on an SPI NOR board. */
export function splSectors(b: WoaBoard): { lba: number; sectors: number } | null {
  if (!b.spi) return null;
  return { lba: SPL_LBA, sectors: b.spi.fitLba - SPL_LBA };
}

export type ArmbianOnceCheck = { ok: true; offset: number } | { ok: false; reason: string };

/**
 * Read the SPL from the board's SPI NOR flash (sectors 64 to the FIT) and
 * look for the tag. A sentence for the page when it is not there.
 */
export async function checkArmbianOnce(b: WoaBoard, read: (lba: number, sectors: number) => Promise<Uint8Array | null>): Promise<ArmbianOnceCheck> {
  const at = splSectors(b);
  if (!at) return { ok: false, reason: `The ${b.name} keeps its firmware on the eMMC; this check is for SPI NOR boards.` };
  const spl = await read(at.lba, at.sectors);
  if (!spl) return { ok: false, reason: `The SPL could not be read from the ${b.name}'s SPI NOR flash. Nothing was written.` };
  const off = findTag(spl);
  if (off < 0) {
    return { ok: false, reason: `The firmware on this ${b.name} cannot start Armbian from the SD card: its SPL (SPI NOR flash, sectors ${at.lba} to ${at.lba + at.sectors - 1}) has no "${ARMBIAN_ONCE_SPL_TAG}" in it, so the firmware has no "Armbian (U-Boot)" boot entry. `
      + 'Armbian next to Windows needs edk2-rk3576 firmware built with the new U-Boot SPL (U-Boot v2026.10 with the one-shot request on the SD card). Nothing was written.' };
  }
  return { ok: true, offset: at.lba * SECTOR + off };
}
