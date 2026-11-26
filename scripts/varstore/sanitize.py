#!/usr/bin/env python3
# Turn a real UEFI settings area read from a board into a test fixture that
# can be published: every record, deleted ones too, keeps its header, its
# place and its size, so the store has the real layout; what could identify
# the board goes. Names made of 12 hex digits (the network stack names its
# variables after the MAC address) become zeros; data is kept only for the
# firmware's own settings (the RK3576 formset GUID) and a few global
# variables that say nothing about the board, and is zeroed otherwise
# (boot entries, device paths, the clock, the network configuration).
#   sanitize.py AREA.bin OUT.bin     (AREA may be a whole 16 MiB SPI NOR dump)
import re
import struct
import sys
import uuid

KEEP_GUIDS = {'8b4f2e3d-ac5e-4f9b-c2d6-3e7e9f1b4d8c'}
KEEP_NAMES = {'Timeout', 'Lang', 'PlatformLang', 'BootOrder', 'BootDiscoveryPolicy', 'BootDiscoveryPolicyOld',
              'CustomMode', 'VendorKeysNv', 'VarErrorFlag', 'MemoryAttributeManagerData', 'CurrentActivePolicy',
              'CurrentPolicy', 'BootDebugPolicyApplied', 'OnScreenKeyboardSize'}

d = bytearray(open(sys.argv[1], 'rb').read())
if len(d) == 16 * 1024 * 1024:
    d = d[0xFC0000:0xFF0000]
assert len(d) == 0x30000
hl = struct.unpack_from('<H', d, 48)[0]
size = struct.unpack_from('<I', d, hl + 16)[0]
v = (hl + 28 + 3) & ~3
n = 0
while struct.unpack_from('<H', d, v)[0] == 0x55AA:
    ns, ds = struct.unpack_from('<II', d, v + 36)
    g = str(uuid.UUID(bytes_le=bytes(d[v + 44:v + 60])))
    name = d[v + 60:v + 60 + ns].decode('utf-16le', 'replace').rstrip('\0')
    if re.fullmatch(r'[0-9A-Fa-f]{12}', name):
        d[v + 60:v + 60 + ns - 2] = '000000000000'.encode('utf-16le')
    if g not in KEEP_GUIDS and name not in KEEP_NAMES:
        d[v + 60 + ns:v + 60 + ns + ds] = bytes(ds)
    n += 1
    v = (v + 60 + ns + ds + 3) & ~3
# The last sector of the spare block may hold RkFvbRt's commit marker (diagnostics only): keep it erased.
d[0x2FE00:0x30000] = b'\xff' * 0x200
open(sys.argv[2], 'wb').write(d)
print(f'{n} records sanitised')
