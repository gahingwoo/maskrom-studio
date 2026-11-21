// Writing edk2-rk3576 firmware: the regions for one of edk2-webflash's
// choices ("UEFI firmware, whole image" or "keep the partitions"), cut by
// edk2-webflash's own prepare() so the sectors are exactly the ones
// flash.gahingwoo.com writes. Added: "keep the partitions" is refused on an
// eMMC whose partition table is not the edk2-rk3576 layout, where writing
// only the firmware part would leave a board that does not start.

import { prepare } from '../web/webflash/flash';
import type { WebflashTarget } from '../web/webflash/boards';
import type { WoaBoard } from './boards';
import { findFirmwarePartition, parsePrimaryGpt, type GptPartition } from './gpt';
import { sliceSource, type ByteSource } from './pieces';
import type { Region } from './stage-layout';

export interface FirmwareSummary {
  board: string;
  target: string;
  lba: number;
  bytes: number;
  capacity: number | null;
  /** Partitions the whole image drops from the table (the data on them stays where it was, unreachable). */
  dropped: Array<{ name: string; bytes: number }>;
  erases: string;
}

/** edk2-webflash's prepare() over a ByteSource: it only needs size and slice(). */
function blobLike(src: ByteSource): { size: number; slice(a: number, b: number): { size: number; src: ByteSource } } {
  return { size: src.size, slice: (a, b) => ({ size: b - a, src: sliceSource(src, a, b - a) }) };
}

export function firmwareRegions(board: WoaBoard, target: WebflashTarget, image: ByteSource,
  probe: { capacity: number | null; head: Uint8Array | null }): { regions: Region[]; summary: FirmwareSummary } | { stop: string } {
  let part: { size: number; src?: ByteSource };
  try {
    part = prepare(board.webflash, target, blobLike(image));
  } catch (e) {
    return { stop: String((e as Error).message) };
  }
  const src = part.src ?? image;
  let dropped: FirmwareSummary['dropped'] = [];
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
    summary: { board: board.name, target: target.label, lba: target.lba, bytes: src.size, capacity: probe.capacity, dropped, erases: target.erases },
  };
}
