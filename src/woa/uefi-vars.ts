// The UEFI variable store of edk2-rk3576, as it lies on the medium: 192 KiB,
// the variable store, then the FTW working block, then the FTW spare block,
// 64 KiB each (RK3576.fdf PcdFlashNvStorageVariable/FtwWorking/FtwSpare,
// docs/dev/image-layout.md). The eMMC boards carry it as the FIT image
// "nvdata" (sector 43648, 384 sectors); the ROCK 4D at SPI NOR 0xFC0000.
//
// Read and written the way EDK2 itself does, from these sources (edk2-stable202602):
// - RkFvbDxe.c FvbInitFvAndVariableStoreHeaders/FvbValidateFvHeaderAt: the FV
//   header (gEfiSystemNvDataFvGuid, FvLength 0x30000, HeaderLength 0x48) and
//   the store header, always gEfiAuthenticatedVariableGuid on this platform,
//   Size 0x10000 - 0x48.
// - MdeModulePkg/Include/Guid/VariableFormat.h: VARIABLE_STORE_HEADER (28
//   bytes), AUTHENTICATED_VARIABLE_HEADER (60 bytes, packed), StartId 0x55AA,
//   HEADER_ALIGNMENT 4, ALIGNMENT 1 (no padding after the name or the data).
// - RuntimeDxe/VariableParsing.c FindVariableEx: only State 0x3F (VAR_ADDED)
//   and 0x3E (VAR_ADDED & VAR_IN_DELETED_TRANSITION) are live, and an
//   in-deleted-transition copy counts only while no VAR_ADDED copy exists.
// - RuntimeDxe/Variable.c UpdateVariable: an update marks the old record
//   in-deleted-transition, appends the new one and then marks the old one
//   deleted; a delete clears the State bits of VAR_DELETED. When the new
//   record does not fit, Reclaim() builds a compacted store: every VAR_ADDED
//   record but the one being replaced, then the in-deleted-transition ones
//   that have no VAR_ADDED copy (promoted to VAR_ADDED), then the new one.
// - Include/Guid/SystemNvDataGuid.h and FaultTolerantWriteDxe
//   (UpdateWorkingBlock.c, FtwMisc.c): the working block header must equal
//   the one InitializeLocalWorkSpaceHeader() makes, and a write header that is
//   allocated but not complete is a write the next boot would finish by
//   copying the spare block over its target. Such a store is never written.
//
// Pure code over bytes, no Node APIs: it runs in the MaskROM worker too.

export const NV_REGION_BYTES = 0x30000;
export const VARIABLE_BYTES = 0x10000;
export const FTW_WORKING_AT = 0x10000;
export const FTW_WORKING_BYTES = 0x10000;
export const FTW_SPARE_AT = 0x20000;
/** PcdMaxVariableSize (Rockchip.dsc.inc): header, name and data of one non-authenticated variable. */
export const MAX_VARIABLE_SIZE = 0x2000;

export const GUID = {
  systemNvDataFv: 'fff12b8d-7696-4c8b-a985-2747075b4f50',
  authenticatedVariable: 'aaf32c78-947b-439a-a180-2e144ec37792',
  variable: 'ddcf3616-3275-4164-98b6-fe85707ffe7d',
  ftwWorkingBlock: '9e58292b-7c68-497d-a0ce-6500fd9f1b95',
  globalVariable: '8be4df61-93ca-11d2-aa0d-00e098032b8c',
  imageSecurityDatabase: 'd719b2cb-3d3a-4596-a3bc-dad00e67656f',
} as const;

export const ATTR = {
  NON_VOLATILE: 0x1, BOOTSERVICE_ACCESS: 0x2, RUNTIME_ACCESS: 0x4, HARDWARE_ERROR_RECORD: 0x8,
  AUTHENTICATED_WRITE_ACCESS: 0x10, TIME_BASED_AUTHENTICATED_WRITE_ACCESS: 0x20, APPEND_WRITE: 0x40,
} as const;

