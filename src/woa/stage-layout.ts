// What a staged install writes to the eMMC, as a list of regions.
//
// The eMMC after the write, by sector:
//
//   0..33             new protective MBR and primary GPT (written last)
//   64..131071        the edk2-rk3576 firmware partition, not written
//   131072..          free: Windows goes here (ESP, MSR, NTFS)
//   bootFirst..       WOA-STAGE-BOOT: woa-rk3576's WinPE volume, copied with
//                     its collect.cmd replaced by the launcher
//   dataFirst..       WOA-STAGE-DATA: exFAT with the Windows image and the
//                     install script
//   linuxFirst..      Armbian, when asked for: its root partition, which the
//                     install keeps (armbian-hybrid.ts); its U-Boot FIT goes
//                     into the firmware's slot at 0x10000
//   end-33..end-1     backup GPT
//
// The firmware boots \EFI\Boot\bootaa64.efi from the first FAT volume on
// the eMMC that has it, which is WOA-STAGE-BOOT, because the new table has
// no other. WinPE runs the install, and the install deletes both staging
// partitions and extends Windows over them. See docs/dev/design.md.

import { FatVolume } from './fat32';
import {
  buildGpt, findFirmwarePartition, parsePrimaryGpt, randomGuid, SECTOR, TYPE_BASIC_DATA,
  FIRMWARE_FIRST_LBA, FIRMWARE_LAST_LBA, type GptPartition,
} from './gpt';
import { buildExfat } from './exfat';
import { bytesSource, concatSource, patchedSource, sliceSource, type ByteSource } from './pieces';
import { crlf, INSTALL, LAUNCHER } from './stage-scripts';
import type { WindowsTarget, WoaBoard } from './boards';
import { certsCmd, trustedCerts } from './certs';
import { AUTOLOGON_FILE, autoLogonScript, setupComplete, unattendXml, type SetupOptions } from './setup-files';
import { anyTrim, CHROME_MSI, trimCmd } from './trim';
import { CHARSIU_SETUP_PATH, charsiuGenerated } from './charsiu-desktop';
import { SELFTEST_FILE, selfTestScript } from './selftest';
import { desktopScripts } from './desktop-tools';
import { BROWSER_GPU_FILE, browserGpuScript } from './browser-gpu';
import { layoutIni, planLayout, WHOLE_DISK, type Layout, type LayoutChoice } from './windows-layout';
import { ATTR_LEGACY_BOOTABLE, resizeLeavesTableAlone, SLOT_LBA, SLOT_SECTORS, TYPE_LINUX_ROOT_ARM64, type ArmbianParts } from './armbian-hybrid';

const ALIGN = 2048; // 1 MiB
/** Windows 11 23H2 applied with /Compact takes about 10 GB; leave room for updates and a page file. */
export const MIN_WINDOWS_BYTES = 16 * 1024 ** 3;
/** Where the Windows partitions start: right after the firmware partition. */
export const WINDOWS_FIRST_LBA = FIRMWARE_LAST_LBA + 1;

export interface Region {
  /** First sector on the eMMC. */
  lba: number;
  source: ByteSource;
  label: string;
}

export interface StageImage {
  source: ByteSource;
  /** install.wim or install.esd: the name it gets on the staging volume. */
  name: 'install.wim' | 'install.esd';
  sha256: string | null;
  index: number;
  edition: string;
  build: number;
}

/**
 * Where Windows goes. The eMMC keeps the edk2-rk3576 firmware partition; an
 * SD card or an NVMe drive gets a fresh GPT with Windows from 1 MiB on.
 */
export type DiskTarget = WindowsTarget;

/** The smallest SD card or NVMe drive a staged install is offered for. */
export const MIN_DISK_BYTES = 30e9;

export interface StageInput {
  board: WoaBoard;
  /** Default 'emmc'. */
  target?: DiskTarget;
  diskBytes: number;
  /** Sectors 0..33 of the disk as they are now (the eMMC's partition table; ignored for SD and NVMe). */
  head: Uint8Array;
  /** woa-rk3576's WinPE release image, decompressed (winpe.img). */
  winpe: ByteSource;
  image: StageImage;
  rand: (n: number) => Uint8Array;
  appVersion: string;
  now?: Date;
  /** First start and SSH; defaults to Windows' own setup and no SSH. */
  setup?: SetupOptions;
  /**
   * More files for the staging volume: "openssh/..." (the release files, when
   * SSH is on) and "extra-drivers/..." (driver packages the user added).
   */
  extras?: Array<{ path: string; data: Uint8Array }>;
  /** How the disk is shared after the install; default: Windows takes all of it. */
  layout?: LayoutChoice;
  /**
   * Armbian next to Windows on the same disk (the eMMC, or the NVMe drive
   * where boards.ts oneDisk says so): its root partition goes into a
   * partition of `partitionBytes` at the end of the disk; on the eMMC its
   * U-Boot FIT also goes into the firmware's slot. The layout is then planned
   * on the space before it.
   */
  armbian?: { parts: ArmbianParts; partitionBytes: number };
}

