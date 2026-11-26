// The UEFI variable store reader and writer (uefi-vars.ts), on two real
// stores read from boards (a TaishanPi 3M after many weeks of use, 389
// records of which 78 live, and a ROCK 4D's SPI NOR), sanitised for
// publishing by scripts/varstore/sanitize.py: every record keeps its header,
// place and size; MAC-named variables and the data of boot entries, the
// clock and the network configuration are zeroed. The .live.txt next to each
// is what scripts/varstore/check.py and the EDK2-header build of
// scripts/varstore/edk2-check.c list for it.
//
// With VARSTORE_OUT set, every store written here is saved there with the
// listing it must give, and CI runs both checkers over them (ci.yml).
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  ATTR, crc32, findVariable, freshVarStore, ftwWorkingHeader, FTW_WORKING_AT, GUID, guidBytes, NV_REGION_BYTES, parseVarStore,
  setVariables, VarStoreError, VAR_ADDED, type VarChange, type VarStore,
} from '../src/woa/uefi-vars';

const fixture = (name: string): Uint8Array => new Uint8Array(gunzipSync(readFileSync(join(__dirname, 'fixtures', `nvdata-${name}.bin.gz`))));
const listingFile = (name: string) => readFileSync(join(__dirname, 'fixtures', `nvdata-${name}.live.txt`), 'utf8').split('\n').filter(Boolean);
/** Byte equality without vitest's element-by-element diff (these are up to 16 MiB). */
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/** One line per live variable, as the checkers print them. */
const listing = (s: VarStore) => s.live.map((r) => `${r.name} ${r.guid} 0x${r.attributes.toString(16)} ${hex(r.data)}`);

const RK = '8b4f2e3d-ac5e-4f9b-c2d6-3e7e9f1b4d8c';
const anyAllowed = () => true;
const set = (name: string, data: number[] | Uint8Array | null, attributes = 7, guid = RK): VarChange => ({ name, guid, attributes, data: data === null ? null : Uint8Array.from(data) });

