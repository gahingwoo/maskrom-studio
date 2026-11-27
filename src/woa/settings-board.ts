// Where a board keeps its UEFI settings and how they get there over MaskROM:
// reading the 192 KiB area (and the firmware's build stamp, which says
// whether the release's settings list was made for it), and putting edited
// settings into the regions of a firmware write.
//
// - TaishanPi 3M, CM5-IO: the FIT image "nvdata" on the eMMC, found from the
//   installed firmware's FIT (sector 43648, 384 sectors in every release so
//   far), below 32 MiB, where reads over MaskROM are trusted.
// - ROCK 4D: SPI NOR from sector 32256 (0xFC0000) to the end of the 16 MiB.

import { readFirmware, SECTOR } from './edk2-image';
import { readSpiFirmware } from './spi-image';
import { TRUSTED_READ_BYTES } from './maskrom-regions';
import { bytesSource, patchedSource, type ByteSource } from './pieces';
import { isErasedArea, NV_REGION_BYTES, parseVarStore, VarStoreError } from './uefi-vars';
import { BootOrderError } from './boot-options';
import { planSettings, SettingsError, type SettingOption, type SettingsPlan, type SettingsRequest } from './uefi-settings';
import type { Region } from './stage-layout';
import type { WoaBoard } from './boards';
import type { WebflashTarget } from '../web/webflash/boards';

export const AREA_SECTORS = NV_REGION_BYTES / SECTOR;

export interface BoardArea {
  lba: number;
  area: Uint8Array;
  /** The build stamp, "rk3576-<Board>-<version>", or null when it was not found. */
  stamp: string | null;
  dt: string;
  /** Why the area is not a store this app writes to (VarStoreError), or null; "erased" for a store never formatted. */
  problem: string | null;
}

type Read = (lba: number, sectors: number) => Promise<Uint8Array | null>;

/** Read the board's settings area and its firmware stamp; a sentence when there is none to read. */
export async function readBoardArea(board: WoaBoard, read: Read): Promise<BoardArea | string> {
  let lba: number;
  let stamp: string | null = null;
  let dt = '';
  if (board.spi) {
    const fw = await readSpiFirmware(async (o, n) => read(o / SECTOR, Math.ceil(n / SECTOR)), board.spi.fitLba, true);
    if (typeof fw === 'string') return `The SPI NOR flash does not hold edk2-rk3576 firmware (${fw}), so there are no UEFI settings to read.`;
    if (fw.board && fw.board !== board.id) return `The firmware on the SPI NOR flash is for ${fw.dt}, not the ${board.name}.`;
    lba = board.spi.nvdataLba;
    stamp = fw.stampBoard && fw.version ? `rk3576-${fw.stampBoard}-${fw.version}` : null;
    dt = fw.dt;
  } else {
    const fw = await readFirmware(async (o, n) => read(o / SECTOR, Math.ceil(n / SECTOR)));
    if (typeof fw === 'string') return `The eMMC does not hold edk2-rk3576 firmware (${fw}), so there are no UEFI settings to read.`;
    if (fw.board && fw.board !== board.id) return `The firmware on the eMMC is for ${fw.dt}, not the ${board.name}.`;
    if (fw.nvdata.sectors !== AREA_SECTORS) return `The firmware keeps its UEFI settings in ${fw.nvdata.sectors} sectors, not ${AREA_SECTORS}; this layout is not one this app knows.`;
    if ((fw.nvdata.lba + fw.nvdata.sectors) * SECTOR > TRUSTED_READ_BYTES) return 'The UEFI settings lie past the first 32 MiB, which MaskROM does not read reliably.';
    lba = fw.nvdata.lba;
    stamp = fw.stampBoard && fw.version ? `rk3576-${fw.stampBoard}-${fw.version}` : null;
    dt = fw.dt;
  }
  const area = await read(lba, AREA_SECTORS);
  if (!area || area.length !== NV_REGION_BYTES) return `The UEFI settings could not be read (sector ${lba}).`;
  let problem: string | null = null;
  if (isErasedArea(area)) problem = 'erased';
  else {
    try { parseVarStore(area); } catch (e) {
      if (e instanceof VarStoreError) problem = e.message; else throw e;
    }
  }
  return { lba, area, stamp, dt, problem };
}

