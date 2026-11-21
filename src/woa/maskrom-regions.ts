// Writing a list of regions to a board over Maskrom: the staged Windows
// install, or a firmware image.
//
// The commands are edk2-webflash's (src/web/webflash/flash.js), the sequence
// that has written edk2-rk3576 0.4.0 and 0.4.1 to these boards: db with
// rk3576_spl_loader.bin, then wl, then rd, and no cs, because that loader
// already selects the eMMC on the TaishanPi 3M and CM5-IO and the SPI NOR on
// the ROCK 4D. Added around it, as in Roxora Imager's maskrom/sequence.ts:
// the board is followed through its re-enumeration without a second click
// (Electron grants Rockchip devices), and rfi asks for the storage size.
// Added here: rl of sectors 0..33 to read the partition table, several wl
// at their own sectors, and spot checks of what was written (rl has been
// seen to return 0xCC filler past 32 MiB with this loader, so a sample there
// that does not match is reported, not taken as a failed write).

import { parseFlashSize, parseList, SECTOR, type Runner } from '../maskrom/sequence';
import type { ByteSink } from '../maskrom/rkcore';
import type { ByteSource } from './pieces';
import type { Region } from './stage-layout';

/** Reads this far from the start of the storage come back as written; past it, maybe not. */
export const TRUSTED_READ_BYTES = 32 * 1024 * 1024;
const FILLER = 0xcc;
const SAMPLE = 64 * 1024;

export type RegionStage = 'detect' | 'loader' | 'reconnect' | 'probe' | 'confirm' | 'write' | 'check' | 'reset';

export interface RegionHooks {
  stage(stage: RegionStage, detail?: string): void;
  /** Bytes written of all regions. */
  progress(done: number, total: number): void;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  cancelled(): boolean;
}

export interface Probe {
  /** Bytes, from rfi; null when the loader did not say. */
  capacity: number | null;
  /** Sectors 0..33, when they were asked for. */
  head: Uint8Array | null;
}

export interface RegionJob {
  loader: Uint8Array;
  /** Read sectors 0..33 before planning (the partition table). */
  readHead: boolean;
  /** Turn what was found into the regions to write, or a sentence saying why not. */
  plan(p: Probe): Promise<{ regions: Region[]; summary: unknown } | { stop: string }>;
  /** Ask the user, showing the summary; false stops before anything is written. */
  confirm(summary: unknown): Promise<boolean>;
  spotCheck: boolean;
  resetAfter: boolean;
  reconnectTimeout?: number;
  /** Wait after db before the next command, as on real RK3576 boards. */
  afterLoaderMs?: number;
}

export interface SpotChecks {
  matched: number;
  /** Samples past 32 MiB that read back as 0xCC filler: unknown, not wrong. */
  filler: number;
  /** Samples past 32 MiB that read back as something else: reported, not trusted either way. */
  unsure: number;
  samples: number;
}

export type RegionResult =
  | { ok: true; capacity: number | null; written: number; checks: SpotChecks | null; summary: unknown }
  | { ok: false; reason: string; detail?: string; written: number };