export const VAR_ADDED = 0x3f;
export const VAR_IN_DELETED_TRANSITION = 0xfe;
export const VAR_DELETED = 0xfd;
const VARIABLE_DATA = 0x55aa;
const FVH_SIGNATURE = 0x4856465f; // "_FVH"
const FVH_REVISION = 2;
const FV_HEADER_LENGTH = 0x48; // EFI_FIRMWARE_VOLUME_HEADER with BlockMap[0] and its terminator
const FV_ATTRIBUTES = 0xe36; // RkFvbDxe: READ_ENABLED_CAP|READ_STATUS|STICKY_WRITE|ERASE_POLARITY|WRITE_STATUS|WRITE_ENABLED_CAP|MEMORY_MAPPED
const STORE_HEADER = 28;
const STORE_FORMATTED = 0x5a;
const STORE_HEALTHY = 0xfe;
const AUTH_HEADER = 60;
const PLAIN_HEADER = 32;
const FTW_WORKING_HEADER = 32;
const FTW_WRITE_HEADER = 40; // EFI_FAULT_TOLERANT_WRITE_HEADER: flags, CallerId at 4, NumberOfWrites at 24, PrivateDataSize at 32
const FTW_WRITE_RECORD = 40; // EFI_FAULT_TOLERANT_WRITE_RECORD: flags, Lba at 8, Offset, Length, RelativeOffset

/** Every refusal and every damaged structure: nothing is written when one is thrown. */
export class VarStoreError extends Error {}

// --- GUIDs and CRC32 ---------------------------------------------------------

export function guidAt(b: Uint8Array, o: number): string {
  const h = (i: number) => b[o + i].toString(16).padStart(2, '0');
  return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
}