/** planSettings with its refusals turned into a sentence that ends the job. */
export function tryPlan(area: Uint8Array, req: SettingsRequest, options: SettingOption[], same: boolean): SettingsPlan | { stop: string } {
  try {
    return planSettings(area, req, options, same);
  } catch (e) {
    if (e instanceof VarStoreError || e instanceof SettingsError || e instanceof BootOrderError) return { stop: `${e.message} Nothing was written.` };
    throw e;
  }
}

/** Settings to apply in a firmware write: the release's options and the values asked for (option id to value). */
export interface FlashSettings { options: SettingOption[]; edits: Record<string, number> }

/**
 * Add the settings to a firmware write. A write of the whole image carries
 * the image's erased area, which becomes a new store with the edited values
 * (the firmware is the release's own, so its settings list applies); a write
 * that keeps the board's settings gets one more region, the board's area
 * with the values changed. `regions` are firmwareRegions' (one region).
 */
export async function withFlashSettings(board: WoaBoard, target: WebflashTarget, image: ByteSource, regions: Region[], read: Read | undefined,
  s: FlashSettings, log: (line: string) => void): Promise<{ regions: Region[]; variables: string[] } | { stop: string }> {
  const slotLba = board.spi ? board.spi.nvdataLba : await (async () => {
    const fw = await readFirmware((o, n) => (o + n <= image.size ? image.read(o, n) : null));
    return typeof fw === 'string' ? null : fw.nvdata.lba;
  })();
  if (slotLba === null) return { stop: 'The image\'s UEFI settings slot could not be found, so the settings cannot be applied. Nothing was written.' };
  const r = regions[0];
  const start = r.lba * SECTOR;
  const slot = slotLba * SECTOR;
  if (regions.length === 1 && start <= slot && slot + NV_REGION_BYTES <= start + r.source.size) {
    const erased = r.source.read(slot - start, NV_REGION_BYTES);
    if (!isErasedArea(erased)) return { stop: 'The image\'s UEFI settings slot is not erased, so its layout is not one this app knows. Nothing was written.' };
    const p = tryPlan(erased, { kind: 'edit', edits: s.edits }, s.options, true);
    if ('stop' in p) return p;
    if (!p.bytes) return { regions, variables: [] };
    log(`The new firmware's settings area is written with ${p.variables.join(', ')} set.`);
    return { regions: [{ ...r, source: patchedSource(r.source, [{ offset: slot - start, data: p.bytes }]) }], variables: p.variables };
  }
  if (!target.id.endsWith('-keep')) return { stop: 'This write neither covers the UEFI settings nor keeps them, so the settings cannot be applied. Nothing was written.' };
  if (!read) return { stop: 'The board cannot be read, so its UEFI settings cannot be changed. Nothing was written.' };
  const area = await read(slotLba, AREA_SECTORS);
  if (!area || area.length !== NV_REGION_BYTES) return { stop: `The UEFI settings could not be read (sector ${slotLba}). Nothing was written.` };
  const p = tryPlan(area, { kind: 'edit', edits: s.edits }, s.options, true);
  if ('stop' in p) return p;
  if (!p.bytes) { log('The board\'s UEFI settings already have the values asked for.'); return { regions, variables: [] }; }
  log(`The board's UEFI settings are written back with ${p.variables.join(', ')} changed${p.reclaimed ? ' (the store was compacted to make room)' : ''}.`);
  return { regions: [...regions, { lba: slotLba, source: bytesSource(p.bytes), label: 'The UEFI settings' }], variables: p.variables };
}
