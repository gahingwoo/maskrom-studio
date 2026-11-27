// Does the firmware on a board start Armbian's U-Boot once from the SD card?
//
// Every SPL that can do it prints, and so contains, "ArmbianOnce/1"
// (ARMBIAN_ONCE_SPL_TAG in edk2-rk3576 Silicon/Rockchip/Include/ArmbianOnce.h).
// Without the tag the firmware shows no "Armbian (U-Boot)" entry and an
// Armbian card in the slot is never started. The app reads the SPL over
// MaskROM and looks for the tag before it writes anything.
//
// ROCK 4D (WoaBoard.hybrid 'nvme-and-sd'): the SPL is on the SPI NOR flash,
// 0x8000..0x5FFFF, and takes the request on the SD card (edk2-rk3576
// docs/ARMBIAN-CHAINLOAD.md, "SPI NOR boards": U-Boot v2026.10 with
// uboot/v2026.10/0001 and 0002, CONFIG_SPL_ROCKCHIP_ARMBIAN_ONCE_SD_REQUEST).
// The tag does not say where the SPL takes the request; only the edk2-rk3576
// build for the ROCK 4D (boards/rock4d.conf) has the tag, and it has the SD
// request. The ROCK 4D has no eMMC.
//
// CM5-IO ('windows-and-sd'): the SPL is on the eMMC from sector 64 and takes
// the request at eMMC sector 0x3FFF (edk2-rk3576 0.5.0, U-Boot v2026.10 with
// uboot/v2026.10/0001). The firmware writes the request itself; the app only
// checks the SPL, in the first MiB from sector 64, as the firmware does
// (ArmbianOnceSplTakesRequests in ArmbianOnceLib.c). A Windows install keeps
// the firmware partition, so the SPL on the board is the one that counts, not
// the one in a release.

import type { WoaBoard } from './boards';

export const ARMBIAN_ONCE_SPL_TAG = 'ArmbianOnce/1';
/** Where the SPL starts, on the SPI NOR flash (0x8000) and on the eMMC. */
export const SPL_LBA = 64;
/** How much of the eMMC from sector 64 the firmware searches for the tag: 1 MiB. */
export const EMMC_SPL_SECTORS = 2048;

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

/** The sectors that hold the SPL: on the SPI NOR flash up to the FIT, or the first MiB of the eMMC from sector 64. */
export function splSectors(b: WoaBoard): { lba: number; sectors: number } | null {
  if (b.spi) return { lba: SPL_LBA, sectors: b.spi.fitLba - SPL_LBA };
  if (b.firmwareStorage === 'emmc' && b.emmc) return { lba: SPL_LBA, sectors: EMMC_SPL_SECTORS };
  return null;
}

export type ArmbianOnceCheck = { ok: true; offset: number } | { ok: false; reason: string };

/**
 * Read the SPL from the board's firmware storage (SPI NOR sectors 64 to the
 * FIT, or eMMC sectors 64 to 2111) and look for the tag. A sentence for the
 * page when it is not there, naming where Armbian would start from.
 */
export async function checkArmbianOnce(b: WoaBoard, read: (lba: number, sectors: number) => Promise<Uint8Array | null>,
  from: 'the SD card' | 'the NVMe drive' = 'the SD card'): Promise<ArmbianOnceCheck> {
  const at = splSectors(b);
  if (!at) return { ok: false, reason: `The ${b.name} has no firmware storage this check can read.` };
  const where = b.spi ? 'SPI NOR flash' : 'eMMC';
  const spl = await read(at.lba, at.sectors);
  if (!spl) return { ok: false, reason: `The SPL could not be read from the ${b.name}'s ${where}. Nothing was written.` };
  const off = findTag(spl);
  if (off < 0) {
    const need = b.spi
      ? 'Armbian next to Windows needs edk2-rk3576 firmware built with the new U-Boot SPL (U-Boot v2026.10 with the one-shot request on the SD card). Nothing was written.'
      : 'Armbian next to Windows needs edk2-rk3576 0.5.0 or later on the eMMC (its U-Boot v2026.10 SPL has the one-shot). Write the UEFI firmware to the board first, then run this install again. Nothing was written.';
    return { ok: false, reason: `The firmware on this ${b.name} cannot start Armbian from ${from}: its SPL (${where}, sectors ${at.lba} to ${at.lba + at.sectors - 1}) has no "${ARMBIAN_ONCE_SPL_TAG}" in it, so the firmware has no "Armbian (U-Boot)" boot entry. ${need}` };
  }
  return { ok: true, offset: at.lba * SECTOR + off };
}

/** On an eMMC board, why the storage the loader reports is not the board's eMMC (so the SPL read would mean nothing), or null. */
export function emmcStorageProblem(b: WoaBoard, capacity: number | null): string | null {
  if (b.spi || !b.emmc) return null;
  if (capacity === null) return 'The storage the loader selected did not report its size, so it cannot be confirmed to be the eMMC. Nothing was written.';
  if (capacity < b.emmc.minBytes || capacity > b.emmc.maxBytes) {
    return `The loader selected a storage of ${capacity} bytes, not the size of the ${b.name}'s eMMC (${b.emmc.minBytes / 1e9} to ${b.emmc.maxBytes / 1e9} GB). Nothing was written.`;
  }
  return null;
}
