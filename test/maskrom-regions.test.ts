// The staged install's MaskROM writes through the real rkdeveloptool WASM,
// against the pretend board of fake-rockchip.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FakeBoard } from './fake-rockchip';
import { syntheticLoader } from './synthetic-loader';
import { createRunner } from '../src/maskrom/runner';
import { writeRegions, type RegionHooks, type RegionJob } from '../src/woa/maskrom-regions';
import { bytesSource } from '../src/woa/pieces';

const WASM_DIR = new URL('../vendor/rkdeveloptool-wasm/', import.meta.url);
const haveWasm = existsSync(new URL('rkdeveloptool.wasm', WASM_DIR));
const loader = syntheticLoader();
const MiB = 1024 * 1024;

async function setup(board: FakeBoard) {
  Object.defineProperty(globalThis.navigator, 'usb', { value: board.usb(), configurable: true });
  const mod = await import(pathToFileURL(new URL('rkdeveloptool.js', WASM_DIR).pathname).href);
  return createRunner(mod.default, { log: () => {}, wasmBinary: readFileSync(new URL('rkdeveloptool.wasm', WASM_DIR)) });
}

const hooks = (stages: string[]): RegionHooks => ({
  stage: (s) => stages.push(s), progress: () => {}, log: () => {},
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))), cancelled: () => false,
});

const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

describe.skipIf(!haveWasm)('regions over MaskROM', () => {
  it('reads the partition table, writes every region at its sector, checks samples and resets', async () => {
    const board = new FakeBoard({ storages: { 1: 256 * MiB }, defaultStorage: 1 });
    board.storages.get(1)!.write(0, fill(34 * 512, 0x11));
    const runner = await setup(board);
    const stages: string[] = [];
    let seenHead: Uint8Array | null = null;
    const job: RegionJob = {
      loader, readHead: true, spotCheck: true, resetAfter: true, reconnectTimeout: 5000,
      async plan(p) {
        seenHead = p.head;
        expect(p.capacity).toBe(256 * MiB);
        return { summary: 'two regions', regions: [
          { lba: 100 * 2048, source: bytesSource(fill(3 * MiB, 0x22)), label: 'data' },
          { lba: 0, source: bytesSource(fill(34 * 512, 0x33)), label: 'partition table' },
        ] };
      },
      confirm: async (s) => s === 'two regions',
    };
    const res = await writeRegions(runner, job, hooks(stages));
    expect(res).toMatchObject({ ok: true, written: 3 * MiB + 34 * 512 });
    expect(seenHead!.every((b) => b === 0x11)).toBe(true);
    expect(board.storages.get(1)!.read(100 * MiB, 3 * MiB).every((b) => b === 0x22)).toBe(true);
    expect(board.storages.get(1)!.read(0, 34 * 512).every((b) => b === 0x33)).toBe(true);
    expect(stages).toEqual(['detect', 'loader', 'reconnect', 'probe', 'confirm', 'write', 'check', 'reset']);
    if (res.ok) expect(res.checks).toMatchObject({ matched: res.checks!.samples, filler: 0 });
    expect(board.resets).toBe(1);
  });

  it('writes nothing when the user does not confirm', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    const runner = await setup(board);
    const res = await writeRegions(runner, {
      loader, readHead: false, spotCheck: false, resetAfter: false, reconnectTimeout: 5000,
      plan: async () => ({ summary: null, regions: [{ lba: 2048, source: bytesSource(fill(MiB, 9)), label: 'x' }] }),
      confirm: async () => false,
    }, hooks([]));
    expect(res).toMatchObject({ ok: false, written: 0 });
    expect(board.storages.get(1)!.read(MiB, MiB).every((b) => b === 0)).toBe(true);
  });

  it('counts 0xCC filler past 32 MiB as unknown, not as a failed write', async () => {
    const board = new FakeBoard({ storages: { 1: 256 * MiB }, defaultStorage: 1, fillerFrom: 32 * MiB });
    const runner = await setup(board);
    const res = await writeRegions(runner, {
      loader, readHead: false, spotCheck: true, resetAfter: false, reconnectTimeout: 5000,
      plan: async () => ({ summary: null, regions: [{ lba: 200 * 2048, source: bytesSource(fill(MiB, 5)), label: 'image' }] }),
      confirm: async () => true,
    }, hooks([]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checks).toMatchObject({ matched: 0, filler: 3 });
  });

  it('refuses a region past the end of the storage before writing', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    const runner = await setup(board);
    const res = await writeRegions(runner, {
      loader, readHead: false, spotCheck: false, resetAfter: false, reconnectTimeout: 5000,
      plan: async () => ({ summary: null, regions: [{ lba: 64 * 2048 - 1, source: bytesSource(fill(4096, 1)), label: 'tail' }] }),
      confirm: async () => true,
    }, hooks([]));
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/does not fit/) });
  });
});