/** Save a written store and the listing it must give, for the checkers CI runs (scripts/varstore). */
function keep(name: string, bytes: Uint8Array) {
  const dir = process.env.VARSTORE_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.bin`), bytes);
  writeFileSync(join(dir, `${name}.txt`), `${listing(parseVarStore(bytes)).join('\n')}\n`);
}

describe('reading a store', () => {
  it('lists what the EDK2 checkers list for the two real stores', () => {
    for (const name of ['tspi3m', 'rock4d']) {
      const s = parseVarStore(fixture(name));
      expect(s.auth).toBe(true);
      expect(listing(s)).toEqual(listingFile(name));
      keep(`fixture-${name}`, fixture(name));
    }
    const t = parseVarStore(fixture('tspi3m'));
    expect(t.records.length).toBe(389);
    expect(t.live.length).toBe(78);
    expect(t.storeAt).toBe(0x48);
    expect(t.storeSize).toBe(0xffb8);
    expect(t.firstAt).toBe(0x64);
    expect(t.endAt).toBe(0xc270);
    expect(t.ftw.completed).toBe(0);
    // Every dead record is one EDK2 marked: 0x3c (replaced: in-deleted-transition, then deleted) or 0x3d (deleted).
    expect(new Set(t.records.filter((r) => r.state === 'deleted').map((r) => r.stateByte))).toEqual(new Set([0x3c, 0x3d]));
  });

  it('writes a new store byte for byte as RkFvbDxe and FaultTolerantWriteDxe do on a first start', () => {
    const real = fixture('rock4d');
    const fresh = freshVarStore();
    expect(fresh.subarray(0, 0x64)).toEqual(real.subarray(0, 0x64));
    expect(fresh.subarray(FTW_WORKING_AT, FTW_WORKING_AT + 32)).toEqual(real.subarray(FTW_WORKING_AT, FTW_WORKING_AT + 32));
    expect(fresh.subarray(0x64).every((b, i) => i + 0x64 >= FTW_WORKING_AT && i + 0x64 < FTW_WORKING_AT + 32 ? true : b === 0xff)).toBe(true);
    expect(parseVarStore(fresh).live).toEqual([]);
    // The working block header's CRC as UpdateWorkingBlock.c computes it (state byte and Crc erased).
    expect(crc32(new Uint8Array([...guidBytes(GUID.ftwWorkingBlock), ...new Uint8Array(8).fill(0xff), 0xe0, 0xff, 0, 0, 0, 0, 0, 0]))).toBe(0x005295f5);
    expect(new DataView(ftwWorkingHeader().buffer).getUint32(16, true)).toBe(0x005295f5);
  });

  it('follows FindVariableEx: a VAR_ADDED copy wins, else the last in-deleted-transition one', () => {
    const b = fixture('rock4d');
    const s = parseVarStore(b);
    const fan = findVariable(s, 'AcpiFanControl', RK).cur!;
    // A crash between the two steps of an update: the old copy in transition, no new one. It is still the variable.
    b[fan.offset + 2] = 0x3e;
    const t = parseVarStore(b);
    expect(findVariable(t, 'AcpiFanControl', RK).cur!.offset).toBe(fan.offset);
    expect(listing(t)).toEqual(listing(s));
    // With a VAR_ADDED copy after it, that one is the variable and the old one is not listed.
    const w = setVariables(b, [set('AcpiFanControl', [3])], anyAllowed);
    const u = parseVarStore(w.bytes);
    expect(findVariable(u, 'AcpiFanControl', RK).cur!.data).toEqual(Uint8Array.of(3));
    expect(u.records.find((r) => r.offset === fan.offset)!.stateByte).toBe(0x3c);
    keep('in-deleted-transition-updated', w.bytes);
  });
});

describe('writing as EDK2 does', () => {
  it('appends the new value, marks the old one deleted and leaves everything else as it was', () => {
    const before = fixture('tspi3m');
    const s = parseVarStore(before);
    const old = findVariable(s, 'AcpiFanControl', RK).cur!;
    const r = setVariables(before, [set('AcpiFanControl', [2])], anyAllowed);
    expect(r.reclaimed).toBe(false);
    expect(r.changed).toEqual(['AcpiFanControl']);
    const after = parseVarStore(r.bytes);
    const now = findVariable(after, 'AcpiFanControl', RK).cur!;
    expect(now.offset).toBe(s.endAt);
    expect(now.stateByte).toBe(VAR_ADDED);
    expect(now.attributes).toBe(7);
    expect(now.monotonicCount).toBe(0n);
    expect(now.timestampSet).toBe(false);
    expect(after.records.find((x) => x.offset === old.offset)!.stateByte).toBe(0x3c);
    // The only bytes that changed: the old record's State and the new record.
    const diff = [...r.bytes.keys()].filter((i) => r.bytes[i] !== before[i]);
    expect(diff[0]).toBe(old.offset + 2);
    expect(diff.slice(1).every((i) => i >= s.endAt && i < now.next)).toBe(true);
    // The listing: the same, with the variable moved to the end with its new value.
    const want = listingFile('tspi3m').filter((l) => !l.startsWith('AcpiFanControl ')).concat([`AcpiFanControl ${RK} 0x7 02`]);
    expect(listing(after)).toEqual(want);
    keep('update-tspi3m', r.bytes);
  });

  it('deletes by clearing the VAR_DELETED bits, and creates a variable that is not there', () => {
    const r = setVariables(fixture('rock4d'), [set('AcpiFanControl', null), set('UsbcDp', [1])], anyAllowed);
    const after = parseVarStore(r.bytes);
    expect(findVariable(after, 'AcpiFanControl', RK).cur).toBeNull();
    expect(after.records.filter((x) => x.name === 'AcpiFanControl').map((x) => x.stateByte)).toEqual([0x3d]);
    expect(listing(after)).toEqual(listingFile('rock4d').filter((l) => !l.startsWith('AcpiFanControl ')).concat([`UsbcDp ${RK} 0x7 01`]));
    keep('delete-create-rock4d', r.bytes);
  });

  it('writes nothing for a value that is already there', () => {
    const b = fixture('tspi3m');
    const r = setVariables(b, [set('AcpiFanControl', [0])], anyAllowed);
    expect(r.changed).toEqual([]);
    expect(sameBytes(r.bytes, b)).toBe(true);
  });

  it('compacts the store when the new record does not fit, as Reclaim() does', () => {
    let b = fixture('tspi3m');
    // A crash left one variable in transition without its new copy: Reclaim promotes it to VAR_ADDED.
    const s0 = parseVarStore(b);
    const rot = findVariable(s0, 'DisplayRotation', RK).cur!;
    b[rot.offset + 2] = 0x3e;
    const want = listing(parseVarStore(b)).filter((l) => !l.startsWith('FdtOverrideBasePath '));
    // 510-byte updates of one variable until the store is full: 15.7 KiB were free.
    let reclaimed = 0;
    let last = new Uint8Array(510);
    for (let i = 1; i <= 40; i++) {
      last = new Uint8Array(510).fill(i);
      const r = setVariables(b, [set('FdtOverrideBasePath', last)], anyAllowed);
      b = r.bytes;
      if (r.reclaimed) { reclaimed++; break; }
    }
    expect(reclaimed).toBe(1);
    const s = parseVarStore(b);
    // Only live records are left, each VAR_ADDED, the replaced variable last.
    expect(s.records.length).toBe(s.live.length);
    expect(s.records.every((r) => r.stateByte === VAR_ADDED)).toBe(true);
    expect(s.records[s.records.length - 1].name).toBe('FdtOverrideBasePath');
    expect(listing(s)).toEqual([...want.filter((l) => !l.startsWith('DisplayRotation ')), ...want.filter((l) => l.startsWith('DisplayRotation ')), `FdtOverrideBasePath ${RK} 0x7 ${hex(last)}`]);
    expect(s.endAt).toBeLessThan(0x5000);
    // The FTW blocks are not touched and claim no write.
    expect(sameBytes(b.subarray(FTW_WORKING_AT), fixture('tspi3m').subarray(FTW_WORKING_AT))).toBe(true);
    keep('reclaim-tspi3m', b);
  });

  it('starts from a new store when the area was never formatted', () => {
    const r = setVariables(freshVarStore(), [set('AcpiFanControl', [4]), set('ConfigTableMode', [1, 0, 0, 0])], anyAllowed);
    expect(listing(parseVarStore(r.bytes))).toEqual([`AcpiFanControl ${RK} 0x7 04`, `ConfigTableMode ${RK} 0x7 01000000`]);
    keep('fresh-two', r.bytes);
  });
});

describe('refusals', () => {
  const refuse = (b: Uint8Array, c: VarChange[], re: RegExp, allowed: (n: string, g: string) => boolean = anyAllowed) => {
    expect(() => setVariables(b, c, allowed)).toThrow(VarStoreError);
    expect(() => setVariables(b, c, allowed)).toThrow(re);
  };

  it('never writes Secure Boot or authenticated variables, or one the settings list does not name', () => {
    const b = fixture('tspi3m');
    refuse(b, [set('PK', [1], 0x27, GUID.globalVariable)], /PK is a Secure Boot variable/);
    refuse(b, [set('db', [1], 7, GUID.imageSecurityDatabase)], /Secure Boot variable/);
    refuse(b, [set('dbx', null, 7, GUID.imageSecurityDatabase)], /Secure Boot variable/);
    refuse(b, [set('certdb', [0], 0x27, 'd9bee56e-75dc-49d9-b4d7-b534210f637a')], /Secure Boot variable/);
    refuse(b, [set('MyAuth', [1], ATTR.NON_VOLATILE | ATTR.BOOTSERVICE_ACCESS | ATTR.TIME_BASED_AUTHENTICATED_WRITE_ACCESS)], /authenticated variable/);
    refuse(b, [set('AcpiFanControl', [1])], /not one of the firmware's settings/, (n) => n !== 'AcpiFanControl');
    refuse(b, [set('BootOrder', [0, 0], 7, GUID.globalVariable)], /not one of the firmware's settings/, (n, g) => g === RK);
  });

  it('refuses what the firmware itself would refuse', () => {
    const b = fixture('tspi3m');
    refuse(b, [set('AcpiFanControl', [1], 3)], /attributes 0x7 on the board, not 0x3/);
    refuse(b, [set('AcpiFanControl', [])], /empty data/);
    refuse(b, [set('Volatile', [1], ATTR.BOOTSERVICE_ACCESS)], /only non-volatile/);
    refuse(b, [set('Huge', new Uint8Array(0x2000))], /firmware's limit/);
  });

  it('refuses a store that is full even after compacting it', () => {
    let b = freshVarStore();
    let i = 0;
    expect(() => { for (; i < 20; i++) b = setVariables(b, [set(`Big${i}`, new Uint8Array(0x1f00).fill(i))], anyAllowed).bytes; }).toThrow(/full even after compacting/);
    expect(i).toBeGreaterThan(5);
  });

  it('refuses a damaged store, a damaged FTW header and a write the FTW would still finish', () => {
    const ok = fixture('rock4d');
    const bad = (f: (b: Uint8Array) => void, re: RegExp) => { const b = ok.slice(); f(b); refuse(b, [set('AcpiFanControl', [1])], re); expect(() => parseVarStore(b)).toThrow(re); };
    bad((b) => { b[0x28] = 0; }, /no _FVH/);
    bad((b) => { b[0x30] ^= 1; }, /header is \d+ bytes|checksum/);
    bad((b) => { b[0x3a] ^= 1; }, /checksum/);
    bad((b) => { b.set(guidBytes(GUID.globalVariable), 0x48); }, /neither the authenticated nor the plain/);
    bad((b) => { b[0x48 + 21] = 0xff; }, /not formatted and healthy/);
    bad((b) => { b[0x48 + 16] = 0; }, /variable store is \d+ bytes/);
    bad((b) => { const s = parseVarStore(ok); b[s.endAt + 7] = 0; }, /data after the last variable/);
    bad((b) => { const v = findVariable(parseVarStore(ok), 'AcpiFanControl', RK).cur!; b[v.offset + 40] = 0xff; b[v.offset + 41] = 0xff; }, /impossible sizes/);
    bad((b) => { b[FTW_WORKING_AT + 16] ^= 1; }, /FTW working block header is not valid/);
    bad((b) => { b[FTW_WORKING_AT + 20] = 0xff; }, /FTW working block header is not valid/);
    // A write header that is allocated (bit 0 clear) and not complete (bit 2 set), with one record whose spare copy is complete.
    bad((b) => { const h = FTW_WORKING_AT + 32; b[h] = 0xfe & 0xfd; new DataView(b.buffer).setBigUint64(h + 24, 1n, true); new DataView(b.buffer).setBigUint64(h + 32, 0n, true); b[h + 40] = 0xfc; }, /did not finish/);
    expect(() => parseVarStore(ok.subarray(0, NV_REGION_BYTES - 512))).toThrow(/not 196608/);
    expect(() => parseVarStore(new Uint8Array(NV_REGION_BYTES).fill(0xff))).toThrow(/empty \(erased\)/);
  });

  it('reads completed FTW writes as done, as FtwGetLastWriteHeader skips them', () => {
    const b = fixture('rock4d');
    const h = FTW_WORKING_AT + 32;
    const dv = new DataView(b.buffer);
    // HeaderAllocated, WritesAllocated and Complete all at FTW_VALID_STATE (0): 0xF8; one record, 16 bytes of private data.
    b[h] = 0xf8; dv.setBigUint64(h + 24, 1n, true); dv.setBigUint64(h + 32, 16n, true);
    b.fill(0, h + 40, h + 40 + 40 + 16); b[h + 40] = 0xf8;
    expect(parseVarStore(b).ftw.completed).toBe(1);
    const r = setVariables(b, [set('AcpiFanControl', [1])], anyAllowed);
    expect(sameBytes(r.bytes.subarray(FTW_WORKING_AT), b.subarray(FTW_WORKING_AT))).toBe(true);
    keep('ftw-completed-rock4d', r.bytes);
  });
});
