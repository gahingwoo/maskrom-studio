// Upgrading the edk2-rk3576 firmware on an eMMC that already runs it, with
// Windows (or another system) installed behind it. The procedure used by
// hand on both boards, as a plan the worker runs once the board answers:
//
// 1. The eMMC's partition table must have the firmware partition at sector
//    64 (the layout the whole image or a Windows install leaves). Sectors
//    0..63 are never written: that table belongs to the installed system.
// 2. The new image must be an edk2-rk3576 eMMC image for this board: 32 MiB,
//    a FIT at sector 16384 with edk2 and nvdata images.
// 3. The firmware on the board is read the same way (its FIT and build
//    stamp), so the page can show "installed X, new Y"; another board's
//    firmware, or none, stops here.
// 4. Keeping the settings: the nvdata slot must be at the same sectors in
//    both; it is read (rl, retried), must hold a variable store ("_FVH" at
//    0x28) and is saved on the computer before anything is written.
// 5. One write from sector 64 to the end of the image, with the board's own
//    settings in place of the image's empty slot (the same bytes as writing
//    the image and then the slot), all of it below 32 MiB, so the read-back
//    compares every byte.

import { findFirmwarePartition, parsePrimaryGpt } from './gpt';
import { patchedSource, sliceSource, type ByteSource } from './pieces';
import { FIRST_LBA, IMAGE_BYTES, isEmptySlot, isVariableStore, readFirmware, SECTOR, type FirmwareInfo } from './edk2-image';
import type { Probe } from './maskrom-regions';
import type { Region } from './stage-layout';

export interface UpgradeSummary {
  kind: 'upgrade';
  manufacturer: string | null;
  capacity: number | null;
  installed: string | null;
  next: string | null;
  /** kept: the board's settings go back; reset: the image's empty slot is written; none: the board had none saved. */
  settings: 'kept' | 'reset' | 'none';
  backup: string | null;
  nvdataLba: number;
  nvdataSectors: number;
  lba: number;
  bytes: number;
}

export interface UpgradeInput {
  boardId: string;
  image: ByteSource;
  probe: Probe;
  keepSettings: boolean;
  log: (line: string) => void;
  /** Save the settings copy on the computer; resolves with its path. */
  saveBackup: (data: Uint8Array) => Promise<{ path: string | null; error?: string }>;
}

const sameSlot = (a: FirmwareInfo, b: FirmwareInfo) => a.nvdata.lba === b.nvdata.lba && a.nvdata.sectors === b.nvdata.sectors;

/** Check the new image on its own (also done on the computer before the board is connected). */
export async function checkNewImage(image: ByteSource, boardId: string): Promise<FirmwareInfo | string> {
  if (image.size !== IMAGE_BYTES) return `The image is ${image.size} bytes; an edk2-rk3576 eMMC image is ${IMAGE_BYTES}.`;
  const info = await readFirmware((o, n) => (o + n <= image.size ? image.read(o, n) : null));
  if (typeof info === 'string') return `This is not an edk2-rk3576 eMMC image: ${info}`;
  if (info.board !== boardId) return `This firmware is for ${info.dt || info.stampBoard || 'another board'}, not this board.`;
  return info;
}

export async function planUpgrade(u: UpgradeInput): Promise<{ regions: Region[]; summary: UpgradeSummary } | { stop: string }> {
  const { probe } = u;
  if (!probe.head) return { stop: 'The partition table could not be read from the eMMC. Nothing was written.' };
  try {
    const fw = findFirmwarePartition(parsePrimaryGpt(probe.head));
    if (typeof fw === 'string') throw new Error(fw);
  } catch {
    return { stop: 'This eMMC does not have the edk2-rk3576 partition layout (the firmware partition from sector 64), so an upgrade could overwrite a partition. Write "UEFI firmware, whole image" instead. Nothing was written.' };
  }
  const next = await checkNewImage(u.image, u.boardId);
  if (typeof next === 'string') return { stop: `${next} Nothing was written.` };
  if (!probe.read) return { stop: 'The board cannot be read. Nothing was written.' };
  const read = probe.read;
  const installed = await readFirmware(async (o, n) => read(o / SECTOR, Math.ceil(n / SECTOR)));
  if (typeof installed === 'string') {
    return { stop: `The eMMC does not hold edk2-rk3576 firmware that can be read (${installed}) Write "UEFI firmware, whole image" instead. Nothing was written.` };
  }
  if (installed.board && installed.board !== u.boardId) {
    return { stop: `The firmware on the eMMC is for ${installed.dt || installed.stampBoard}, not this board. Nothing was written.` };
  }
  u.log(`Installed firmware: ${installed.version ?? 'version not found'} (${installed.dt}); new: ${next.version ?? 'version not found'}.`);

  let settings: UpgradeSummary['settings'] = 'reset';
  let backup: string | null = null;
  let source = sliceSource(u.image, FIRST_LBA * SECTOR, u.image.size - FIRST_LBA * SECTOR);
  if (u.keepSettings) {
    if (!sameSlot(installed, next)) {
      return { stop: `The UEFI settings are at sector ${installed.nvdata.lba} on the board but at ${next.nvdata.lba} in the new image, so they cannot be carried over. Choose "Reset the settings", or use an image with the same layout. Nothing was written.` };
    }
    const nv = await read(next.nvdata.lba, next.nvdata.sectors);
    if (!nv) return { stop: `The UEFI settings could not be read from the board (sector ${next.nvdata.lba}, tried three times). Nothing was written.` };
    if (isEmptySlot(nv)) {
      settings = 'none';
      u.log('The board has no saved UEFI settings (the slot is empty); the image\'s empty slot is written.');
    } else if (!isVariableStore(nv)) {
      return { stop: `What was read from the UEFI settings slot (sector ${next.nvdata.lba}) is not a variable store (no _FVH), so it is not written back. Nothing was written.` };
    } else {
      const s = await u.saveBackup(nv);
      if (!s.path) return { stop: `The copy of the UEFI settings could not be saved on this computer${s.error ? `: ${s.error}` : ''}. Nothing was written.` };
      backup = s.path;
      settings = 'kept';
      source = patchedSource(source, [{ offset: (next.nvdata.lba - FIRST_LBA) * SECTOR, data: nv }]);
    }
  }
  return {
    regions: [{ lba: FIRST_LBA, source, label: 'The firmware' }],
    summary: {
      kind: 'upgrade', manufacturer: probe.manufacturer ?? null, capacity: probe.capacity, installed: installed.version, next: next.version,
      settings, backup, nvdataLba: next.nvdata.lba, nvdataSectors: next.nvdata.sectors, lba: FIRST_LBA, bytes: source.size,
    },
  };
}