export interface StagePlan {
  /** In the order they are written; the primary table last. */
  regions: Region[];
  diskGuid: string;
  bootFirst: number;
  dataFirst: number;
  /** Bytes the Windows partitions get before the staging space is added back. */
  windowsBytes: number;
  /** Bytes sent to the board. */
  totalBytes: number;
  /** What is on the eMMC now besides the firmware: it is removed. */
  removed: GptPartition[];
  ini: string;
  /** The disk after the install: Windows, a data partition, free space. */
  layout: Layout;
  /** Thumbprints of the certificates the installed Windows will trust. */
  certificates: string[];
  /** The Armbian partition, when there is one. */
  armbian: { firstLba: number; bytes: number; guid: string } | null;
}

export class StageError extends Error {}

const alignDown = (x: number) => Math.floor(x / ALIGN) * ALIGN;
const alignUp = (x: number) => Math.ceil(x / ALIGN) * ALIGN;

/** The WINPE partition of woa-rk3576's image: a GPT with one partition at sector 2048. */
export function winpeVolume(winpe: ByteSource): ByteSource {
  if (winpe.size < 34 * SECTOR) throw new StageError('The WinPE image is too small.');
  const t = parsePrimaryGpt(winpe.read(0, 34 * SECTOR));
  const p = t.partitions[0];
  if (!p || t.partitions.length !== 1) throw new StageError('The WinPE image does not have the one partition woa-rk3576 builds.');
  const len = (p.lastLba - p.firstLba + 1) * SECTOR;
  if (p.firstLba * SECTOR + len > winpe.size) throw new StageError('The WinPE image is shorter than its partition table says.');
  return sliceSource(winpe, p.firstLba * SECTOR, len);
}

