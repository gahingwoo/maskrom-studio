// The regions of the two restores, once the board has said how large its
// eMMC is: a whole-disk image (Armbian) from sector 0, or a factory
// update.img's partitions where its parameter.txt puts them. Pure: the
// worker runs these against the board, the tests against numbers.

import { bytesSource, sliceSource, type ByteSource } from './pieces';
import { planFactory, SECTOR, type UpdateImage } from './rkfw';
import type { Region } from './stage-layout';

/** GPT keeps a copy of itself in the last 33 sectors; a whole-disk image leaves the old one behind otherwise. */
export const BACKUP_GPT_SECTORS = 33;

export interface WholeSummary {
  kind: 'whole';
  label: string;
  capacity: number | null;
  bytes: number;
  /** Whether the old backup partition table at the end of the eMMC is cleared too. */
  clearsBackupGpt: boolean;
}

/**
 * A disk image written from sector 0. Everything on the eMMC before it ends is
 * replaced (partition table, the UEFI firmware at 32 KiB, Windows); after it,
 * old data stays until the system grows into it, except the old GPT backup at
 * the very end, which is zeroed so no tool finds a stale partition table.
 */
export function planWhole(image: ByteSource, label: string, capacity: number | null): { regions: Region[]; summary: WholeSummary } | { stop: string } {
  if (image.size % SECTOR !== 0) return { stop: `${label} is ${image.size} bytes, not a whole number of sectors.` };
  if (capacity !== null && image.size > capacity) return { stop: `${label} (${image.size} bytes) is larger than the eMMC (${capacity} bytes). Nothing was written.` };
  const regions: Region[] = [{ lba: 0, source: image, label }];
  const tailLba = capacity !== null ? Math.floor(capacity / SECTOR) - BACKUP_GPT_SECTORS : -1;
  const clears = capacity !== null && tailLba * SECTOR >= image.size;
  if (clears) regions.push({ lba: tailLba, source: bytesSource(new Uint8Array(BACKUP_GPT_SECTORS * SECTOR)), label: 'the end of the eMMC (old backup partition table)' });
  return { regions, summary: { kind: 'whole', label, capacity, bytes: image.size, clearsBackupGpt: clears } };
}

export interface FactorySummary {
  kind: 'factory';
  capacity: number | null;
  chip: string;
  model: string;
  version: string;
  partitions: Array<{ name: string; lba: number; bytes: number }>;
  skipped: string[];
  bytes: number;
}

export function planFactoryRegions(file: ByteSource, img: UpdateImage, capacity: number | null):
  { regions: Region[]; loader: Uint8Array; parameter: Uint8Array; summary: FactorySummary } | { stop: string } {
  const p = planFactory(img, capacity);
  if ('stop' in p) return p;
  const regions = p.writes.map((w) => ({ lba: w.lba, source: sliceSource(file, w.offset, w.size), label: `the ${w.name} partition` }));
  const loader = file.read(img.loader!.offset, img.loader!.size);
  return {
    regions, loader, parameter: new TextEncoder().encode(img.parameter),
    summary: {
      kind: 'factory', capacity, chip: img.chip, model: img.model, version: img.version,
      partitions: p.writes.map((w) => ({ name: w.name, lba: w.lba, bytes: w.size })), skipped: p.skipped,
      bytes: p.writes.reduce((s, w) => s + w.size, 0),
    },
  };
}
