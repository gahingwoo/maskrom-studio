// A copy of what a write over MaskROM is about to replace, kept on the
// computer before anything is written (UX audit D6): the primary partition
// table (sectors 0..33) and the UEFI settings (the nvdata slot of the
// edk2-rk3576 firmware on the eMMC). The slot is found from the installed
// firmware's own FIT, as the firmware upgrade finds it, so a different
// layout is followed rather than assumed; the TaishanPi 3M and CM5-IO
// releases have it at sector 43648, 384 sectors. Everything read lies in
// the first 32 MiB, the only part MaskROM reads back reliably.
//
// Nothing here stops a write on its own account: a board whose eMMC holds
// no edk2-rk3576 firmware simply has no settings to keep. Only a copy that
// was read but could not be saved stops it (worker: "Nothing was written").

import { readFirmware, isEmptySlot, isVariableStore, SECTOR } from './edk2-image';
import { TRUSTED_READ_BYTES, type Probe } from './maskrom-regions';
import { SPI_SETTINGS_BYTES } from './spi-image';
import type { WoaBoard } from './boards';

export interface BackupFile { name: string; data: Uint8Array }

export interface PreWriteBackup {
  files: BackupFile[];
  /** backup.txt: when, which board, what each file is, its SHA-256. */
  notes: string[];
  /** What was kept: the table, the settings, or neither. */
  table: boolean;
  settings: 'kept' | 'empty' | 'none';
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Read what is worth keeping; null when nothing could be read at all. */
export async function readPreWriteBackup(boardId: string, probe: Probe, log: (line: string) => void, now = new Date()): Promise<PreWriteBackup | null> {
  const read = probe.read;
  const files: BackupFile[] = [];
  const notes = [`Maskrom Studio: what the eMMC held before a write over MaskROM.`, `board: ${boardId}`, `taken: ${now.toISOString()}`];
  let table = false;
  let settings: PreWriteBackup['settings'] = 'none';

  const head = probe.head ?? (read ? await read(0, 34) : null);
  if (head && head.length === 34 * SECTOR) {
    files.push({ name: 'gpt-sectors-0-33.bin', data: head });
    notes.push(`gpt-sectors-0-33.bin: sectors 0..33 (protective MBR and primary GPT), sha256 ${await sha256Hex(head)}`);
    table = true;
  } else log('The partition table could not be read for the backup.');

  if (read) {
    const fw = await readFirmware(async (o, n) => read(o / SECTOR, Math.ceil(n / SECTOR)));
    if (typeof fw === 'string') {
      log(`No edk2-rk3576 firmware found on the eMMC (${fw}), so there are no UEFI settings to keep.`);
    } else if ((fw.nvdata.lba + fw.nvdata.sectors) * SECTOR > TRUSTED_READ_BYTES) {
      log('The UEFI settings lie past the first 32 MiB, which MaskROM does not read reliably; they are not copied.');
    } else {
      const nv = await read(fw.nvdata.lba, fw.nvdata.sectors);
      if (!nv) log(`The UEFI settings could not be read (sector ${fw.nvdata.lba}).`);
      else if (isEmptySlot(nv)) { settings = 'empty'; log('The UEFI settings slot is empty: nothing to keep.'); }
      else {
        const name = `nvdata-sector-${fw.nvdata.lba}-${fw.nvdata.sectors}.bin`;
        files.push({ name, data: nv });
        notes.push(`${name}: the UEFI settings of firmware ${fw.version ?? '(version not found)'} (${fw.dt}), sectors ${fw.nvdata.lba}..${fw.nvdata.lba + fw.nvdata.sectors - 1}${isVariableStore(nv) ? '' : ', not a variable store (no _FVH)'}, sha256 ${await sha256Hex(nv)}`);
        settings = 'kept';
      }
    }
  }
  if (files.length === 0) return null;
  return { files, notes, table, settings };
}

/**
 * The same copy on an SPI NOR board (ROCK 4D): the whole flash as it was
 * (16 MiB, all of it below 32 MiB, so it reads back reliably), which is
 * also the way back, and the UEFI settings blocks on their own when they
 * hold a variable store. Read only after the storage was confirmed to be
 * the SPI NOR flash (spiStorageProblem).
 */
export async function readSpiPreWriteBackup(board: WoaBoard, probe: Probe, log: (line: string) => void, now = new Date()): Promise<PreWriteBackup | null> {
  const spi = board.spi;
  const read = probe.read;
  if (!spi || !read) return null;
  const CHUNK = 2048; // sectors, 1 MiB
  const total = spi.bytes / SECTOR;
  const whole = new Uint8Array(spi.bytes);
  for (let lba = 0; lba < total; lba += CHUNK) {
    const got = await read(lba, Math.min(CHUNK, total - lba));
    if (!got) { log(`The SPI NOR flash could not be read for the backup (sector ${lba}).`); return null; }
    whole.set(got, lba * SECTOR);
  }
  const notes = [`Maskrom Studio: what the SPI NOR flash held before a write over MaskROM.`, `board: ${board.id}`, `taken: ${now.toISOString()}`];
  const name = 'spi-nor-before.bin';
  notes.push(`${name}: the whole SPI NOR flash, sectors 0..${total - 1}, sha256 ${await sha256Hex(whole)}. To go back, write it from sector 0 (rkdeveloptool wl 0 ${name}).`);
  const files: BackupFile[] = [{ name, data: whole }];
  const nv = whole.subarray(spi.nvdataLba * SECTOR, spi.nvdataLba * SECTOR + SPI_SETTINGS_BYTES);
  let settings: PreWriteBackup['settings'] = 'none';
  if (isVariableStore(nv)) {
    const nvName = `nvdata-spi-sector-${spi.nvdataLba}-${SPI_SETTINGS_BYTES / SECTOR}.bin`;
    files.push({ name: nvName, data: nv.slice() });
    notes.push(`${nvName}: the UEFI settings (store, FTW working, FTW spare), sha256 ${await sha256Hex(nv)}`);
    settings = 'kept';
  } else if (isEmptySlot(nv)) settings = 'empty';
  else log(`The SPI NOR flash holds no UEFI variable store at sector ${spi.nvdataLba}.`);
  return { files, notes, table: false, settings };
}
