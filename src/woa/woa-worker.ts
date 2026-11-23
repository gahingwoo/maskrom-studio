/// <reference lib="webworker" />
// Dedicated worker that runs rkdeveloptool (WASM) for one WoA job over
// Maskrom: the staged Windows install or a firmware write. Like Roxora
// Imager's maskrom/worker.ts, whose runner and file reading it uses, but the
// job is planned here once the board has answered (its eMMC size and
// partition table are needed for the layout), and the page is asked to
// confirm what will be erased before anything is written.

import { createRunner } from '../maskrom/runner';
// maskrom/worker.ts also listens for its own 'start' message; this worker
// never sends one, so only its xhrSource is used here.
import { xhrSource } from '../maskrom/worker';
import { woaBoard, firmwareTargets } from './boards';
import { firmwareRegions } from './firmware-plan';
import { writeRegions, type RegionResult, type RegionStage } from './maskrom-regions';
import { planStage, StageError } from './stage-layout';
import { planHostImage } from './host-image';
import { readVhd } from './vhd';
import { extentSource, type Extent } from './udf';
import type { ByteSource } from './pieces';
import type { SetupOptions } from './setup-files';
import { planFactoryRegions, planWhole } from './restore-plan';
import { readUpdateImage } from './rkfw';
import { TRUSTED_READ_BYTES } from './maskrom-regions';
import { planUpgrade } from './upgrade-plan';

export interface FileRef { url: string; size: number }

export type WoaJob =
  | { kind: 'stage'; boardId: string; winpe: FileRef;
      image: FileRef & { extents: Extent[] | null; name: 'install.wim' | 'install.esd'; imageSize: number;
        sha256: string | null; index: number; edition: string; build: number };
      appVersion: string; spotCheck: boolean; resetAfter: boolean;
      setup: SetupOptions; extras: Array<{ path: string; data: Uint8Array }> }
  | { kind: 'firmware'; boardId: string; targetId: string; image: FileRef; spotCheck: boolean; resetAfter: boolean }
  /** A finished Windows built on a Windows PC into a VHD (host-build.ts), for the eMMC. */
  | { kind: 'vhd'; boardId: string; vhd: FileRef; spotCheck: boolean; resetAfter: boolean }
  /** A whole-disk image (Armbian) from sector 0: replaces everything on the eMMC. */
  | { kind: 'whole'; boardId: string; image: FileRef; label: string; resetAfter: boolean }
  /** A factory update.img: its partition table, loader and partitions. */
  | { kind: 'factory'; boardId: string; image: FileRef; resetAfter: boolean }
  /** A new edk2-rk3576 eMMC image from sector 64, keeping the partition table, Windows and (if asked) the saved UEFI settings. */
  | { kind: 'upgrade'; boardId: string; image: FileRef; keepSettings: boolean; resetAfter: boolean };

export type WoaWorkerRequest =
  | { type: 'woa-start'; moduleUrl: string; wasmUrl: string; loaderUrl: string; job: WoaJob; reconnectTimeout?: number }
  | { type: 'woa-confirm'; ok: boolean }
  /** The page saved the settings backup (or could not). */
  | { type: 'woa-backup-saved'; path: string | null; error?: string };

export type WoaWorkerEvent =
  | { type: 'log'; line: string }
  | { type: 'stage'; stage: RegionStage; detail?: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'planned'; summary: unknown }
  /** Save this copy of the board's UEFI settings on the computer before anything is written. */
  | { type: 'backup'; boardId: string; data: Uint8Array }
  | { type: 'result'; result: RegionResult };

const post = (m: WoaWorkerEvent) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let answer: ((ok: boolean) => void) | null = null;
let saved: ((r: { path: string | null; error?: string }) => void) | null = null;

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