class Collect implements ByteSink {
  chunks: Uint8Array[] = [];
  write(c: Uint8Array) { this.chunks.push(c); }
  bytes(): Uint8Array {
    const n = this.chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

class Stop extends Error {}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Read `sectors` sectors from `lba` (rl). */
export async function readSectors(r: Runner, lba: number, sectors: number): Promise<Uint8Array | null> {
  const sink = new Collect();
  const path = r.mountSink(sink);
  const res = await r.run(['rl', String(lba), String(sectors), path]);
  if (res.code !== 0) return null;
  return sink.bytes().subarray(0, sectors * SECTOR);
}

function samplesOf(r: Region): Array<{ off: number; len: number }> {
  const size = r.source.size;
  const len = Math.min(SAMPLE, size);
  const at = new Set<number>([0, Math.max(0, size - len), Math.floor(size / 2 / SECTOR) * SECTOR]);
  return [...at].map((off) => ({ off, len: Math.min(len, size - off) })).filter((s) => s.len > 0);
}

export async function writeRegions(r: Runner, job: RegionJob, hooks: RegionHooks): Promise<RegionResult> {
  let written = 0;
  const step = async (args: string[], what: string) => {
    if (hooks.cancelled()) throw new Stop('Cancelled.');
    hooks.log(`$ rkdeveloptool ${args.join(' ')}`);
    const res = await r.run(args);
    if (res.code !== 0) throw new Stop(`${what} failed (rkdeveloptool exit ${res.code}).`);
    return res.lines;
  };
  try {
    hooks.stage('detect');
    const mode = parseList((await r.run(['ld'])).lines);
    if (mode === 'none') return { ok: false, reason: 'No board in Maskrom mode was found.', written };
    if (mode === 'several') return { ok: false, reason: 'More than one Rockchip device is connected. Leave only the board you want to write.', written };

    const rfi = async () => {
      const p = await r.run(['rfi']);
      return p.code === 0 ? parseFlashSize(p.lines) : null;
    };
    let capacity: number | null = null;
    if (mode === 'maskrom' && (capacity = await rfi()) !== null) {
      hooks.log('The loader is already running on the board; not sending it again.');
    } else if (mode === 'maskrom') {
      hooks.stage('loader');
      const loader = r.writeFile('loader.bin', job.loader);
      await step(['db', loader], 'Sending the loader');
      hooks.stage('reconnect');
      await hooks.sleep(job.afterLoaderMs ?? 3000);
      const deadline = job.reconnectTimeout ?? 20000;
      let waited = 0;
      let seen = false;
      while (waited < deadline) {
        if (hooks.cancelled()) throw new Stop('Cancelled.');
        const m = parseList((await r.run(['ld'])).lines);
        if (m === 'loader' || m === 'maskrom') {
          seen = true;
          capacity = await rfi();
          if (capacity !== null) break;
        }
        await hooks.sleep(500);
        waited += 500;
      }
      if (!seen) {
        return { ok: false, written, reason: 'The board did not come back after the loader was sent.',
          detail: 'Unplug the USB cable, put the board in Maskrom mode again and retry.' };
      }
      if (capacity === null) hooks.log('The loader runs but did not report the storage size (rfi).');
    } else {
      capacity = await rfi();
    }

    hooks.stage('probe');
    let head: Uint8Array | null = null;
    if (job.readHead) {
      hooks.log('$ rkdeveloptool rl 0 34');
      head = await readSectors(r, 0, 34);
      if (!head) hooks.log('Reading the partition table failed.');
    }
    const planned = await job.plan({ capacity, head });
    if ('stop' in planned) return { ok: false, reason: planned.stop, written };
    const { regions, summary } = planned;
    if (capacity !== null) {
      for (const g of regions) {
        if ((g.lba * SECTOR) + g.source.size > capacity) {
          return { ok: false, written, reason: `${g.label} does not fit the storage (${capacity} bytes). Nothing was written.` };
        }
      }
    }
    hooks.stage('confirm');
    if (!(await job.confirm(summary))) return { ok: false, reason: 'Stopped before writing. Nothing was written.', written };

    hooks.stage('write');
    const total = regions.reduce((s, g) => s + g.source.size, 0);
    hooks.progress(0, total);
    for (const g of regions) {
      const base = written;
      let far = 0;
      const counted: ByteSource = {
        size: g.source.size,
        read(position, length) {
          const b = g.source.read(position, length);
          if (position + length > far) {
            far = position + length;
            hooks.progress(base + far, total);
          }
          return b;
        },
      };
      const path = r.mountSource(counted);
      await step(['wl', String(g.lba), path], `Writing ${g.label}`);
      written += g.source.size;
      hooks.progress(written, total);
    }

    let checks: SpotChecks | null = null;
    if (job.spotCheck) {
      hooks.stage('check');
      checks = { matched: 0, filler: 0, unsure: 0, samples: 0 };
      for (const g of regions) {
        for (const s of samplesOf(g)) {
          const at = g.lba * SECTOR + s.off;
          const sectors = Math.ceil(s.len / SECTOR);
          const got = await readSectors(r, at / SECTOR, sectors);
          const want = g.source.read(s.off, s.len);
          checks.samples++;
          const same = got !== null && sameBytes(got.subarray(0, s.len), want);
          if (same) { checks.matched++; continue; }
          const trusted = at + s.len <= TRUSTED_READ_BYTES;
          if (trusted) {
            return { ok: false, written, reason: `${g.label} does not read back as written (sector ${at / SECTOR}). Write it again.` };
          }
          if (got && got.subarray(0, s.len).every((b) => b === FILLER)) checks.filler++; else checks.unsure++;
          hooks.log(`Sample at sector ${at / SECTOR} (${g.label}) read back ${got ? 'differently' : 'with an error'}; past 32 MiB the loader's reads are not trusted.`);
        }
      }
    }

    if (job.resetAfter) {
      hooks.stage('reset');
      await r.run(['rd']);
    }
    return { ok: true, capacity, written, checks, summary };
  } catch (e) {
    if (e instanceof Stop) {
      const partly = written > 0 ? ' The eMMC is only partly written: run the same write again.' : '';
      return { ok: false, reason: `${e.message}${partly}`, written };
    }
    return { ok: false, reason: 'rkdeveloptool stopped with an error.', detail: String((e as Error)?.message ?? e), written };
  }
}
