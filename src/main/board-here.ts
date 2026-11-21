// Is this app running on one of the boards, and what can it write there?
//
// On an RK3576 board running Linux (Armbian, Fedora, anything booted from an
// SD card or a USB drive) the app writes the board's own eMMC or SPI NOR
// flash directly, with no Maskrom and no second computer. This module only
// looks; the writing is the elevated helper's (helper/board-write.ts), which
// looks again before it writes.
//
// The board is recognised by its device tree compatible strings, or by the
// SMBIOS product name edk2-rk3576 reports when Linux booted through UEFI
// with ACPI. The eMMC is the mmcblk device whose card type in sysfs is
// "MMC" (an SD card says "SD"). The SPI NOR flash is an MTD device, present
// only when the kernel has the SPI flash controller driver and the device
// tree enables the flash. No Electron here: the helper uses it too.

import { readdirSync, readFileSync } from 'node:fs';
import { boardFromIds, type WoaBoard } from '../woa/boards';
import { readLinuxDiskFacts } from './linux-disks';

export interface BoardDisk {
  device: string;
  bytes: number;
  model: string;
  /** Mount points on it (all partitions); anything here refuses the disk. */
  mounts: string[];
  /** Something else using it (LVM, RAID, ...), or null. */
  busy: string | null;
}

export interface BoardMtd {
  device: string;
  name: string;
  bytes: number;
}

export interface BoardHere {
  /** RK3576 seen in the device tree or SMBIOS. */
  rk3576: boolean;
  board: WoaBoard | null;
  compatible: string[];
  smbiosProduct: string | null;
  emmc: BoardDisk | null;
  mtd: BoardMtd[];
  /** Why a write to the eMMC is refused, or null when it may be offered. */
  emmcRefusal: string | null;
}

const readText = (p: string): string | null => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

export function compatibleStrings(raw: string | null): string[] {
  return raw ? raw.split('\0').map((s) => s.trim()).filter(Boolean) : [];
}

export async function boardHere(root = ''): Promise<BoardHere> {
  const none: BoardHere = { rk3576: false, board: null, compatible: [], smbiosProduct: null, emmc: null, mtd: [], emmcRefusal: null };
  if (process.platform !== 'linux' && !root) return none;
  const compatible = compatibleStrings(readText(`${root}/proc/device-tree/compatible`) ?? readText(`${root}/sys/firmware/devicetree/base/compatible`));
  const smbiosProduct = (readText(`${root}/sys/class/dmi/id/product_name`) ?? '').trim() || null;
  const board = boardFromIds(compatible, smbiosProduct);
  const rk3576 = compatible.includes('rockchip,rk3576') || board !== null;
  if (!rk3576) return { ...none, compatible, smbiosProduct };

  let emmc: BoardDisk | null = null;
  let names: string[] = [];
  try { names = readdirSync(`${root}/sys/block`); } catch { /* none */ }
  const facts = root ? {} : await readLinuxDiskFacts();
  for (const n of names) {
    if (!/^mmcblk\d+$/.test(n)) continue;
    if ((readText(`${root}/sys/block/${n}/device/type`) ?? '').trim().toUpperCase() !== 'MMC') continue;
    const sectors = Number((readText(`${root}/sys/block/${n}/size`) ?? '0').trim());
    const device = `/dev/${n}`;
    const f = facts[device];
    emmc = {
      device, bytes: sectors * 512, model: (readText(`${root}/sys/block/${n}/device/name`) ?? '').trim() || 'eMMC',
      mounts: f?.allMounts ?? [], busy: f?.busy ?? null,
    };
    break;
  }

  const mtd: BoardMtd[] = [];
  let mtds: string[] = [];
  try { mtds = readdirSync(`${root}/sys/class/mtd`); } catch { /* none */ }
  for (const n of mtds) {
    if (!/^mtd\d+$/.test(n)) continue;
    const type = (readText(`${root}/sys/class/mtd/${n}/type`) ?? '').trim();
    if (type !== 'nor') continue;
    mtd.push({ device: `/dev/${n}`, name: (readText(`${root}/sys/class/mtd/${n}/name`) ?? '').trim(), bytes: Number((readText(`${root}/sys/class/mtd/${n}/size`) ?? '0').trim()) });
  }

  let emmcRefusal: string | null = null;
  if (!emmc) emmcRefusal = 'Linux shows no eMMC on this board.';
  else if (!root && Object.keys(facts).length === 0) emmcRefusal = 'lsblk could not tell what is mounted, so the eMMC is not offered.';
  else if (emmc.mounts.length) emmcRefusal = `The eMMC is in use: ${emmc.mounts.join(', ')} ${emmc.mounts.length === 1 ? 'is' : 'are'} mounted from it. If this system runs from the eMMC, start it from an SD card or a USB drive instead; otherwise unmount it.`;
  else if (emmc.busy) emmcRefusal = `The eMMC is in use by ${emmc.busy}.`;
  return { rk3576, board, compatible, smbiosProduct, emmc, mtd, emmcRefusal };
}

/** What to do when the SPI NOR flash has no MTD device. */
export const NO_MTD_HELP = 'Linux shows no SPI NOR flash (no /dev/mtd device of type "nor"). The kernel needs the Rockchip SPI flash controller driver (CONFIG_SPI_ROCKCHIP_SFC, and CONFIG_MTD_SPI_NOR), and the device tree must enable the flash. Without it, write the SPI NOR over Maskrom from another computer.';