self.addEventListener('message', async (ev: MessageEvent<WoaWorkerRequest>) => {
  const m = ev.data;
  if (m.type === 'woa-confirm') { answer?.(m.ok); answer = null; return; }
  if (m.type === 'woa-backup-saved') { saved?.({ path: m.path, ...(m.error ? { error: m.error } : {}) }); saved = null; return; }
  if (m.type !== 'woa-start') return;
  try {
    const imported = await import(/* @vite-ignore */ m.moduleUrl);
    const factory = imported.default ?? imported.createRKDevelopToolModule;
    const runner = await createRunner(factory, {
      log: (line) => post({ type: 'log', line }),
      locateFile: (p) => (p.endsWith('.wasm') ? m.wasmUrl : p),
    });
    const loader = new Uint8Array(await (await fetch(m.loaderUrl)).arrayBuffer());
    const job = m.job;
    const board = woaBoard(job.boardId);
    if (!board) throw new Error(`unknown board ${job.boardId}`);
    const confirm = (summary: unknown) => new Promise<boolean>((resolve) => {
      answer = resolve;
      post({ type: 'planned', summary });
    });
    const hooks = {
      stage: (stage: RegionStage, detail?: string) => post({ type: 'stage', stage, ...(detail ? { detail } : {}) }),
      progress: (() => {
        let last = -1;
        return (done: number, total: number) => {
          const pct = Math.floor((done * 1000) / Math.max(1, total));
          if (pct !== last) { last = pct; post({ type: 'progress', done, total }); }
        };
      })(),
      log: (line: string) => post({ type: 'log', line }),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      cancelled: () => false, // cancelling terminates the worker
    };

    let result: RegionResult;
    if (job.kind === 'stage') {
      const winpe = xhrSource(job.winpe.url, job.winpe.size);
      const file = xhrSource(job.image.url, job.image.size);
      const imageSrc: ByteSource = job.image.extents
        ? extentSource(file, { path: job.image.name, size: job.image.imageSize, extents: job.image.extents })
        : file;
      result = await writeRegions(runner, {
        loader, readHead: true, spotCheck: job.spotCheck, resetAfter: job.resetAfter,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        async plan(p) {
          if (p.capacity === null) return { stop: 'The loader did not report the eMMC size, which the install layout needs. Nothing was written.' };
          if (!p.head) return { stop: 'The partition table could not be read from the eMMC. Nothing was written.' };
          try {
            const plan = planStage({
              board, diskBytes: p.capacity, head: p.head, winpe, rand: random, appVersion: job.appVersion,
              setup: job.setup, extras: job.extras,
              image: { source: imageSrc, name: job.image.name, sha256: job.image.sha256, index: job.image.index, edition: job.image.edition, build: job.image.build },
            });
            return {
              regions: plan.regions,
              summary: {
                kind: 'stage', capacity: p.capacity, windowsBytes: plan.windowsBytes, totalBytes: plan.totalBytes,
                removed: plan.removed.map((x) => ({ name: x.name || '(no name)', bytes: (x.lastLba - x.firstLba + 1) * 512 })),
                diskGuid: plan.diskGuid, certificates: plan.certificates, layout: plan.layout, chosen: !!job.setup?.layout,
              },
            };
          } catch (e) {
            if (e instanceof StageError) return { stop: e.message };
            throw e;
          }
        },
        confirm,
      }, hooks);
    } else if (job.kind === 'vhd') {
      const vhd = readVhd(xhrSource(job.vhd.url, job.vhd.size));
      result = await writeRegions(runner, {
        loader, readHead: true, spotCheck: job.spotCheck, resetAfter: job.resetAfter,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        async plan(p) {
          if (p.capacity === null) return { stop: 'The loader did not report the eMMC size, which the install layout needs. Nothing was written.' };
          if (!p.head) return { stop: 'The partition table could not be read from the eMMC. Nothing was written.' };
          try {
            const plan = planHostImage({ board, capacity: p.capacity, head: p.head, vhd });
            return {
              regions: plan.regions,
              summary: {
                kind: 'stage', capacity: p.capacity, windowsBytes: plan.windowsBytes, totalBytes: plan.totalBytes,
                removed: plan.removed.map((x) => ({ name: x.name || '(no name)', bytes: (x.lastLba - x.firstLba + 1) * 512 })),
              },
            };
          } catch (e) {
            if (e instanceof StageError) return { stop: e.message };
            throw e;
          }
        },
        confirm,
      }, hooks);
    } else if (job.kind === 'whole') {
      const image = xhrSource(job.image.url, job.image.size);
      result = await writeRegions(runner, {
        loader, readHead: false, spotCheck: true, resetAfter: job.resetAfter, checkHeadBytes: TRUSTED_READ_BYTES,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: async (p) => planWhole(image, job.label, p.capacity),
        confirm,
      }, hooks);
    } else if (job.kind === 'upgrade') {
      const image = xhrSource(job.image.url, job.image.size);
      const keep = job.keepSettings;
      result = await writeRegions(runner, {
        loader, readHead: true, spotCheck: false, resetAfter: job.resetAfter, checkHeadBytes: TRUSTED_READ_BYTES,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: (p) => planUpgrade({
          boardId: job.boardId, image, probe: p, keepSettings: keep, log: hooks.log,
          saveBackup: (data) => new Promise((resolve) => { saved = resolve; post({ type: 'backup', boardId: job.boardId, data }); }),
        }),
        confirm,
      }, hooks);
    } else if (job.kind === 'factory') {
      const file = xhrSource(job.image.url, job.image.size);
      const pkg = readUpdateImage(file);
      const before: NonNullable<Parameters<typeof writeRegions>[1]['before']> = [];
      result = await writeRegions(runner, {
        loader, readHead: false, spotCheck: true, resetAfter: job.resetAfter, checkHeadBytes: TRUSTED_READ_BYTES, before,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: async (p) => {
          const r = planFactoryRegions(file, pkg, p.capacity);
          if ('stop' in r) return r;
          // As RKDevTool's "Upgrade Firmware": the partition table from parameter.txt, then the loader, then the partitions.
          before.push(
            { what: 'Writing the partition table', files: [{ name: 'parameter.txt', data: r.parameter }], args: ([f]) => ['gpt', f] },
            { what: 'Writing the boot loader', files: [{ name: 'MiniLoaderAll.bin', data: r.loader }], args: ([f]) => ['ul', f] },
          );
          return { regions: r.regions, summary: r.summary };
        },
        confirm,
      }, hooks);
    } else {
      const target = firmwareTargets(board).find((t) => t.id === job.targetId);
      if (!target) throw new Error(`unknown firmware choice ${job.targetId}`);
      const image = xhrSource(job.image.url, job.image.size);
      result = await writeRegions(runner, {
        loader, readHead: board.firmwareStorage === 'emmc', spotCheck: job.spotCheck, resetAfter: job.resetAfter,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: async (p) => {
          const r = await firmwareRegions(board, target, image, p);
          return 'stop' in r ? r : { regions: r.regions, summary: { kind: 'firmware', ...r.summary } };
        },
        confirm,
      }, hooks);
    }
    post({ type: 'result', result });
  } catch (e) {
    post({ type: 'result', result: { ok: false, written: 0, reason: 'The Maskrom writer could not start.', detail: String((e as Error)?.message ?? e) } });
  }
});
