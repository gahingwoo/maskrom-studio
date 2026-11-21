// GUID partition tables: read the primary table the board's eMMC has now,
// and build the one the staged install leaves behind.
//
// The edk2-rk3576 eMMC images carry a primary GPT only (sectors 0 to 33);
// their backup header is never written, because the image is 32 MiB and the
// backup belongs at the end of the disk. Over Maskrom the end of the disk
// cannot be read back reliably anyway (see CLAUDE.md), so everything here
// works from the primary table, and a new table is always written whole:
// protective MBR, primary header and entries, and the backup entries and
// header at the end of the disk.
//
// No DOM and no Node: the Maskrom worker and the on-board helper both use it.

export const SECTOR = 512;
/** Sectors 0..33: protective MBR, header, 128 entries of 128 bytes. */
export const PRIMARY_SECTORS = 34;
const ENTRY_SIZE = 128;
const ENTRY_COUNT = 128;
const ENTRIES_SECTORS = (ENTRY_SIZE * ENTRY_COUNT) / SECTOR; // 32

export const TYPE_BASIC_DATA = 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7';
export const TYPE_ESP = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b';
/** The type edk2-rk3576's package.sh gives the firmware partition. */
export const TYPE_RK_FIRMWARE = '8da63339-0007-60c0-c436-083ac8230908';

let table: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** GUID bytes in the mixed-endian on-disk order, as a lower-case string. */
export function guidToString(b: Uint8Array): string {
  const h = (i: number) => b[i].toString(16).padStart(2, '0');
  return [
    h(3) + h(2) + h(1) + h(0), h(5) + h(4), h(7) + h(6), h(8) + h(9),
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15),
  ].join('-');
}

