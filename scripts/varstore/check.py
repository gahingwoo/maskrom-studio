#!/usr/bin/env python3
# An independent reader of edk2-rk3576's UEFI settings area (192 KiB: the
# variable store, the FTW working block, the FTW spare block), written
# straight from EDK2's headers and parsing code (edk2-stable202602), not
# from the app's TypeScript:
#   MdePkg/Include/Pi/PiFirmwareVolume.h      EFI_FIRMWARE_VOLUME_HEADER
#   MdeModulePkg/Include/Guid/VariableFormat.h VARIABLE_STORE_HEADER,
#       AUTHENTICATED_VARIABLE_HEADER (#pragma pack(1)), VAR_* states,
#       HEADER_ALIGN (4), GET_PAD_SIZE (ALIGNMENT 1: no padding)
#   MdeModulePkg/Universal/Variable/RuntimeDxe/VariableParsing.c
#       IsValidVariableHeader, GetNextVariablePtr, FindVariableEx
#   MdeModulePkg/Include/Guid/SystemNvDataGuid.h and
#   FaultTolerantWriteDxe/UpdateWorkingBlock.c, FtwMisc.c
#       the working block header, FtwGetLastWriteHeader
#
# Prints the live variables, one per line ("name guid attributes data-hex",
# in store order), the way GetVariable() would find them. Exits 1 with a
# reason when the area is not one the firmware would accept as it is, or
# when the listing differs from the file given with --expect.
import struct
import sys
import uuid
import zlib

def guid(b, o):
    return str(uuid.UUID(bytes_le=bytes(b[o:o + 16])))

SYSTEM_NV_DATA_FV = 'fff12b8d-7696-4c8b-a985-2747075b4f50'
AUTH_VAR_STORE = 'aaf32c78-947b-439a-a180-2e144ec37792'
VAR_STORE = 'ddcf3616-3275-4164-98b6-fe85707ffe7d'
WORKING_BLOCK = '9e58292b-7c68-497d-a0ce-6500fd9f1b95'
VAR_ADDED, VAR_IN_DELETED_TRANSITION = 0x3F, 0xFE
VARIABLE_DATA = 0x55AA

def fail(msg):
    print(f'FAIL: {msg}')
    sys.exit(1)

