// An edk2-rk3576 SPI NOR image, as its release ships it for the ROCK 4D
// (ROCK4D-spi-edk2-<tag>.img, 16 MiB), and the same flash read from a board
// (edk2-rk3576 docs/dev/image-layout.md):
//
//   0x000000  GPT                      sector 0
//   0x008000  idblock (DDR init, SPL)  sector 64
//   0x060000  FIT: BL31, EDK2, DTB     sector 768
//   0xFC0000  UEFI variable store, then the FTW working and spare blocks,
//             64 KiB each, in the erased state (0xFF) in the image
//
// Unlike the eMMC image, the settings are not an image inside the FIT: the
// firmware reads and writes the flash there itself. A write that keeps them
// stops at sector 32256 (flash-keep-nv.sh "rock4d" does the same by hand).
// Everything lies in the first 16 MiB, where reads over MaskROM are trusted.

import { boardOf, findStamp, fitImageLba, isEmptySlot, isVariableStore, parseFit, SECTOR } from './edk2-image';
import type { BoardId, WoaBoard } from './boards';
import type { ByteSource } from './pieces';
import { formatBytes } from '../shared/format';

/** The three 64 KiB blocks of the UEFI settings (store, FTW working, FTW spare). */
export const SPI_SETTINGS_BYTES = 0x30000;
/** A storage larger than this is not an SPI NOR flash (an eMMC or a UFS module the loader selected). */
export const SPI_MAX_BYTES = 64 * 1024 * 1024;

export interface SpiFirmwareInfo {
  version: string | null;
  board: BoardId | null;
  dt: string;
  stampBoard: string | null;
}

type Read = (offset: number, length: number) => Promise<Uint8Array | null> | Uint8Array | null;

/** The FIT at `fitLba` and, with `stamp`, the build stamp in its edk2 image; a sentence when it is not one. */
export async function readSpiFirmware(read: Read, fitLba: number, stamp: boolean): Promise<SpiFirmwareInfo | string> {
  const head = await read(fitLba * SECTOR, 8192);
  if (!head) return `The FIT at sector ${fitLba} could not be read.`;
  const fit = parseFit(head, fitLba);
  if (typeof fit === 'string') return fit;
  const edk2 = fitImageLba(fit, 'edk2', fitLba);
  if (!edk2) return 'The FIT has no edk2 image.';
  let found: { board: string; version: string } | null = null;
  if (stamp) {
    const body = await read(edk2.lba * SECTOR, edk2.sectors * SECTOR);
    found = body ? findStamp(body) : null;
  }
  return { version: found?.version ?? null, board: boardOf(fit.config, found?.board ?? null), dt: fit.config, stampBoard: found?.board ?? null };
}

/** Why the storage the loader selected is not this board's SPI NOR flash, or null. */
export function spiStorageProblem(b: WoaBoard, capacity: number | null): string | null {
  if (!b.spi) return null;
  if (capacity === null) {
    return 'The loader did not report the size of the storage it selected, so it cannot be confirmed to be the SPI NOR flash. Nothing was written.';
  }
  if (capacity > SPI_MAX_BYTES || capacity < b.spi.nvdataLba * SECTOR + SPI_SETTINGS_BYTES) {
    return `The loader selected a ${formatBytes(capacity)} storage, not the ${b.name}'s ${formatBytes(b.spi.bytes)} SPI NOR flash `
      + '(a UFS module, or another board?). Nothing was written.';
  }
  return null;
}

/** Check a firmware image for this board's SPI NOR flash; a sentence when it is not one. */
export async function checkSpiImage(image: ByteSource, b: WoaBoard): Promise<SpiFirmwareInfo | string> {
  const spi = b.spi;
  if (!spi) return `The ${b.name} has no SPI NOR firmware.`;
  if (image.size !== spi.bytes) return `The image is ${image.size} bytes; an edk2-rk3576 SPI NOR image for the ${b.name} is ${spi.bytes}.`;
  const info = await readSpiFirmware((o, n) => (o + n <= image.size ? image.read(o, n) : null), spi.fitLba, true);
  if (typeof info === 'string') return `This is not an edk2-rk3576 SPI NOR image: ${info}`;
  if (info.board !== b.id) return `This firmware is for ${info.dt || info.stampBoard || 'another board'}, not the ${b.name}.`;
  const settings = image.read(spi.nvdataLba * SECTOR, SPI_SETTINGS_BYTES);
  if (!isEmptySlot(settings)) {
    return `The image does not have the UEFI settings area erased at sector ${spi.nvdataLba}, so its layout is not the one this app knows.`;
  }
  return info;
}

export interface SpiBoardState {
  /** What the board's flash holds at the settings sectors. */
  settings: 'store' | 'empty' | 'other';
  /** The firmware the board's flash holds, or why none was found. */
  installed: SpiFirmwareInfo | string;
  /** The settings blocks as read, for the copy kept on the computer. */
  data: Uint8Array;
}

/** Read the board's flash: its settings blocks and its FIT (no stamp: that is 13 MiB more to read). */
export async function readSpiBoard(read: (lba: number, sectors: number) => Promise<Uint8Array | null>, b: WoaBoard): Promise<SpiBoardState | string> {
  const spi = b.spi!;
  const data = await read(spi.nvdataLba, SPI_SETTINGS_BYTES / SECTOR);
  if (!data) return `The UEFI settings could not be read from the SPI NOR flash (sector ${spi.nvdataLba}). Nothing was written.`;
  const installed = await readSpiFirmware(async (o, n) => read(o / SECTOR, Math.ceil(n / SECTOR)), spi.fitLba, false);
  return { settings: isVariableStore(data) ? 'store' : isEmptySlot(data) ? 'empty' : 'other', installed, data };
}

/** Why keeping the settings on this flash would leave a board that cannot read them, or null. */
export function spiKeepProblem(s: SpiBoardState, b: WoaBoard): string | null {
  const whole = '"UEFI firmware" (the whole flash, which resets the settings)';
  if (typeof s.installed === 'string') {
    return `The SPI NOR flash does not hold edk2-rk3576 firmware (${s.installed}), so it has no UEFI settings to keep. Choose ${whole} instead. Nothing was written.`;
  }
  if (s.installed.board && s.installed.board !== b.id) {
    return `The firmware on the SPI NOR flash is for ${s.installed.dt}, not the ${b.name}. Nothing was written.`;
  }
  if (s.settings === 'other') {
    return `What the SPI NOR flash holds at sector ${b.spi!.nvdataLba} is not a UEFI variable store (no _FVH), and the firmware would not start with it. Choose ${whole} instead. Nothing was written.`;
  }
  return null;
}
