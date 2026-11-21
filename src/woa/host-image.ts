// The finished Windows the Windows host build made in a VHD the size of the
// board's eMMC (src/woa/host-build.ts), turned into what is written over
// Maskrom: the VHD's partitions (ESP, MSR, Windows, all after 64 MiB, as on
// the eMMC) with only the blocks that hold data, and a new partition table
// that keeps the eMMC's firmware entry byte for byte and takes the VHD's
// other entries.

import type { WoaBoard } from './boards';
import { buildGpt, findFirmwarePartition, parsePrimaryGpt, SECTOR, type GptPartition } from './gpt';
import { bytesSource, sliceSource } from './pieces';
import { StageError, WINDOWS_FIRST_LBA, type Region } from './stage-layout';
import type { VhdInfo } from './vhd';

export interface HostImagePlan {
  regions: Region[];
  totalBytes: number;
  removed: GptPartition[];
  windowsBytes: number;
}

export function planHostImage(o: { board: WoaBoard; capacity: number; head: Uint8Array; vhd: VhdInfo }): HostImagePlan {
  let table;
  try { table = parsePrimaryGpt(o.head); } catch (e) {
    throw new StageError(`${(e as Error).message} Write the firmware with "UEFI firmware, whole image" first.`);
  }
  const fw = findFirmwarePartition(table);
  if (typeof fw === 'string') throw new StageError(`${fw} Write the firmware with "UEFI firmware, whole image" first.`);
  if (o.vhd.diskBytes > o.capacity) {
    throw new StageError(`The Windows disk built here is ${o.vhd.diskBytes} bytes, larger than this eMMC (${o.capacity} bytes). Nothing was written.`);
  }
  const vgpt = parsePrimaryGpt(o.vhd.disk.read(0, 34 * SECTOR));
  const parts = vgpt.partitions;
  if (parts.length === 0) throw new StageError('The Windows disk built here has no partitions.');
  for (const p of parts) {
    if (p.firstLba < WINDOWS_FIRST_LBA) throw new StageError('A partition of the Windows disk built here would overwrite the firmware.');
  }
  const diskSectors = Math.floor(o.capacity / SECTOR);
  const gpt = buildGpt({
    diskSectors, diskGuid: vgpt.diskGuid, keep: fw, mbr: table.mbr,
    parts: parts.map((p) => ({ type: p.type, guid: p.guid, firstLba: p.firstLba, lastLba: p.lastLba, name: p.name, attributes: p.attributes })),
  });

  // The blocks of the VHD that hold data, from 64 MiB to the end of the last partition.
  const start = WINDOWS_FIRST_LBA * SECTOR;
  const end = Math.max(...parts.map((p) => (p.lastLba + 1) * SECTOR));
  const regions: Region[] = [];
  const bb = o.vhd.blockBytes;
  let run: [number, number] | null = null;
  const flush = () => {
    if (!run) return;
    const [a, b] = run;
    regions.push({ lba: a / SECTOR, source: sliceSource(o.vhd.disk, a, b - a), label: 'Windows' });
    run = null;
  };
  for (let blk = Math.floor(start / bb); blk * bb < end; blk++) {
    if (!o.vhd.allocated(blk)) { flush(); continue; }
    const a = Math.max(blk * bb, start);
    const b = Math.min((blk + 1) * bb, end);
    if (run && run[1] === a && run[1] - run[0] < 256 << 20) run[1] = b; else { flush(); run = [a, b]; }
  }
  flush();
  regions.push({ lba: gpt.backupStart, source: bytesSource(gpt.backup), label: 'backup partition table' });
  regions.push({ lba: 0, source: bytesSource(gpt.primary), label: 'partition table' });
  const win = parts.reduce((a, p) => Math.max(a, (p.lastLba - p.firstLba + 1) * SECTOR), 0);
  return {
    regions, totalBytes: regions.reduce((a, r) => a + r.source.size, 0),
    removed: table.partitions.filter((p) => p !== fw), windowsBytes: win,
  };
}