def listing(d):
    if len(d) != 0x30000:
        fail(f'{len(d)} bytes, not 0x30000')
    # EFI_FIRMWARE_VOLUME_HEADER: ZeroVector[16], FileSystemGuid, FvLength, Signature, Attributes,
    # HeaderLength, Checksum, ExtHeaderOffset, Reserved, Revision, BlockMap[]
    fvlen, sig, attrs, hlen, _ck, _ext, _res, rev = struct.unpack_from('<QIIHHHBB', d, 32)
    if sig != 0x4856465F or rev != 2 or fvlen != 0x30000 or guid(d, 16) != SYSTEM_NV_DATA_FV:
        fail('not the NV data firmware volume RkFvbDxe writes')
    if sum(struct.unpack_from(f'<{hlen // 2}H', d, 0)) & 0xFFFF:
        fail('FV header checksum')
    # VARIABLE_STORE_HEADER: Signature, Size, Format, State, Reserved, Reserved1
    s = hlen
    ssig = guid(d, s)
    size, fmt, state = struct.unpack_from('<IBB', d, s + 16)
    if ssig not in (AUTH_VAR_STORE, VAR_STORE) or fmt != 0x5A or state != 0xFE or size != 0x10000 - hlen:
        fail('variable store header')
    auth = ssig == AUTH_VAR_STORE
    hdr = 60 if auth else 32
    end = (s + size + 3) & ~3                       # GetEndPointer
    v = (s + 28 + 3) & ~3                           # GetStartPointer: HEADER_ALIGN (VarStoreHeader + 1)
    recs = []
    while v < end and struct.unpack_from('<H', d, v)[0] == VARIABLE_DATA:   # IsValidVariableHeader
        st = d[v + 2]
        attr = struct.unpack_from('<I', d, v + 4)[0]
        if auth:
            ns, ds = struct.unpack_from('<II', d, v + 36)
            vg = guid(d, v + 44)
        else:
            ns, ds = struct.unpack_from('<II', d, v + 8)
            vg = guid(d, v + 16)
        if v + hdr + ns + ds > end:
            fail(f'variable at {v:#x} runs past the store')
        name = d[v + hdr:v + hdr + ns]
        data = d[v + hdr + ns:v + hdr + ns + ds]
        recs.append((st, attr, name, vg, data))
        v = (v + hdr + ns + ds + 3) & ~3          # GetNextVariablePtr
    if any(x != 0xFF for x in d[v:s + size]):
        fail(f'bytes after the last variable ({v:#x}) are not erased')
    # FindVariableEx, for every name: the first VAR_ADDED copy, else the last in-deleted-transition one.
    live = {}
    for i, (st, attr, name, vg, data) in enumerate(recs):
        k = (vg, bytes(name))
        if st == VAR_ADDED:
            if k not in live or recs[live[k]][0] != VAR_ADDED:
                live[k] = i
        elif st == (VAR_ADDED & VAR_IN_DELETED_TRANSITION):
            if k not in live or recs[live[k]][0] != VAR_ADDED:
                live[k] = i
    # The FTW working block: EFI_FAULT_TOLERANT_WORKING_BLOCK_HEADER as InitializeLocalWorkSpaceHeader makes it.
    w = 0x10000
    want = bytearray(uuid.UUID(WORKING_BLOCK).bytes_le + b'\xff' * 8 + struct.pack('<Q', 0x10000 - 32))
    struct.pack_into('<I', want, 16, zlib.crc32(bytes(want)))
    want[20] = 0xFE   # WorkingBlockValid = FTW_VALID_STATE (0), WorkingBlockInvalid = FTW_INVALID_STATE (1)
    if bytes(d[w:w + 32]) != bytes(want):
        fail('FTW working block header')
    # FtwGetLastWriteHeader: EFI_FAULT_TOLERANT_WRITE_HEADER is 40 bytes, Complete is bit 2, HeaderAllocated bit 0.
    o = 32
    while True:
        flags = d[w + o]
        if flags & 4:                              # Complete != FTW_VALID_STATE: the last write header
            if not flags & 1:
                fail('FTW working block records an unfinished write')
            break
        nw, priv = struct.unpack_from('<QQ', d, w + o + 24)
        o += 40 + nw * (40 + priv)
        if o + 40 >= 0x10000:
            fail('FTW work space full')
    out = []
    for i in sorted(live.values()):
        st, attr, name, vg, data = recs[i]
        out.append(f"{bytes(name).decode('utf-16le').rstrip(chr(0))} {vg} {attr:#x} {bytes(data).hex()}")
    return out, len(recs)

def main():
    args = sys.argv[1:]
    expect = None
    if len(args) == 3 and args[1] == '--expect':
        expect = args[2]
    elif len(args) != 1:
        print('usage: check.py AREA.bin [--expect LISTING.txt]')
        sys.exit(2)
    d = open(args[0], 'rb').read()
    if len(d) == 16 * 1024 * 1024:
        d = d[0xFC0000:0xFF0000]                   # a whole ROCK 4D SPI NOR dump
    out, n = listing(d)
    if expect is None:
        print('\n'.join(out))
        print(f'# {len(out)} live of {n} records', file=sys.stderr)
        return
    want = [l for l in open(expect).read().splitlines() if l]
    if want != out:
        print(f'FAIL: {args[0]} lists differently from {expect}')
        for l in sorted(set(want) ^ set(out)):
            print(('  expected ' if l in want else '  found    ') + l[:160])
        sys.exit(1)
    print(f'ok {args[0]}: {len(out)} live variables of {n} records, as expected')

main()
