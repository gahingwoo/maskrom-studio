// Writing edk2-rk3576 firmware: the regions for one of edk2-webflash's
// choices ("UEFI firmware, whole image" or "keep the partitions"), cut by
// edk2-webflash's own prepare() so the sectors are exactly the ones
// flash.gahingwoo.com writes. Added: "keep the partitions" is refused on an
// eMMC whose partition table is not the edk2-rk3576 layout, where writing
// only the firmware part would leave a board that does not start. On an SPI
// NOR board (ROCK 4D): the image must be this board's SPI image, the storage
// the loader selected must be the SPI NOR flash (not a UFS module), and
// "keep the settings" needs edk2-rk3576 firmware and a variable store (or an
// empty one) already on the flash.

import { checkSettingsSlot, prepare } from '../web/webflash/flash';
import type { WebflashTarget } from '../web/webflash/boards';
import type { WoaBoard } from './boards';
import { findFirmwarePartition, parsePrimaryGpt, type GptPartition } from './gpt';
import { sliceSource, type ByteSource } from './pieces';
import type { Region } from './stage-layout';
import { checkSpiImage, readSpiBoard, spiKeepProblem, spiStorageProblem } from './spi-image';

export interface FirmwareSummary {
  board: string;
  target: string;
  lba: number;
  bytes: number;
  capacity: number | null;
  /** Partitions the whole image drops from the table (the data on them stays where it was, unreachable). */
  dropped: Array<{ name: string; bytes: number }>;
  erases: string;
  /** SPI NOR: the firmware the image holds, what was on the board, and whether the board's settings stay. */
  spi?: { next: string | null; installed: string | null; settings: 'kept' | 'none' | 'reset' };
}

/** edk2-webflash's prepare() over a ByteSource: it only needs size and slice(). */
function blobLike(src: ByteSource): { size: number; slice(a: number, b: number): { size: number; src: ByteSource; arrayBuffer(): Promise<ArrayBuffer> } } {
  return {
    size: src.size,
    slice: (a, b) => {
      const end = Math.min(b, src.size), start = Math.min(a, end);
      return {
        size: end - start,
        src: sliceSource(src, start, end - start),
        arrayBuffer: async () => { const u = src.read(start, end - start); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer; },
      };
    },
  };
}

export async function firmwareRegions(board: WoaBoard, target: WebflashTarget, image: ByteSource,
  probe: { capacity: number | null; head: Uint8Array | null; read?: (lba: number, sectors: number) => Promise<Uint8Array | null> }): Promise<{ regions: Region[]; summary: FirmwareSummary } | { stop: string }> {
  let part: { size: number; src?: ByteSource };
  try {
    part = prepare(board.webflash, target, blobLike(image));
    // As edk2-webflash's runFlash() does: a write that keeps the saved UEFI
    // settings must stop exactly where the image's nvdata slot starts.
    if (target.keepsSettings) await checkSettingsSlot(blobLike(image), target, target.keepsSettings);
  } catch (e) {
    return { stop: String((e as Error).message) };
  }
  const src = part.src ?? image;
  let dropped: FirmwareSummary['dropped'] = [];
  let spi: FirmwareSummary['spi'];
  if (board.spi) {
    const next = await checkSpiImage(image, board);
    if (typeof next === 'string') return { stop: `${next} Nothing was written.` };
    const where = spiStorageProblem(board, probe.capacity);
    if (where) return { stop: where };
    let installed: string | null = null;
    let settings: NonNullable<FirmwareSummary['spi']>['settings'] = 'reset';
    if (target.id === 'uefi-keep') {
      if (!probe.read) return { stop: 'The SPI NOR flash cannot be read, so "keep the settings" cannot be checked. Nothing was written.' };
      const state = await readSpiBoard(probe.read, board);
      if (typeof state === 'string') return { stop: state };
      const why = spiKeepProblem(state, board);
      if (why) return { stop: why };
      installed = typeof state.installed === 'string' ? null : state.installed.dt;
      settings = state.settings === 'store' ? 'kept' : 'none';
    }
    spi = { next: next.version, installed, settings };
  }
  if (board.firmwareStorage === 'emmc') {
    let existing: GptPartition[] | null = null;
    let fwOk = false;
    if (probe.head) {
      try {
        const t = parsePrimaryGpt(probe.head);
        existing = t.partitions;
        fwOk = typeof findFirmwarePartition(t) !== 'string';
      } catch { existing = null; }
    }
    if (target.id === 'uefi-keep') {
      if (!probe.head) return { stop: 'The partition table could not be read, so "keep the partitions" cannot be checked. Nothing was written.' };
      if (!fwOk) {
        return { stop: 'This eMMC does not have the edk2-rk3576 partition layout, so writing only the firmware part would leave the board unable to start. Choose "UEFI firmware, whole image". Nothing was written.' };
      }
    } else if (existing) {
      dropped = existing.filter((p) => p.firstLba !== 64).map((p) => ({ name: p.name || '(no name)', bytes: (p.lastLba - p.firstLba + 1) * 512 }));
    }
  }
  if (probe.capacity !== null && target.lba * 512 + src.size > probe.capacity) {
    return { stop: `The image does not fit the ${board.webflash.storage} (${probe.capacity} bytes). Nothing was written.` };
  }
  return {
    regions: [{ lba: target.lba, source: src, label: target.label }],
    summary: { board: board.name, target: target.label, lba: target.lba, bytes: src.size, capacity: probe.capacity, dropped, erases: target.erases, ...(spi ? { spi } : {}) },
  };
}
