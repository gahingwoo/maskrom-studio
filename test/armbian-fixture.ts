// An Armbian-like disk image for the tests: one ext4 root partition and a U-Boot FIT.
import { buildGpt, SECTOR } from '../src/woa/gpt';
import { TYPE_LINUX_ROOT_ARM64 } from '../src/woa/armbian-hybrid';

/** A FIT header (FDT) with images and their data-offset / data-size, as mkimage -E writes them. */
export function fitHeader(images: Record<string, { offset: number; size: number }>): Uint8Array {
  const strings: string[] = [];
  const strOff = (n: string) => { let o = 0; for (const x of strings) { if (x === n) return o; o += x.length + 1; } strings.push(n); return o; };
  const words: number[] = [];
  const bytes = (b: Uint8Array) => { const pad = new Uint8Array(Math.ceil(b.length / 4) * 4); pad.set(b); for (let i = 0; i < pad.length; i += 4) words.push(((pad[i] << 24) | (pad[i + 1] << 16) | (pad[i + 2] << 8) | pad[i + 3]) >>> 0); };
  const begin = (n: string) => { words.push(1); bytes(new TextEncoder().encode(`${n}\0`)); };
  const u32 = (name: string, v: number) => { words.push(3, 4, strOff(name), v >>> 0); };
  begin('');
  begin('images');
  for (const [n, i] of Object.entries(images)) { begin(n); u32('data-size', i.size); u32('data-offset', i.offset); words.push(2); }
  words.push(2, 2, 9);
  const str = new TextEncoder().encode(strings.map((x) => `${x}\0`).join(''));
  const total = 0x38 + words.length * 4 + str.length;
  const fit = new Uint8Array(total);
  const dv = new DataView(fit.buffer);
  [0xd00dfeed, total, 0x38, 0x38 + words.length * 4, 0x28, 17, 16, 0, str.length, words.length * 4].forEach((v, i) => dv.setUint32(i * 4, v));
  words.forEach((w, i) => dv.setUint32(0x38 + i * 4, w));
  fit.set(str, 0x38 + words.length * 4);
  return fit;
}

/** A small Armbian-like disk image: U-Boot FIT at sector 16384, one ext4 root partition from sector 32768. */
export function fakeArmbian(o: { rootSectors?: number; parts?: number; magic?: boolean; clean?: boolean; fit?: boolean } = {}): Uint8Array {
  const rootSectors = o.rootSectors ?? 8192;
  const diskSectors = 32768 + rootSectors + 34;
  const img = new Uint8Array(diskSectors * SECTOR);
  const parts = [{ type: TYPE_LINUX_ROOT_ARM64, guid: '04fdd13a-19aa-4245-8b66-c02fafb5e121', firstLba: 32768, lastLba: 32768 + rootSectors - 1, name: 'rootfs' }];
  if ((o.parts ?? 1) > 1) {
    parts[0].firstLba = 32768 + 2048;
    parts.unshift({ type: TYPE_LINUX_ROOT_ARM64, guid: '04fdd13a-19aa-4245-8b66-c02fafb5e122', firstLba: 32768, lastLba: 32768 + 2047, name: 'boot' });
  }
  const gpt = buildGpt({ diskSectors, diskGuid: 'd8d5f487-1251-4ec2-a557-f7e7889ee81e', keep: null, parts });
  img.set(gpt.primary, 0);
  img.set(gpt.backup, gpt.backupStart * SECTOR);
  if (o.fit ?? true) {
    const fit = fitHeader({ uboot: { offset: 0, size: 900000 }, 'atf-1': { offset: 900000, size: 200000 }, 'fdt-1': { offset: 1100000, size: 40000 } });
    img.set(fit, 16384 * SECTOR);
  }
  const sb = parts[parts.length - 1].firstLba * SECTOR + 1024;
  if (o.magic ?? true) { img[sb + 0x38] = 0x53; img[sb + 0x39] = 0xef; }
  img[sb + 0x3a] = (o.clean ?? true) ? 1 : 0;
  img.set([0xbc, 0x10, 0x8f, 0x2a, 0x5a, 0x29, 0x46, 0xab, 0x93, 0xad, 0x30, 0x77, 0x80, 0xd7, 0xf4, 0xd9], sb + 0x68);
  img.set(new TextEncoder().encode('armbi_root'), sb + 0x78);
  return img;
}