export function guidBytes(s: string): Uint8Array {
  const hex = s.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new VarStoreError(`Not a GUID: ${s}`);
  const x = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Uint8Array.of(x(3), x(2), x(1), x(0), x(5), x(4), x(7), x(6), x(8), x(9), x(10), x(11), x(12), x(13), x(14), x(15));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as gBS->CalculateCrc32 computes it (IEEE 802.3, the zlib one). */
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The FTW working block header FaultTolerantWriteDxe expects (InitializeLocalWorkSpaceHeader), for a 64 KiB work space. */
export function ftwWorkingHeader(workSpaceBytes = FTW_WORKING_BYTES): Uint8Array {
  const h = new Uint8Array(FTW_WORKING_HEADER).fill(0xff);
  h.set(guidBytes(GUID.ftwWorkingBlock), 0);
  const dv = new DataView(h.buffer);
  dv.setBigUint64(24, BigInt(workSpaceBytes - FTW_WORKING_HEADER), true);
  // The CRC covers the header with Crc and the state byte still erased.
  dv.setUint32(16, crc32(h), true);
  // WorkingBlockValid = FTW_VALID_STATE (0), WorkingBlockInvalid = FTW_INVALID_STATE (1), Reserved bits erased.
  h[20] = 0xfe;
  return h;
}

// --- parsing -----------------------------------------------------------------

export type RecordState = 'added' | 'in-deleted-transition' | 'deleted' | 'unfinished';

export interface VarRecord {
  /** Byte offset in the region. */
  offset: number;
  /** Header, name and data, unaligned (VarSize in UpdateVariable). */
  size: number;
  /** Where the next record starts (HEADER_ALIGN). */
  next: number;
  stateByte: number;
  state: RecordState;
  attributes: number;
  name: string;
  guid: string;
  data: Uint8Array;
  /** Authenticated header fields; zero for every variable the firmware's setup writes. */
  monotonicCount: bigint;
  pubKeyIndex: number;
  timestampSet: boolean;
}

export interface FtwState {
  /** Completed writes recorded in the working block (EDK2 keeps them until it reclaims the work space). */
  completed: number;
}

export interface VarStore {
  auth: boolean;
  /** Where the variable store header is (the FV HeaderLength). */
  storeAt: number;
  /** VARIABLE_STORE_HEADER.Size, from storeAt. */
  storeSize: number;
  /** The first record. */
  firstAt: number;
  /** The first free byte after the last record; all 0xFF from here to the store's end. */
  endAt: number;
  records: VarRecord[];
  /** What GetVariable would find, in store order (FindVariableEx semantics). */
  live: VarRecord[];
  ftw: FtwState;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n);
const allFf = (b: Uint8Array, from: number, to: number) => { for (let i = from; i < to; i++) if (b[i] !== 0xff) return false; return true; };
const align4 = (n: number) => (n + 3) & ~3;

function stateOf(s: number): RecordState {
  if (s === VAR_ADDED) return 'added';
  if (s === (VAR_ADDED & VAR_IN_DELETED_TRANSITION)) return 'in-deleted-transition';
  // 0xFF: the header and data were written but not marked added (step 1 of 2), 0x7F: VAR_HEADER_VALID_ONLY.
  if (s === 0xff || s === 0x7f) return 'unfinished';
  return 'deleted';
}

function utf16z(b: Uint8Array, o: number, n: number): string | null {
  if (n < 2 || n % 2) return null;
  if (u16(b, o + n - 2) !== 0) return null;
  let s = '';
  for (let i = 0; i < n - 2; i += 2) {
    const c = u16(b, o + i);
    if (c === 0) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

function checkFvHeader(b: Uint8Array): number {
  if (b.length !== NV_REGION_BYTES) throw new VarStoreError(`The UEFI settings area is ${b.length} bytes, not ${NV_REGION_BYTES}.`);
  if (allFf(b, 0, b.length)) throw new VarStoreError('The UEFI settings area is empty (erased): the firmware has not started on this board since it was written.');
  if (u32(b, 40) !== FVH_SIGNATURE) throw new VarStoreError('The UEFI settings area does not start with a firmware volume header (no _FVH).');
  if (guidAt(b, 16) !== GUID.systemNvDataFv) throw new VarStoreError('The firmware volume is not an NV data volume (its file system GUID is not gEfiSystemNvDataFvGuid).');
  if (b[55] !== FVH_REVISION) throw new VarStoreError(`The firmware volume header has revision ${b[55]}, not ${FVH_REVISION}.`);
  if (u64(b, 32) !== BigInt(NV_REGION_BYTES)) throw new VarStoreError(`The firmware volume is ${u64(b, 32)} bytes long, not ${NV_REGION_BYTES} (store, FTW working and spare blocks).`);
  const hl = u16(b, 48);
  if (hl !== FV_HEADER_LENGTH) throw new VarStoreError(`The firmware volume header is ${hl} bytes, not ${FV_HEADER_LENGTH}.`);
  let sum = 0;
  for (let i = 0; i < hl; i += 2) sum = (sum + u16(b, i)) & 0xffff;
  if (sum !== 0) throw new VarStoreError('The firmware volume header checksum is wrong.');
  return hl;
}

function checkFtw(b: Uint8Array): FtwState {
  const want = ftwWorkingHeader();
  for (let i = 0; i < want.length; i++) {
    if (b[FTW_WORKING_AT + i] !== want[i]) {
      throw new VarStoreError('The FTW working block header is not valid (signature, CRC or state), so the firmware would take the spare block on the next start. Nothing is written over it.');
    }
  }
  // FtwGetLastWriteHeader: skip complete write headers; the first one that is not complete must be unused (erased).
  let at = FTW_WORKING_HEADER;
  let completed = 0;
  for (;;) {
    const p = FTW_WORKING_AT + at;
    if (at + FTW_WRITE_HEADER > FTW_WORKING_BYTES) throw new VarStoreError('The FTW working block is full of write records.');
    const flags = b[p];
    if (flags === 0xff) break;
    const headerAllocated = (flags & 1) === 0;
    const complete = (flags & 4) === 0;
    if (!complete) {
      if (headerAllocated) {
        throw new VarStoreError('The FTW working block records a write that did not finish; the firmware finishes it on the next start by copying the spare block over the store. Start the board once, then read the settings again.');
      }
      break;
    }
    const writes = u64(b, p + 24);
    const priv = u64(b, p + 32);
    const total = BigInt(FTW_WRITE_HEADER) + writes * (BigInt(FTW_WRITE_RECORD) + priv);
    if (writes === 0n || total > BigInt(FTW_WORKING_BYTES)) throw new VarStoreError('The FTW working block holds a write record of an impossible size.');
    at += Number(total);
    completed++;
  }
  return { completed };
}

/** Parse and check a 192 KiB settings area; throws VarStoreError when anything does not match what EDK2 writes. */
export function parseVarStore(b: Uint8Array): VarStore {
  const storeAt = checkFvHeader(b);
  const sig = guidAt(b, storeAt);
  const auth = sig === GUID.authenticatedVariable;
  if (!auth && sig !== GUID.variable) throw new VarStoreError('The variable store has neither the authenticated nor the plain variable store signature.');
  const storeSize = u32(b, storeAt + 16);
  if (storeSize !== VARIABLE_BYTES - storeAt) throw new VarStoreError(`The variable store is ${storeSize} bytes, not ${VARIABLE_BYTES - storeAt}.`);
  if (b[storeAt + 20] !== STORE_FORMATTED || b[storeAt + 21] !== STORE_HEALTHY) {
    throw new VarStoreError(`The variable store is not formatted and healthy (format 0x${b[storeAt + 20].toString(16)}, state 0x${b[storeAt + 21].toString(16)}).`);
  }
  const end = storeAt + storeSize;
  const hdr = auth ? AUTH_HEADER : PLAIN_HEADER;
  const firstAt = align4(storeAt + STORE_HEADER);
  const records: VarRecord[] = [];
  let p = firstAt;
  while (p + 2 <= end && u16(b, p) === VARIABLE_DATA) {
    if (p + hdr > end) throw new VarStoreError(`The variable at 0x${p.toString(16)} runs past the end of the store.`);
    const nameSize = u32(b, p + (auth ? 36 : 8));
    const dataSize = u32(b, p + (auth ? 40 : 12));
    const guidOff = p + (auth ? 44 : 16);
    if (nameSize === 0 || nameSize % 2 || nameSize > storeSize || dataSize > storeSize || p + hdr + nameSize + dataSize > end) {
      throw new VarStoreError(`The variable at 0x${p.toString(16)} has impossible sizes (name ${nameSize}, data ${dataSize}).`);
    }
    const stateByte = b[p + 2];
    const state = stateOf(stateByte);
    const name = utf16z(b, p + hdr, nameSize);
    if (name === null && (state === 'added' || state === 'in-deleted-transition')) {
      throw new VarStoreError(`The variable at 0x${p.toString(16)} has a name that is not a NUL-terminated UCS-2 string.`);
    }
    const size = hdr + nameSize + dataSize;
    let timestampSet = false;
    if (auth) for (let i = 16; i < 32; i++) if (b[p + i]) timestampSet = true;
    records.push({
      offset: p, size, next: align4(p + size), stateByte, state, attributes: u32(b, p + 4), name: name ?? '', guid: guidAt(b, guidOff),
      data: b.slice(p + hdr + nameSize, p + size),
      monotonicCount: auth ? u64(b, p + 8) : 0n, pubKeyIndex: auth ? u32(b, p + 32) : 0, timestampSet,
    });
    p = align4(p + size);
  }
  if (p < end && !allFf(b, p, end)) {
    throw new VarStoreError(`There is data after the last variable (from 0x${p.toString(16)}) that is not a variable.`);
  }
  const endAt = Math.min(p, end);
  const ftw = checkFtw(b);
  // FindVariableEx: the first VAR_ADDED copy wins; without one, the last in-deleted-transition copy.
  const byKey = new Map<string, VarRecord>();
  for (const r of records) {
    if (r.state !== 'added' && r.state !== 'in-deleted-transition') continue;
    const k = `${r.guid}\0${r.name}`;
    const had = byKey.get(k);
    if (!had || had.state !== 'added') byKey.set(k, r);
  }
  const live = [...byKey.values()].sort((a, x) => a.offset - x.offset);
  return { auth, storeAt, storeSize, firstAt, endAt, records, live, ftw };
}

/** FindVariableEx: the record GetVariable returns, and the in-deleted-transition copy seen before it. */
export function findVariable(s: VarStore, name: string, guid: string): { cur: VarRecord | null; inDeleted: VarRecord | null } {
  let inDeleted: VarRecord | null = null;
  for (const r of s.records) {
    if (r.name !== name || r.guid !== guid.toLowerCase()) continue;
    if (r.state === 'in-deleted-transition') inDeleted = r;
    else if (r.state === 'added') return { cur: r, inDeleted };
  }
  return { cur: inDeleted, inDeleted: null };
}

// --- writing -----------------------------------------------------------------

/** Names the app never writes, whatever their attributes: Secure Boot keys, modes and the authenticated-variable database. */
export const PROTECTED_NAMES = new Set([
  'PK', 'KEK', 'db', 'dbx', 'dbt', 'dbr', 'PKDefault', 'KEKDefault', 'dbDefault', 'dbxDefault', 'dbtDefault', 'dbrDefault',
  'SecureBoot', 'SetupMode', 'AuditMode', 'DeployedMode', 'VendorKeys', 'VendorKeysNv', 'CustomMode', 'SecureBootEnable',
  'SignatureSupport', 'certdb', 'certdbv', 'MokList', 'MokListX', 'MokSBState',
]);

/** Why a variable must not be written offline, or null. */
export function protectedReason(name: string, guid: string, attributes: number): string | null {
  if (PROTECTED_NAMES.has(name) || guid.toLowerCase() === GUID.imageSecurityDatabase) return `${name} is a Secure Boot variable; it is never changed here.`;
  if (attributes & (ATTR.AUTHENTICATED_WRITE_ACCESS | ATTR.TIME_BASED_AUTHENTICATED_WRITE_ACCESS)) return `${name} is an authenticated variable; it is never changed here.`;
  if (attributes & ATTR.HARDWARE_ERROR_RECORD) return `${name} is a hardware error record; it is never changed here.`;
  if (attributes & ATTR.APPEND_WRITE) return `${name}: append writes are not made here.`;
  return null;
}

export interface VarChange {
  name: string;
  guid: string;
  /** The new data, or null to delete the variable. */
  data: Uint8Array | null;
  /** The attributes the variable is written with (it must already have these if it exists). */
  attributes: number;
}

export interface WriteResult {
  bytes: Uint8Array;
  /** The store was compacted (EDK2 Reclaim) to make room. */
  reclaimed: boolean;
  /** Variables whose live value changed. */
  changed: string[];
}

function recordBytes(auth: boolean, c: VarChange): Uint8Array {
  const hdr = auth ? AUTH_HEADER : PLAIN_HEADER;
  const nameSize = (c.name.length + 1) * 2;
  const data = c.data!;
  const r = new Uint8Array(hdr + nameSize + data.length);
  const dv = new DataView(r.buffer);
  dv.setUint16(0, VARIABLE_DATA, true);
  r[2] = VAR_ADDED;
  r[3] = 0;
  dv.setUint32(4, c.attributes, true);
  // Authenticated header: MonotonicCount, TimeStamp and PubKeyIndex stay zero for a variable without authentication.
  dv.setUint32(auth ? 36 : 8, nameSize, true);
  dv.setUint32(auth ? 40 : 12, data.length, true);
  r.set(guidBytes(c.guid), auth ? 44 : 16);
  for (let i = 0; i < c.name.length; i++) dv.setUint16(hdr + i * 2, c.name.charCodeAt(i), true);
  r.set(data, hdr + nameSize);
  return r;
}

/** Reclaim(): a compacted copy of the store with `fresh` (if any) last; null when even that does not fit. */
function reclaim(b: Uint8Array, s: VarStore, skip: Set<number>, fresh: Uint8Array | null): Uint8Array | null {
  const out = b.slice();
  const end = s.storeAt + s.storeSize;
  out.fill(0xff, s.firstAt, end);
  let p = s.firstAt;
  const put = (bytes: Uint8Array, promote: boolean) => {
    if (p + bytes.length > end) return false;
    out.set(bytes, p);
    if (promote) out[p + 2] = VAR_ADDED;
    p += align4(bytes.length);
    return true;
  };
  const key = (r: VarRecord) => `${r.guid}\0${r.name}`;
  const kept = new Set<string>();
  for (const r of s.records) {
    if (skip.has(r.offset) || r.state !== 'added') continue;
    if (!put(b.subarray(r.offset, r.offset + r.size), false)) return null;
    kept.add(key(r));
  }
  for (const r of s.records) {
    if (skip.has(r.offset) || r.state !== 'in-deleted-transition' || kept.has(key(r))) continue;
    if (!put(b.subarray(r.offset, r.offset + r.size), true)) return null;
    kept.add(key(r));
  }
  if (fresh && !put(fresh, false)) return null;
  return out;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Apply `changes` in order, as successive SetVariable() calls would, to a
 * copy of the area. `allowed` says which variables may be written at all
 * (the settings FEATURES.json lists). Throws VarStoreError on any refusal or
 * when the result does not read back as intended.
 */
export function setVariables(area: Uint8Array, changes: VarChange[], allowed: (name: string, guid: string) => boolean): WriteResult {
  const before = parseVarStore(area);
  let b: Uint8Array = area.slice();
  let reclaimed = false;
  const changed = new Set<string>();
  const want = new Map<string, VarChange>();
  for (const c of changes) {
    const guid = c.guid.toLowerCase();
    if (!allowed(c.name, guid)) throw new VarStoreError(`${c.name} is not one of the firmware's settings listed for this release; it is not written.`);
    const why = protectedReason(c.name, guid, c.attributes);
    if (why) throw new VarStoreError(why);
    const s = parseVarStore(b);
    const { cur, inDeleted } = findVariable(s, c.name, guid);
    if (cur) {
      const whyCur = protectedReason(cur.name, cur.guid, cur.attributes) ?? (cur.monotonicCount || cur.pubKeyIndex || cur.timestampSet ? `${cur.name} carries authentication data; it is never changed here.` : null);
      if (whyCur) throw new VarStoreError(whyCur);
    }
    want.set(`${guid}\0${c.name}`, { ...c, guid });
    if (c.data === null) {
      if (!cur) continue;
      if (inDeleted) b[inDeleted.offset + 2] &= VAR_DELETED;
      b[cur.offset + 2] &= VAR_DELETED;
      changed.add(c.name);
      continue;
    }
    if (c.data.length === 0) throw new VarStoreError(`${c.name}: empty data would delete the variable; that is not what was asked.`);
    if ((c.attributes & (ATTR.NON_VOLATILE | ATTR.BOOTSERVICE_ACCESS)) !== (ATTR.NON_VOLATILE | ATTR.BOOTSERVICE_ACCESS)) {
      throw new VarStoreError(`${c.name}: only non-volatile variables with boot service access are written here (attributes 0x${c.attributes.toString(16)}).`);
    }
    if (cur && cur.attributes !== c.attributes) {
      throw new VarStoreError(`${c.name} has attributes 0x${cur.attributes.toString(16)} on the board, not 0x${c.attributes.toString(16)}; the firmware would refuse the same change.`);
    }
    if (cur && same(cur.data, c.data)) continue;
    const rec = recordBytes(s.auth, c);
    if (rec.length > MAX_VARIABLE_SIZE) throw new VarStoreError(`${c.name} would be ${rec.length} bytes, more than the firmware's limit of ${MAX_VARIABLE_SIZE}.`);
    if (cur) b[cur.offset + 2] &= VAR_IN_DELETED_TRANSITION;
    const storeEnd = s.storeAt + s.storeSize;
    if (s.endAt + rec.length > storeEnd) {
      // The record being replaced and its in-deleted-transition copy are left out, as Reclaim(UpdatingPtrTrack) does.
      const skip = new Set<number>([...(cur ? [cur.offset] : []), ...(inDeleted ? [inDeleted.offset] : [])]);
      const r = reclaim(b, parseVarStore(b), skip, rec);
      if (!r) throw new VarStoreError(`The variable store is full even after compacting it; ${c.name} does not fit.`);
      b = r;
      reclaimed = true;
    } else {
      b.set(rec, s.endAt);
      if (inDeleted) b[inDeleted.offset + 2] &= VAR_DELETED;
      if (cur) b[cur.offset + 2] &= VAR_DELETED;
    }
    changed.add(c.name);
  }
  // Read it back as the firmware will, and compare with what was meant.
  const after = parseVarStore(b);
  const key = (r: { guid: string; name: string }) => `${r.guid}\0${r.name}`;
  const expect = new Map(before.live.map((r) => [key(r), { attributes: r.attributes, data: r.data }]));
  for (const [k, c] of want) {
    if (c.data === null) expect.delete(k);
    else expect.set(k, { attributes: c.attributes, data: c.data });
  }
  const got = new Map(after.live.map((r) => [key(r), r]));
  const problems: string[] = [];
  for (const [k, e] of expect) {
    const g = got.get(k);
    if (!g || g.attributes !== e.attributes || !same(g.data, e.data)) problems.push(k.split('\0')[1]);
  }
  for (const k of got.keys()) if (!expect.has(k)) problems.push(k.split('\0')[1]);
  if (problems.length) throw new VarStoreError(`The changed store does not read back as intended (${problems.join(', ')}). Nothing is written.`);
  for (let i = FTW_WORKING_AT; i < NV_REGION_BYTES; i++) {
    if (b[i] !== area[i]) throw new VarStoreError('The FTW blocks changed while the store was written. Nothing is written.');
  }
  return { bytes: b, reclaimed, changed: [...changed] };
}

/**
 * A new, empty settings area, byte for byte what RkFvbDxe formats and
 * FaultTolerantWriteDxe initialises on a first start: the FV header (block
 * map 64 x 4 KiB, as every board's copy has it), an authenticated store
 * header, no variables, a valid FTW working block with no writes, an erased
 * spare block.
 */
export function freshVarStore(): Uint8Array {
  const b = new Uint8Array(NV_REGION_BYTES).fill(0xff);
  b.fill(0, 0, FV_HEADER_LENGTH);
  const dv = new DataView(b.buffer);
  b.set(guidBytes(GUID.systemNvDataFv), 16);
  dv.setBigUint64(32, BigInt(NV_REGION_BYTES), true);
  dv.setUint32(40, FVH_SIGNATURE, true);
  dv.setUint32(44, FV_ATTRIBUTES, true);
  dv.setUint16(48, FV_HEADER_LENGTH, true);
  b[55] = FVH_REVISION;
  dv.setUint32(56, 64, true);
  dv.setUint32(60, 0x1000, true);
  let sum = 0;
  for (let i = 0; i < FV_HEADER_LENGTH; i += 2) sum = (sum + dv.getUint16(i, true)) & 0xffff;
  dv.setUint16(50, (0x10000 - sum) & 0xffff, true);
  const s = FV_HEADER_LENGTH;
  b.set(guidBytes(GUID.authenticatedVariable), s);
  dv.setUint32(s + 16, VARIABLE_BYTES - FV_HEADER_LENGTH, true);
  b[s + 20] = STORE_FORMATTED;
  b[s + 21] = STORE_HEALTHY;
  b.fill(0, s + 22, s + STORE_HEADER);
  b.set(ftwWorkingHeader(), FTW_WORKING_AT);
  return b;
}

/** An erased area as the release ships it (the firmware formats it on its first start). */
export function isErasedArea(b: Uint8Array): boolean {
  return b.length === NV_REGION_BYTES && allFf(b, 0, b.length);
}
