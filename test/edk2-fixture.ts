// A made-up edk2-rk3576 eMMC image for tests and screenshots: 32 MiB, a FIT
// at sector 16384 (a flattened device tree written here) with edk2 and
// nvdata images, and a UTF-16 build stamp in edk2. No Node APIs: the
// pretend board's worker uses it too.
import { FIT_LBA, IMAGE_BYTES, SECTOR } from '../src/woa/edk2-image';

/** A flattened device tree with the nodes and properties a FIT has. */
function fdt(tree: Record<string, unknown>): Uint8Array {
  const strings: string[] = [];
  const strOff = (n: string) => { let o = 0; for (const s of strings) { if (s === n) return o; o += s.length + 1; } strings.push(n); return o; };
  const words: number[] = [];
  const bytes = (b: Uint8Array) => { const pad = new Uint8Array(Math.ceil(b.length / 4) * 4); pad.set(b); for (let i = 0; i < pad.length; i += 4) words.push(((pad[i] << 24) | (pad[i + 1] << 16) | (pad[i + 2] << 8) | pad[i + 3]) >>> 0); };
  const node = (name: string, n: Record<string, unknown>) => {
    words.push(1); bytes(new TextEncoder().encode(`${name}\0`));
    for (const [k, v] of Object.entries(n)) {
      if (typeof v === 'object' && v !== null) continue;
      const val = typeof v === 'number' ? Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff) : new TextEncoder().encode(`${v}\0`);
      words.push(3, val.length, strOff(k)); bytes(val);
    }
    for (const [k, v] of Object.entries(n)) if (typeof v === 'object' && v !== null) node(k, v as Record<string, unknown>);
    words.push(2);
  };
  node('', tree);
  words.push(9);
  const struct = new Uint8Array(words.length * 4);
  words.forEach((w, i) => { struct[i * 4] = w >>> 24; struct[i * 4 + 1] = (w >>> 16) & 0xff; struct[i * 4 + 2] = (w >>> 8) & 0xff; struct[i * 4 + 3] = w & 0xff; });
  const str = new TextEncoder().encode(strings.map((s) => `${s}\0`).join(''));
  const offStruct = 0x38;
  const offStrings = offStruct + struct.length;
  const total = 4096;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  [0xd00dfeed, total, offStruct, offStrings, 0x28, 17, 16, 0, str.length, struct.length].forEach((v, i) => dv.setUint32(i * 4, v));
  out.set(struct, offStruct); out.set(str, offStrings);
  return out;
}

export function edk2Image(opts: { dt?: string; stamp?: string; version?: string; nvOffset?: number; nvdata?: Uint8Array } = {}): Uint8Array {
  const nvOffset = opts.nvOffset ?? 0xd4f000;
  const img = new Uint8Array(IMAGE_BYTES).fill(0x11);
  img.set(fdt({
    description: 'FIT Image with ATF/OP-TEE/UEFI for RK3576',
    images: { edk2: { 'data-size': 0xd00000, 'data-offset': 0x4f000 }, nvdata: { 'data-size': 0x30000, 'data-offset': nvOffset } },
    configurations: { default: 'conf', conf: { description: opts.dt ?? 'rk3576-lckfb-tspi-3m' } },
  }), FIT_LBA * SECTOR);
  const stamp = `rk3576-${opts.stamp ?? (opts.dt === 'rk3576-armsom-cm5-io' ? 'CM5IO' : 'TaishanPi3M')}-${opts.version ?? '0.4.2'}`;
  const at = FIT_LBA * SECTOR + 4096 + 0x4f000 + 0x10000;
  for (let i = 0; i < stamp.length; i++) { img[at + i * 2] = stamp.charCodeAt(i); img[at + i * 2 + 1] = 0; }
  const nvAt = FIT_LBA * SECTOR + 4096 + nvOffset;
  img.set(opts.nvdata ?? new Uint8Array(0x30000).fill(0xff), nvAt);
  return img;
}


/** A UEFI variable store as the nvdata slot holds one ("_FVH" at 0x28). */
export const store = () => { const b = new Uint8Array(0x30000).fill(0x5a); b.set(new TextEncoder().encode('_FVH'), 0x28); return b; };

/**
 * A made-up edk2-rk3576 SPI NOR image for the ROCK 4D: 16 MiB, a FIT at
 * sector 768 with an edk2 image holding the build stamp, the UEFI settings
 * area from sector 32256 erased (0xFF), as ROCK4D-spi-edk2-<ver>.img.
 */
export function spiImage(opts: { dt?: string; stamp?: string; version?: string; settings?: Uint8Array; spl?: string } = {}): Uint8Array {
  const img = new Uint8Array(16 * 1024 * 1024).fill(0x11);
  // The SPL's strings, as U-Boot's SPL carries them (the tag ArmbianOnce/1 at 0x3807c in the rock4d-parity build).
  if (opts.spl) img.set(new TextEncoder().encode(opts.spl), 0x3807c);
  const fit = 768 * SECTOR;
  img.set(fdt({
    description: 'FIT Image with ATF/OP-TEE/UEFI for RK3576',
    images: { edk2: { 'data-size': 0x100000, 'data-offset': 0 } },
    configurations: { default: 'conf', conf: { description: opts.dt ?? 'rk3576-rock-4d' } },
  }), fit);
  const stamp = `rk3576-${opts.stamp ?? 'ROCK4D'}-${opts.version ?? '0.4.2'}`;
  const at = fit + 4096 + 0x8000;
  for (let i = 0; i < stamp.length; i++) { img[at + i * 2] = stamp.charCodeAt(i); img[at + i * 2 + 1] = 0; }
  img.fill(0xff, 32256 * SECTOR, 32256 * SECTOR + 0x30000);
  if (opts.settings) img.set(opts.settings, 32256 * SECTOR);
  return img;
}
