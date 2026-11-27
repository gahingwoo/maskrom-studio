// Boot entries (EFI_LOAD_OPTION) for the tests and the screenshots, laid out
// the way edk2-rk3576 makes them (UEFI 2.10 sections 3.1.3 and 10.3): the
// sanitised stores in test/fixtures have their Boot#### data zeroed, so these
// put believable ones back, one per entry BootOrder lists.
import { GUID, guidBytes, setVariables } from '../src/woa/uefi-vars';
import { bootName } from '../src/woa/boot-options';

const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_v, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const ucs2 = (s: string) => [...s].flatMap((c) => le(c.charCodeAt(0), 2)).concat([0, 0]);

export const dp = {
  node: (type: number, subType: number, data: number[] = []) => [type, subType, ...le(data.length + 4, 2), ...data],
  /** A non-discoverable controller (SDHCI, DW MMC, xHCI) as RK3576's NonDiscoverableDeviceDxe names it. */
  venHw: (guid: string) => dp.node(0x01, 0x04, [...guidBytes(guid)]),
  ctrl: (n: number) => dp.node(0x01, 0x05, le(n, 4)),
  emmc: (slot = 0) => dp.node(0x03, 0x1d, [slot]),
  sd: (slot = 0) => dp.node(0x03, 0x1a, [slot]),
  nvme: (ns = 1) => dp.node(0x03, 0x17, [...le(ns, 4), ...le(0, 8)]),
  pci: (dev: number, fn = 0) => dp.node(0x01, 0x01, [fn, dev]),
  usb: (port: number, iface = 0) => dp.node(0x03, 0x05, [port, iface]),
  mac: () => dp.node(0x03, 0x0b, [0x02, 0, 0, 0, 0, 0x01, ...new Array(26).fill(0), 0x01]),
  ipv4: () => dp.node(0x03, 0x0c, new Array(23).fill(0)),
  uri: () => dp.node(0x03, 0x18, []),
  hd: (part: number, start: number, size: number) => dp.node(0x04, 0x01, [...le(part, 4), ...le(start, 8), ...le(size, 8), ...guidBytes('2c8d8e8a-4b7e-4a2e-9d1c-5a6b7c8d9e0f'), 0x02, 0x02]),
  file: (path: string) => dp.node(0x04, 0x04, ucs2(path)),
  fv: (guid: string) => dp.node(0x04, 0x07, [...guidBytes(guid)]),
  fvFile: (guid: string) => dp.node(0x04, 0x06, [...guidBytes(guid)]),
  end: () => [0x7f, 0xff, 0x04, 0x00],
};

/** An EFI_LOAD_OPTION: attributes, the path list's length, the description, the path, optional data. */
export function loadOption(attributes: number, description: string, path: number[][], optional: number[] = []): Uint8Array {
  const list = [...path.flat(), ...dp.end()];
  return Uint8Array.from([...le(attributes, 4), ...le(list.length, 2), ...ucs2(description), ...list, ...optional]);
}

const SDHCI = '1b5a6f2e-0d8b-4d4c-9b6a-6e3a2e5f0a01';
const DWMMC = '1b5a6f2e-0d8b-4d4c-9b6a-6e3a2e5f0a02';
const XHCI = '1b5a6f2e-0d8b-4d4c-9b6a-6e3a2e5f0a03';
const FV = '64074afe-340a-4be6-94ba-91b5b4d0f71e';
const ACTIVE = 0x1, HIDDEN = 0x8, APP = 0x100;
const BMM = [0x4e, 0x42]; // "NB": the optional data EDK2 BDS puts after the entries it made itself

/** What a TaishanPi 3M with Windows on the eMMC and Armbian on an SD card lists. */
export const TSPI_ENTRIES: Record<number, Uint8Array> = {
  0x0000: loadOption(ACTIVE | HIDDEN | APP, 'UiApp', [dp.fv(FV), dp.fvFile('462caa21-7614-4503-836e-8ab6f4662331')]),
  0x0001: loadOption(ACTIVE | APP, 'UEFI Shell', [dp.fv(FV), dp.fvFile('7c04a583-9e3e-4f1c-ad65-e05268d0b4d1')]),
  0x0002: loadOption(ACTIVE, 'UEFI eMMC Device', [dp.venHw(SDHCI), dp.emmc(0), dp.ctrl(0)], BMM),
  0x0003: loadOption(ACTIVE, 'UEFI SD Device', [dp.venHw(DWMMC), dp.sd(0)], BMM),
  0x0004: loadOption(ACTIVE, 'UEFI SanDisk Ultra 4C530001', [dp.venHw(XHCI), dp.usb(1), dp.usb(2)], BMM),
  0x0005: loadOption(ACTIVE, 'UEFI PXEv4 (MAC:020000000001)', [dp.venHw('2a8c9f1e-0c2c-4f0a-9d3b-111111111111'), dp.mac(), dp.ipv4()], BMM),
  0x0006: loadOption(0, 'UEFI HTTPv4 (MAC:020000000001)', [dp.venHw('2a8c9f1e-0c2c-4f0a-9d3b-111111111111'), dp.mac(), dp.ipv4(), dp.uri()], BMM),
  0x0007: loadOption(ACTIVE, 'UEFI Samsung SSD 980 1TB', [dp.pci(0), dp.pci(0), dp.nvme(1)], BMM),
  0x0008: loadOption(ACTIVE | HIDDEN | APP, 'Boot Manager Menu', [dp.fv(FV), dp.fvFile('eec25bdc-67f2-4d95-b1d5-f81b2039d11d')]),
  0x0009: loadOption(ACTIVE, 'Armbian', [dp.venHw(DWMMC), dp.sd(0), dp.hd(1, 32768, 1048576), dp.file('\\EFI\\BOOT\\BOOTAA64.EFI')]),
  0x000a: loadOption(ACTIVE, 'Windows Boot Manager', [dp.hd(1, 34816, 524288), dp.file('\\EFI\\Microsoft\\Boot\\bootmgfw.efi')],
    [0x57, 0x49, 0x4e, 0x44, 0x4f, 0x57, 0x53, 0x00, 0x01, 0x00, 0x00, 0x00]),
  0x000b: loadOption(ACTIVE, 'Windows Boot Manager', [dp.venHw(SDHCI), dp.emmc(0), dp.ctrl(0), dp.hd(3, 2148352, 204800), dp.file('\\EFI\\Microsoft\\Boot\\bootmgfw.efi')]),
  0x000c: loadOption(ACTIVE, 'Fedora', [dp.hd(1, 2048, 1228800), dp.file('\\EFI\\fedora\\shimaa64.efi')]),
};

/** The ROCK 4D's four: the setup menu, the shell, the SD card, USB. */
export const ROCK4D_ENTRIES: Record<number, Uint8Array> = {
  0x0000: TSPI_ENTRIES[0], 0x0001: TSPI_ENTRIES[1], 0x0002: TSPI_ENTRIES[3], 0x0003: TSPI_ENTRIES[4],
};

/** The store with each Boot#### of `entries` set to its load option (written as EDK2 would, through setVariables). */
export function withBootEntries(area: Uint8Array, entries: Record<number, Uint8Array>): Uint8Array {
  const changes = Object.entries(entries).map(([n, data]) => ({ name: bootName(Number(n)), guid: GUID.globalVariable, attributes: 7, data }));
  return setVariables(area, changes, () => true).bytes;
}