export function guidFromString(s: string): Uint8Array {
  const hex = s.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a GUID: ${s}`);
  const raw = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  const out = new Uint8Array(16);
  out.set([raw[3], raw[2], raw[1], raw[0], raw[5], raw[4], raw[7], raw[6]]);
  out.set(raw.subarray(8), 8);
  return out;
}

/** A random (version 4) GUID string from 16 random bytes. */
export function randomGuid(rand: (n: number) => Uint8Array): string {
  const r = rand(16);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const h = Array.from(r, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface GptPartition {
  /** 1-based entry number. */
  index: number;
  type: string;
  guid: string;
  firstLba: number;
  /** Inclusive, as on disk. */
  lastLba: number;
  attributes: bigint;
  name: string;
  /** The 128 bytes of the entry as they were read, kept so the firmware entry is copied unchanged. */
  raw: Uint8Array;
}

export interface GptTable {
  diskGuid: string;
  firstUsable: number;
  lastUsable: number;
  /** Where the header says the backup header is: the last sector of the disk it was made for. */
  backupLba: number;
  partitions: GptPartition[];
  /** Sector 0 as read. */
  mbr: Uint8Array;
}

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const u64 = (b: Uint8Array, o: number) => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true));

/** Parse sectors 0..33. Throws with a sentence for the user when it is not a valid primary GPT. */
export function parsePrimaryGpt(head: Uint8Array): GptTable {
  if (head.length < PRIMARY_SECTORS * SECTOR) throw new Error('Fewer than 34 sectors were read from the start of the disk.');
  const hdr = head.subarray(SECTOR, 2 * SECTOR);
  if (new TextDecoder().decode(hdr.subarray(0, 8)) !== 'EFI PART') {
    throw new Error('The disk has no GUID partition table.');
  }
  const hdrSize = u32(hdr, 12);
  if (hdrSize < 92 || hdrSize > SECTOR) throw new Error('The partition table header has an impossible size.');
  const copy = hdr.slice(0, hdrSize);
  new DataView(copy.buffer).setUint32(16, 0, true);
  if (crc32(copy) !== u32(hdr, 16)) throw new Error('The partition table header is damaged (CRC mismatch).');
  const entriesLba = u64(hdr, 72);
  const count = u32(hdr, 80);
  const size = u32(hdr, 84);
  if (entriesLba !== 2 || size !== ENTRY_SIZE || count > ENTRY_COUNT) {
    throw new Error('The partition table has a layout this tool does not handle (entries not at sector 2, or not 128 x 128 bytes).');
  }
  const entries = head.subarray(2 * SECTOR, 2 * SECTOR + count * size);
  if (crc32(entries) !== u32(hdr, 88)) throw new Error('The partition entries are damaged (CRC mismatch).');
  const partitions: GptPartition[] = [];
  for (let i = 0; i < count; i++) {
    const e = entries.subarray(i * size, (i + 1) * size);
    if (e.subarray(0, 16).every((x) => x === 0)) continue;
    const nameBytes = e.subarray(56, 128);
    let name = '';
    for (let j = 0; j + 1 < nameBytes.length; j += 2) {
      const c = nameBytes[j] | (nameBytes[j + 1] << 8);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    partitions.push({
      index: i + 1, type: guidToString(e.subarray(0, 16)), guid: guidToString(e.subarray(16, 32)),
      firstLba: u64(e, 32), lastLba: u64(e, 40),
      attributes: new DataView(e.buffer, e.byteOffset, e.byteLength).getBigUint64(48, true),
      name, raw: e.slice(),
    });
  }
  return {
    diskGuid: guidToString(hdr.subarray(56, 72)), firstUsable: u64(hdr, 40), lastUsable: u64(hdr, 48),
    backupLba: u64(hdr, 32), partitions, mbr: head.slice(0, SECTOR),
  };
}

/** The firmware region edk2-rk3576's eMMC images create and woa-rk3576's deploy script checks for. */
export const FIRMWARE_FIRST_LBA = 64;
export const FIRMWARE_LAST_LBA = 131071;

/** The firmware partition of an edk2-rk3576 eMMC layout, or a sentence saying why there is none. */
export function findFirmwarePartition(t: GptTable): GptPartition | string {
  const p = t.partitions.find((x) => x.firstLba === FIRMWARE_FIRST_LBA);
  if (!p) return 'No partition starts at sector 64, where the edk2-rk3576 firmware partition belongs.';
  if (p.lastLba !== FIRMWARE_LAST_LBA) {
    return `The partition at sector 64 ends at sector ${p.lastLba}, not ${FIRMWARE_LAST_LBA} as the edk2-rk3576 firmware partition does.`;
  }
  if (p.index !== 1) return `The firmware partition is entry ${p.index}, not entry 1.`;
  return p;
}

export interface NewPartition {
  type: string;
  guid: string;
  firstLba: number;
  lastLba: number;
  name: string;
  attributes?: bigint;
}

function entryBytes(p: NewPartition): Uint8Array {
  const e = new Uint8Array(ENTRY_SIZE);
  const dv = new DataView(e.buffer);
  e.set(guidFromString(p.type), 0);
  e.set(guidFromString(p.guid), 16);
  dv.setBigUint64(32, BigInt(p.firstLba), true);
  dv.setBigUint64(40, BigInt(p.lastLba), true);
  dv.setBigUint64(48, p.attributes ?? 0n, true);
  for (let i = 0; i < Math.min(36, p.name.length); i++) dv.setUint16(56 + i * 2, p.name.charCodeAt(i), true);
  return e;
}

export interface BuiltGpt {
  /** Sectors 0..33. */
  primary: Uint8Array;
  /** Sectors diskSectors-33 .. diskSectors-1: the entries, then the backup header. */
  backup: Uint8Array;
  /** The sector `backup` starts at. */
  backupStart: number;
}

/**
 * A complete table for a disk of `diskSectors`: entry 1 is `keep` copied
 * byte for byte (the firmware partition), then `parts` in order.
 * `mbr` is sector 0 as read; its boot code area is kept and the partition
 * records are replaced with one protective record.
 */
export function buildGpt(o: { diskSectors: number; diskGuid: string; keep: GptPartition; parts: NewPartition[]; mbr?: Uint8Array }): BuiltGpt {
  const { diskSectors } = o;
  const firstUsable = PRIMARY_SECTORS;
  const lastUsable = diskSectors - 1 - 1 - ENTRIES_SECTORS;
  const all: Array<{ firstLba: number; lastLba: number }> = [o.keep, ...o.parts];
  for (const p of all) {
    if (p.firstLba < firstUsable || p.lastLba > lastUsable || p.lastLba < p.firstLba) {
      throw new Error(`partition ${p.firstLba}-${p.lastLba} is outside the usable area ${firstUsable}-${lastUsable}`);
    }
  }
  const sorted = [...all].sort((a, b) => a.firstLba - b.firstLba);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].firstLba <= sorted[i - 1].lastLba) throw new Error('partitions overlap');
  }

  const entries = new Uint8Array(ENTRY_SIZE * ENTRY_COUNT);
  entries.set(o.keep.raw.subarray(0, ENTRY_SIZE), 0);
  o.parts.forEach((p, i) => entries.set(entryBytes(p), (i + 1) * ENTRY_SIZE));
  const entriesCrc = crc32(entries);

  const header = (current: number, backup: number, entriesLba: number) => {
    const h = new Uint8Array(SECTOR);
    const dv = new DataView(h.buffer);
    h.set(new TextEncoder().encode('EFI PART'), 0);
    dv.setUint32(8, 0x00010000, true);
    dv.setUint32(12, 92, true);
    dv.setBigUint64(24, BigInt(current), true);
    dv.setBigUint64(32, BigInt(backup), true);
    dv.setBigUint64(40, BigInt(firstUsable), true);
    dv.setBigUint64(48, BigInt(lastUsable), true);
    h.set(guidFromString(o.diskGuid), 56);
    dv.setBigUint64(72, BigInt(entriesLba), true);
    dv.setUint32(80, ENTRY_COUNT, true);
    dv.setUint32(84, ENTRY_SIZE, true);
    dv.setUint32(88, entriesCrc, true);
    dv.setUint32(16, crc32(h.subarray(0, 92)), true);
    return h;
  };

  const backupLba = diskSectors - 1;
  const mbr = new Uint8Array(SECTOR);
  if (o.mbr) mbr.set(o.mbr.subarray(0, 440), 0);
  const mdv = new DataView(mbr.buffer);
  mbr[446 + 1] = 0x00; mbr[446 + 2] = 0x02; mbr[446 + 3] = 0x00; // CHS of LBA 1
  mbr[446 + 4] = 0xee;
  mbr[446 + 5] = 0xff; mbr[446 + 6] = 0xff; mbr[446 + 7] = 0xff;
  mdv.setUint32(446 + 8, 1, true);
  mdv.setUint32(446 + 12, Math.min(diskSectors - 1, 0xffffffff), true);
  mbr[510] = 0x55; mbr[511] = 0xaa;

  const primary = new Uint8Array(PRIMARY_SECTORS * SECTOR);
  primary.set(mbr, 0);
  primary.set(header(1, backupLba, 2), SECTOR);
  primary.set(entries, 2 * SECTOR);

  const backupEntriesLba = backupLba - ENTRIES_SECTORS;
  const backup = new Uint8Array((ENTRIES_SECTORS + 1) * SECTOR);
  backup.set(entries, 0);
  backup.set(header(backupLba, 1, backupEntriesLba), ENTRIES_SECTORS * SECTOR);
  return { primary, backup, backupStart: backupEntriesLba };
}
