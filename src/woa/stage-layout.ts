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
//   end-33..end-1     backup GPT
//
// The firmware boots \EFI\Boot\bootaa64.efi from the first FAT volume on
// the eMMC that has it, which is WOA-STAGE-BOOT, because the new table has
// no other. WinPE runs the install, and the install deletes both staging
// partitions and extends Windows over them. See docs/DESIGN.md.

import { FatVolume } from './fat32';
import {
  buildGpt, findFirmwarePartition, parsePrimaryGpt, randomGuid, SECTOR, TYPE_BASIC_DATA,
  FIRMWARE_FIRST_LBA, FIRMWARE_LAST_LBA, type GptPartition,
} from './gpt';
import { buildExfat } from './exfat';
import { bytesSource, concatSource, patchedSource, sliceSource, type ByteSource } from './pieces';
import { crlf, INSTALL, LAUNCHER } from './stage-scripts';
import type { WoaBoard } from './boards';
import { certsCmd, trustedCerts } from './certs';
import { setupComplete, unattendXml, type SetupOptions } from './setup-files';

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

export interface StageInput {
  board: WoaBoard;
  diskBytes: number;
  /** Sectors 0..33 of the eMMC as they are now. */
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
  /** Thumbprints of the certificates the installed Windows will trust. */
  certificates: string[];
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
  const lines = ['# WoA RK3576 Imager staged install. Read by woa-stage.cmd on the board.'];
  for (const [k, v] of Object.entries(f)) {
    const s = String(v);
    if (/[\r\n=%!^&|<>"]/.test(s)) throw new StageError(`a value for ${k} has a character the install script cannot take`);
    lines.push(`${k}=${s}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function planStage(o: StageInput): StagePlan {
  if (!o.board.windows) throw new StageError(o.board.windowsNote ?? 'Windows is not offered for this board.');
  const { minBytes, maxBytes } = o.board.windows;
  if (o.diskBytes < minBytes || o.diskBytes > maxBytes) {
    throw new StageError(`The eMMC is ${o.diskBytes} bytes, not the size of the ${o.board.name}'s eMMC (${minBytes / 1e9} to ${maxBytes / 1e9} GB). Nothing was written.`);
  }
  const diskSectors = Math.floor(o.diskBytes / SECTOR);
  let table;
  try {
    table = parsePrimaryGpt(o.head);
  } catch (e) {
    throw new StageError(`${(e as Error).message} Write the firmware with "UEFI firmware, whole image" first.`);
  }
  const fw = findFirmwarePartition(table);
  if (typeof fw === 'string') throw new StageError(`${fw} Write the firmware with "UEFI firmware, whole image" first.`);
  const removed = table.partitions.filter((p) => p !== fw);

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
  // The drivers' test certificates: WinPE's driver catalogs and those of the extra drivers.
  const setup = o.setup ?? { skipSetup: null, ssh: false, sshKey: '' };
  const extras = (o.extras ?? []).filter((e) => e.data.length > 0);
  for (const e of extras) {
    if (!/^(openssh|extra-drivers)\/[^\\:*?"<>|]+$/.test(e.path) || e.path.split('/').some((p) => p === '..' || p === '')) {
      throw new StageError(`${e.path} cannot go on the staging volume.`);
    }
  }
  if (setup.ssh && !extras.some((e) => e.path === 'openssh/sshd.exe')) throw new StageError('SSH is on, but the OpenSSH files are missing.');
  const catalogs = [
    ...fat.listFiles('woa-drivers').filter((p) => /\.cat$/i.test(p)).map((p) => fat.readFile(p)),
    ...extras.filter((e) => /^extra-drivers\/.*\.cat$/i.test(e.path)).map((e) => e.data),
  ];
  const certs = trustedCerts(catalogs);
  const generated = [
    ...(certs.length ? [{ name: 'woa-certs.cmd', source: bytesSource(crlf(certsCmd(certs))) }] : []),
    { name: 'SetupComplete.cmd', source: bytesSource(crlf(setupComplete(setup))) },
    ...(setup.skipSetup ? [{ name: 'unattend.xml', source: bytesSource(crlf(unattendXml(setup.skipSetup))) }] : []),
    ...(setup.ssh && setup.sshKey.trim() ? [{ name: 'ssh-key/administrators_authorized_keys', source: bytesSource(crlf(`${setup.sshKey.trim()}\n`)) }] : []),
  ];
  const files = (ini: string) => [
    { name: o.image.name, source: o.image.source },
    { name: 'woa-stage.ini', source: bytesSource(new TextEncoder().encode(ini)) },
    { name: 'woa-stage.cmd', source: bytesSource(crlf(INSTALL)) },
    ...generated,
    ...extras.filter((e) => setup.ssh || !e.path.startsWith('openssh/')).map((e) => ({ name: e.path, source: bytesSource(e.data) })),
  ];
  const iniFor = (bootFirst: number, dataFirst: number) => stageIni({
    tool: `WoA RK3576 Imager ${o.appVersion}`,
    board: o.board.id,
    disk_guid: diskGuid,
    disk_bytes: o.diskBytes,
    fw_offset: FIRMWARE_FIRST_LBA * SECTOR,
    fw_size: (FIRMWARE_LAST_LBA - FIRMWARE_FIRST_LBA + 1) * SECTOR,
    windows_offset_kb: (WINDOWS_FIRST_LBA * SECTOR) / 1024,
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
  });
  const when = o.now ?? new Date();
  const first = buildExfat({ files: files(iniFor(0, 0)), label: 'WOASTAGE', partitionOffset: 0, serial, when });
  const dataSectors = first.volumeSectors;
  const dataFirst = alignDown(lastUsable + 1 - dataSectors);
  const bootFirst = dataFirst - bootSectors;
  const windowsBytes = (bootFirst - WINDOWS_FIRST_LBA) * SECTOR;
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
    diskSectors, diskGuid, keep: fw, mbr: table.mbr,
    parts: [
      { type: TYPE_BASIC_DATA, guid: bootGuid, firstLba: bootFirst, lastLba: bootFirst + bootSectors - 1, name: 'WOA-STAGE-BOOT' },
      { type: TYPE_BASIC_DATA, guid: dataGuid, firstLba: dataFirst, lastLba: dataFirst + dataSectors - 1, name: 'WOA-STAGE-DATA' },
    ],
  });

  const regions: Region[] = [];
  for (const [a, b] of fat.usedRanges()) {
    regions.push({ lba: bootFirst + a / SECTOR, source: sliceSource(pe, a, b - a), label: 'WinPE' });
  }
  regions.push({ lba: dataFirst, source: concatSource(data.pieces), label: 'Windows image' });
  regions.push({ lba: gpt.backupStart, source: bytesSource(gpt.backup), label: 'backup partition table' });
  regions.push({ lba: 0, source: bytesSource(gpt.primary), label: 'partition table' });
  for (const r of regions) {
    if (r.source.size % SECTOR) throw new StageError(`${r.label} is not a whole number of sectors`);
    if (r.lba !== 0 && r.lba < WINDOWS_FIRST_LBA) throw new StageError(`${r.label} would overwrite the firmware`);
  }
  return {
    regions, diskGuid, bootFirst, dataFirst, windowsBytes, removed, ini, certificates: certs.map((c) => c.thumbprint),
    totalBytes: regions.reduce((s, r) => s + r.source.size, 0),
  };
}