export function stageIni(f: Record<string, string | number>): string {
  const lines = ['# Maskrom Studio staged install. Read by woa-stage.cmd on the board.'];
  for (const [k, v] of Object.entries(f)) {
    const s = String(v);
    if (/[\r\n=%!^&|<>"]/.test(s)) throw new StageError(`a value for ${k} has a character the install script cannot take`);
    lines.push(`${k}=${s}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

const TARGET_WORDS: Record<DiskTarget, string> = { emmc: 'the eMMC', sd: 'an SD card', nvme: 'an NVMe drive' };

/** Why Windows cannot go to this target on this board (boards.ts windowsTargets). */
export function targetRefusal(board: WoaBoard, target: DiskTarget): string {
  const why = target === 'emmc' && !board.emmc ? ` The ${board.name} has no eMMC.` : '';
  return `Windows is not installed to ${TARGET_WORDS[target]} on the ${board.name}.${why} Nothing was written.`;
}

export function planStage(o: StageInput): StagePlan {
  const target = o.target ?? 'emmc';
  const diskSectors = Math.floor(o.diskBytes / SECTOR);
  let fw: GptPartition | null = null;
  let removed: GptPartition[] = [];
  let table: ReturnType<typeof parsePrimaryGpt> | null = null;
  if (!o.board.windowsTargets.includes(target)) throw new StageError(targetRefusal(o.board, target));
  if (target === 'emmc') {
    const { minBytes, maxBytes } = o.board.emmc!;
    if (o.diskBytes < minBytes || o.diskBytes > maxBytes) {
      throw new StageError(`The eMMC is ${o.diskBytes} bytes, not the size of the ${o.board.name}'s eMMC (${minBytes / 1e9} to ${maxBytes / 1e9} GB). Nothing was written.`);
    }
    try {
      table = parsePrimaryGpt(o.head);
    } catch (e) {
      throw new StageError(`${(e as Error).message} Write the firmware with "UEFI firmware, whole image" first.`);
    }
    const found = findFirmwarePartition(table);
    if (typeof found === 'string') throw new StageError(`${found} Write the firmware with "UEFI firmware, whole image" first.`);
    fw = found;
    removed = table.partitions.filter((p) => p !== fw);
  } else {
    if (o.diskBytes < MIN_DISK_BYTES) {
      throw new StageError(`The ${target === 'sd' ? 'SD card' : 'NVMe drive'} is ${(o.diskBytes / 1e9).toFixed(1)} GB; at least ${MIN_DISK_BYTES / 1e9} GB are needed. Nothing was written.`);
    }
    try { table = parsePrimaryGpt(o.head); removed = table.partitions; } catch { /* no GPT: nothing to list */ }
  }
  const windowsFirst = target === 'emmc' ? WINDOWS_FIRST_LBA : ALIGN;

  // The WinPE volume, with the launcher in place of collect.cmd, as the parts of it that hold something.
  const peVol = winpeVolume(o.winpe);
  const fat = new FatVolume(peVol);
  for (const need of ['EFI/Boot/bootaa64.efi', 'sources/boot.wim', 'woa-drivers/dwcsdhc', 'woa-debug/collect.cmd']) {
    if (!fat.find(need)) throw new StageError(`The WinPE image has no ${need}. Use woa-rk3576 release 0.1.1 or later.`);
  }
  const launcher = fat.replaceFile('woa-debug/collect.cmd', crlf(LAUNCHER));
  const bootSectors = alignUp(Math.ceil(peVol.size / SECTOR));

  const diskGuid = randomGuid(o.rand);
  const bootGuid = randomGuid(o.rand);
  const dataGuid = randomGuid(o.rand);
  const serial = new DataView(o.rand(4).buffer).getUint32(0, true);
  const lastUsable = diskSectors - 34;

  // The staging data volume. Its size does not depend on where it goes, and
  // the script's numbers do not change its cluster count, so two passes settle it.
  // The drivers' test certificates: WinPE's driver catalogs, the driver package's and those of the extra drivers.
  const setup = o.setup ?? { skipSetup: null, ssh: false, sshKey: '' };
  const extras = (o.extras ?? []).filter((e) => e.data.length > 0);
  for (const e of extras) {
    if (!/^(openssh|extra-drivers|rk3576-drivers|chrome|rk3576-tools|charsiu)\/[^\\:*?"<>|]+$/.test(e.path) || e.path.split('/').some((p) => p === '..' || p === '')) {
      throw new StageError(`${e.path} cannot go on the staging volume.`);
    }
  }
  if (setup.ssh && !extras.some((e) => e.path === 'openssh/sshd.exe')) throw new StageError('SSH is on, but the OpenSSH files are missing.');
  if (setup.trim?.chrome && !extras.some((e) => e.path === CHROME_MSI.path)) throw new StageError('Chrome is chosen, but its installer is missing.');
  if (setup.rkTools && !extras.some((e) => e.path === 'rk3576-tools/offline-install.cmd')) throw new StageError('The RK3576 tools are chosen, but the bundle is missing.');
  if (setup.charsiuDesktop && !extras.some((e) => e.path === CHARSIU_SETUP_PATH)) throw new StageError('Charsiu Desktop is chosen, but its installer is missing.');
  const catalogs = [
    ...fat.listFiles('woa-drivers').filter((p) => /\.cat$/i.test(p)).map((p) => fat.readFile(p)),
    ...fat.listFiles('woa-audio').filter((p) => /\.cat$/i.test(p)).map((p) => fat.readFile(p)),
    ...extras.filter((e) => /^(extra-drivers|rk3576-drivers)\/.*\.cat$/i.test(e.path)).map((e) => e.data),
  ];
  const certs = trustedCerts(catalogs);
  const generated = [
    ...(certs.length ? [{ name: 'woa-certs.cmd', source: bytesSource(crlf(certsCmd(certs))) }] : []),
    { name: 'SetupComplete.cmd', source: bytesSource(crlf(setupComplete(setup))) },
    { name: SELFTEST_FILE, source: bytesSource(crlf(selfTestScript({ appVersion: o.appVersion }))) },
    ...desktopScripts().map((f) => ({ name: f.name, source: bytesSource(crlf(f.text)) })),
    ...(setup.browserGpu !== false ? [{ name: BROWSER_GPU_FILE, source: bytesSource(crlf(browserGpuScript())) }] : []),
    ...(setup.charsiuDesktop ? charsiuGenerated(extras).map((f) => ({ name: f.name, source: bytesSource(crlf(f.text)) })) : []),
    ...(setup.skipSetup ? [{ name: 'unattend.xml', source: bytesSource(crlf(unattendXml(setup.skipSetup))) }] : []),
    ...(setup.skipSetup?.autoLogonAlways ? [{ name: AUTOLOGON_FILE, source: bytesSource(crlf(autoLogonScript(setup.skipSetup))) }] : []),
    ...(anyTrim(setup.trim) ? [{ name: 'woa-trim.cmd', source: bytesSource(crlf(trimCmd(setup.trim!))) }] : []),
    ...(setup.ssh && setup.sshKey.trim() ? [{ name: 'ssh-key/administrators_authorized_keys', source: bytesSource(crlf(`${setup.sshKey.trim()}\n`)) }] : []),
  ];
  const files = (ini: string) => [
    { name: o.image.name, source: o.image.source },
    { name: 'woa-stage.ini', source: bytesSource(new TextEncoder().encode(ini)) },
    { name: 'woa-stage.cmd', source: bytesSource(crlf(INSTALL)) },
    ...generated,
    ...extras.filter((e) => setup.ssh || !e.path.startsWith('openssh/')).map((e) => ({ name: e.path, source: bytesSource(e.data) })),
  ];
  const choice = o.layout ?? setup.layout ?? WHOLE_DISK;
  // Armbian's partition: at the very end, so Windows and the staging space come before it.
  let linuxFirst = lastUsable + 1;
  let linuxSectors = 0;
  const linuxGuid = o.armbian ? randomGuid(o.rand) : '';
  if (o.armbian) {
    // One disk for both: the eMMC (its slot gets Armbian's U-Boot here), or the NVMe drive on a board whose
    // firmware slot is filled over MaskROM in a job of its own (boards.ts oneDisk).
    if (target !== 'emmc' && !(target === 'nvme' && o.board.oneDisk === 'nvme')) {
      throw new StageError(`Armbian next to Windows cannot go onto ${TARGET_WORDS[target]} on the ${o.board.name}. Nothing was written.`);
    }
    if (choice.linuxReserveBytes > 0) throw new StageError('Space kept for Linux and an Armbian install cannot both be chosen. Nothing was written.');
    const root = o.armbian.parts.root.size;
    if (o.armbian.partitionBytes < root) {
      throw new StageError(`The Armbian partition (${(o.armbian.partitionBytes / 1e9).toFixed(1)} GB) is smaller than Armbian's root file system (${(root / 1e9).toFixed(1)} GB). Nothing was written.`);
    }
    linuxSectors = alignUp(Math.ceil(o.armbian.partitionBytes / SECTOR));
    linuxFirst = alignDown(lastUsable + 1 - linuxSectors);
    if (!resizeLeavesTableAlone(linuxFirst + linuxSectors - 1, diskSectors)) throw new StageError('The Armbian partition would not end at the end of the disk.');
  }
  const freeBytes = (linuxFirst - windowsFirst) * SECTOR;
  const layout = planLayout(freeBytes, choice);
  if ('problem' in layout) throw new StageError(`${layout.problem} Nothing was written.`);
  const iniFor = (bootFirst: number, dataFirst: number) => stageIni({
    tool: `Maskrom Studio ${o.appVersion}`,
    board: o.board.id,
    disk_guid: diskGuid,
    disk_bytes: o.diskBytes,
    target,
    fw_offset: fw ? FIRMWARE_FIRST_LBA * SECTOR : 'none',
    fw_size: fw ? (FIRMWARE_LAST_LBA - FIRMWARE_FIRST_LBA + 1) * SECTOR : 'none',
    windows_offset_kb: (windowsFirst * SECTOR) / 1024,
    boot_offset: bootFirst * SECTOR,
    data_offset: dataFirst * SECTOR,
    image: o.image.name,
    image_sha256: o.image.sha256 ?? '',
    index: o.image.index,
    edition: o.image.edition.replace(/[^\x20-\x7e]/g, '?'),
    build: o.image.build,
    skip_setup: setup.skipSetup ? 1 : 0,
    ssh: setup.ssh ? 1 : 0,
    certificates: certs.map((c) => c.thumbprint).join(' ') || 'none',
    linux_offset: o.armbian ? linuxFirst * SECTOR : 'none',
    ...(setup.armbianOnSd ? { armbian_sd: 1 } : {}),
    ...layoutIni((bootFirst - windowsFirst) * SECTOR, layout, choice.windowsBytes === null),
  });
  const when = o.now ?? new Date();
  const first = buildExfat({ files: files(iniFor(0, 0)), label: 'WOASTAGE', partitionOffset: 0, serial, when });
  const dataSectors = first.volumeSectors;
  const dataFirst = alignDown(linuxFirst - dataSectors);
  const bootFirst = dataFirst - bootSectors;
  const windowsBytes = (bootFirst - windowsFirst) * SECTOR;
  if (windowsBytes < MIN_WINDOWS_BYTES) {
    throw new StageError(`The Windows image and WinPE take ${Math.round(((dataSectors + bootSectors) * SECTOR) / 1e9)} GB of the eMMC while they are staged, which leaves ${(windowsBytes / 1e9).toFixed(1)} GB to install into; at least ${MIN_WINDOWS_BYTES / 1e9} GB are needed. Use an image with only the edition you want (wimlib-imagex export, or DISM /Export-Image).`);
  }
  const ini = iniFor(bootFirst, dataFirst);
  const data = buildExfat({ files: files(ini), label: 'WOASTAGE', partitionOffset: dataFirst, serial, when });
  if (data.volumeSectors !== dataSectors) throw new StageError('the staging volume changed size between passes');

  // The volume's "hidden sectors" (where it starts on the disk), in the boot
  // sector and its backup, as mkfs.vfat would have written them here.
  const bs = peVol.read(0, SECTOR);
  const hidden = new Uint8Array(4);
  new DataView(hidden.buffer).setUint32(0, bootFirst, true);
  const backupBoot = bs[50] | (bs[51] << 8);
  const pe = patchedSource(peVol, [
    ...launcher,
    { offset: 28, data: hidden },
    ...(backupBoot > 0 && backupBoot < 32 ? [{ offset: backupBoot * SECTOR + 28, data: hidden }] : []),
  ]);

  const gpt = buildGpt({
    diskSectors, diskGuid, keep: fw, ...(table && fw ? { mbr: table.mbr } : {}),
    parts: [
      { type: TYPE_BASIC_DATA, guid: bootGuid, firstLba: bootFirst, lastLba: bootFirst + bootSectors - 1, name: 'WOA-STAGE-BOOT' },
      { type: TYPE_BASIC_DATA, guid: dataGuid, firstLba: dataFirst, lastLba: dataFirst + dataSectors - 1, name: 'WOA-STAGE-DATA' },
      ...(o.armbian ? [{ type: TYPE_LINUX_ROOT_ARM64, guid: linuxGuid, firstLba: linuxFirst, lastLba: linuxFirst + linuxSectors - 1, name: 'Armbian', attributes: ATTR_LEGACY_BOOTABLE }] : []),
    ],
  });

  const regions: Region[] = [];
  for (const [a, b] of fat.usedRanges()) {
    regions.push({ lba: bootFirst + a / SECTOR, source: sliceSource(pe, a, b - a), label: 'WinPE' });
  }
  regions.push({ lba: dataFirst, source: concatSource(data.pieces), label: 'Windows image' });
  if (o.armbian) regions.push({ lba: linuxFirst, source: o.armbian.parts.root, label: 'Armbian root file system' });
  // The slot is on the eMMC: with Windows and Armbian on the NVMe drive it is written over MaskROM instead.
  if (o.armbian && target === 'emmc') {
    if (o.armbian.parts.fit.size > SLOT_SECTORS * SECTOR) throw new StageError('Armbian\'s U-Boot is larger than the firmware\'s slot.');
    regions.push({ lba: SLOT_LBA, source: o.armbian.parts.fit, label: 'Armbian U-Boot (firmware slot)' });
  }
  regions.push({ lba: gpt.backupStart, source: bytesSource(gpt.backup), label: 'backup partition table' });
  regions.push({ lba: 0, source: bytesSource(gpt.primary), label: 'partition table' });
  for (const r of regions) {
    if (r.source.size % SECTOR) throw new StageError(`${r.label} is not a whole number of sectors`);
    const inSlot = !!o.armbian && target === 'emmc' && r.lba === SLOT_LBA && r.lba + r.source.size / SECTOR <= SLOT_LBA + SLOT_SECTORS;
    if (r.lba !== 0 && r.lba < windowsFirst && !inSlot) throw new StageError(`${r.label} would overwrite the firmware`);
  }
  return {
    regions, diskGuid, bootFirst, dataFirst, windowsBytes, removed, ini, layout, certificates: certs.map((c) => c.thumbprint),
    armbian: o.armbian ? { firstLba: linuxFirst, bytes: linuxSectors * SECTOR, guid: linuxGuid } : null,
    totalBytes: regions.reduce((s, r) => s + r.source.size, 0),
  };
}
