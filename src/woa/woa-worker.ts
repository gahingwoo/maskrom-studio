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
import { HybridError, readArmbianImage } from './armbian-hybrid';
import { planHostImage } from './host-image';
import { readVhd } from './vhd';
import { extentSource, type Extent } from './udf';
import type { ByteSource } from './pieces';
import type { SetupOptions } from './setup-files';
import { planFactoryRegions, planWhole } from './restore-plan';
import { readUpdateImage } from './rkfw';
import { TRUSTED_READ_BYTES } from './maskrom-regions';
import { planUpgrade } from './upgrade-plan';
import { readPreWriteBackup, readSpiPreWriteBackup } from './pre-write-backup';
import { spiStorageProblem } from './spi-image';
import { checkArmbianOnce } from './armbian-once';
import { STORAGES } from '../maskrom/boards';
import type { Probe } from './maskrom-regions';
import { readBoardArea, tryPlan, withFlashSettings, type BoardArea, type FlashSettings } from './settings-board';
import { sameFirmware, type SettingOption, type SettingsRequest } from './uefi-settings';
import { bytesSource } from './pieces';

export interface FileRef { url: string; size: number }

export type WoaJob =
  | { kind: 'stage'; boardId: string; winpe: FileRef;
      image: FileRef & { extents: Extent[] | null; name: 'install.wim' | 'install.esd'; imageSize: number;
        sha256: string | null; index: number; edition: string; build: number };
      appVersion: string; spotCheck: boolean; resetAfter: boolean;
      setup: SetupOptions; extras: Array<{ path: string; data: Uint8Array }>;
      /** Armbian next to Windows: Armbian's disk image (decompressed) and the size of its partition. */
      armbian?: FileRef & { partitionBytes: number; label: string } }
  | { kind: 'firmware'; boardId: string; targetId: string; image: FileRef; spotCheck: boolean; resetAfter: boolean; settings?: FlashSettings }
  /** A finished Windows built on a Windows PC into a VHD (host-build.ts), for the eMMC. */
  | { kind: 'vhd'; boardId: string; vhd: FileRef; spotCheck: boolean; resetAfter: boolean }
  /** A whole-disk image (Armbian) from sector 0: replaces everything on the eMMC. */
  | { kind: 'whole'; boardId: string; image: FileRef; label: string; resetAfter: boolean }
  /** A factory update.img: its partition table, loader and partitions. */
  | { kind: 'factory'; boardId: string; image: FileRef; resetAfter: boolean }
  /** A new edk2-rk3576 eMMC image from sector 64, keeping the partition table, Windows and (if asked) the saved UEFI settings. */
  | { kind: 'upgrade'; boardId: string; image: FileRef; keepSettings: boolean; resetAfter: boolean; settings?: FlashSettings }
  /**
   * The board's UEFI settings: read them (posted as settings-read), wait for the
   * page's settings-apply, then write the changed area, read it back and compare.
   * `options` is the release's settings list, made for `firmwareVersion`.
   */
  | { kind: 'settings'; boardId: string; options: SettingOption[]; firmwareVersion: string | null; resetAfter: boolean }
  /** Read only: does the SPL on the board's SPI NOR flash start Armbian once from the SD card (armbian-once.ts)? */
  | { kind: 'armbian-once-check'; boardId: string; resetAfter: boolean };

export type WoaWorkerRequest =
  | { type: 'woa-start'; moduleUrl: string; wasmUrl: string; loaderUrl: string; job: WoaJob; reconnectTimeout?: number }
  | { type: 'woa-confirm'; ok: boolean }
  /** The page saved the settings backup (or could not). */
  | { type: 'woa-backup-saved'; path: string | null; error?: string }
  /** What to do with the settings read (settings job); close: write nothing. */
  | { type: 'settings-apply'; request: SettingsRequest | { kind: 'close' } };

export type WoaWorkerEvent =
  | { type: 'log'; line: string }
  | { type: 'stage'; stage: RegionStage; detail?: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'planned'; summary: unknown }
  /** Save this copy of the board's UEFI settings on the computer before anything is written. */
  | { type: 'backup'; boardId: string; data: Uint8Array }
  /** Before a write that replaces the eMMC's start: the partition table and UEFI settings, to keep on the computer (answered with woa-backup-saved). */
  | { type: 'pre-backup'; boardId: string; files: Array<{ name: string; data: Uint8Array }>; notes: string[] }
  /** The settings job read the board: its settings area, where it is and which firmware runs. */
  | { type: 'settings-read'; read: BoardArea & { sameFirmware: boolean } }
  | { type: 'result'; result: RegionResult };

const post = (m: WoaWorkerEvent) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let answer: ((ok: boolean) => void) | null = null;
let saved: ((r: { path: string | null; error?: string }) => void) | null = null;
let settingsAnswer: ((r: SettingsRequest | { kind: 'close' }) => void) | null = null;

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

self.addEventListener('message', async (ev: MessageEvent<WoaWorkerRequest>) => {
  const m = ev.data;
  if (m.type === 'woa-confirm') { answer?.(m.ok); answer = null; return; }
  if (m.type === 'woa-backup-saved') { saved?.({ path: m.path, ...(m.error ? { error: m.error } : {}) }); saved = null; return; }
  if (m.type === 'settings-apply') { settingsAnswer?.(m.request); settingsAnswer = null; return; }
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
    // Every write here but the upgrade (which keeps its own copy) replaces the
    // eMMC's partition table or its firmware: keep both on the computer first.
    type Planned = { regions: import('./stage-layout').Region[]; summary: unknown } | { stop: string };
    const keepFirst = (plan: (p: Probe) => Promise<Planned>) => async (p: Probe): Promise<Planned> => {
      let b;
      if (board.spi) {
        // Only the SPI NOR flash is read and kept: never a UFS module the loader may have chosen.
        const where = spiStorageProblem(board, p.capacity);
        if (where) return { stop: where };
        b = await readSpiPreWriteBackup(board, p, hooks.log);
        if (!b) return { stop: 'The SPI NOR flash could not be read for the copy kept before writing. Nothing was written.' };
      } else if (board.firmwareStorage !== 'emmc') return plan(p);
      else b = await readPreWriteBackup(job.boardId, p, hooks.log);
      if (b) {
        const s = await new Promise<{ path: string | null; error?: string }>((resolve) => {
          saved = resolve;
          post({ type: 'pre-backup', boardId: job.boardId, files: b.files, notes: b.notes });
        });
        if (!s.path) return { stop: `The copy of the partition table and UEFI settings could not be saved on this computer${s.error ? `: ${s.error}` : ''}. Nothing was written.` };
      }
      return plan(p);
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
        plan: keepFirst(async (p) => {
          if (p.capacity === null) return { stop: 'The loader did not report the eMMC size, which the install layout needs. Nothing was written.' };
          if (!p.head) return { stop: 'The partition table could not be read from the eMMC. Nothing was written.' };
          try {
            const armbian = job.armbian ? { parts: readArmbianImage(xhrSource(job.armbian.url, job.armbian.size)), partitionBytes: job.armbian.partitionBytes } : undefined;
            const plan = planStage({
              board, diskBytes: p.capacity, head: p.head, winpe, rand: random, appVersion: job.appVersion,
              setup: job.setup, extras: job.extras, ...(armbian ? { armbian } : {}),
              image: { source: imageSrc, name: job.image.name, sha256: job.image.sha256, index: job.image.index, edition: job.image.edition, build: job.image.build },
            });
            return {
              regions: plan.regions,
              summary: {
                kind: 'stage', capacity: p.capacity, windowsBytes: plan.windowsBytes, totalBytes: plan.totalBytes,
                removed: plan.removed.map((x) => ({ name: x.name || '(no name)', bytes: (x.lastLba - x.firstLba + 1) * 512 })),
                diskGuid: plan.diskGuid, certificates: plan.certificates, layout: plan.layout, chosen: !!job.setup?.layout,
                armbian: plan.armbian && job.armbian ? { bytes: plan.armbian.bytes, label: job.armbian.label } : null,
              },
            };
          } catch (e) {
            if (e instanceof StageError || e instanceof HybridError) return { stop: e instanceof HybridError ? `${e.message} Nothing was written.` : e.message };
            throw e;
          }
        }),
        confirm,
      }, hooks);
    } else if (job.kind === 'vhd') {
      const vhd = readVhd(xhrSource(job.vhd.url, job.vhd.size));
      result = await writeRegions(runner, {
        loader, readHead: true, spotCheck: job.spotCheck, resetAfter: job.resetAfter,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: keepFirst(async (p) => {
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
        }),
        confirm,
      }, hooks);
    } else if (job.kind === 'whole') {
      const image = xhrSource(job.image.url, job.image.size);
      result = await writeRegions(runner, {
        loader, readHead: false, spotCheck: true, resetAfter: job.resetAfter, checkHeadBytes: TRUSTED_READ_BYTES,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: keepFirst(async (p) => planWhole(image, job.label, p.capacity)),
        confirm,
      }, hooks);
    } else if (job.kind === 'upgrade') {
      const image = xhrSource(job.image.url, job.image.size);
      const keep = job.keepSettings;
      result = await writeRegions(runner, {
        loader, readHead: true, spotCheck: false, resetAfter: job.resetAfter, checkHeadBytes: TRUSTED_READ_BYTES,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: (p) => planUpgrade({
          boardId: job.boardId, image, probe: p, keepSettings: keep, log: hooks.log, ...(job.settings ? { settings: job.settings } : {}),
          saveBackup: (data) => new Promise((resolve) => { saved = resolve; post({ type: 'backup', boardId: job.boardId, data }); }),
        }),
        confirm,
      }, hooks);
    } else if (job.kind === 'armbian-once-check') {
      // Nothing is written: the plan reads the SPL and has no regions, and there is nothing to confirm.
      result = await writeRegions(runner, {
        loader, readHead: false, spotCheck: false, resetAfter: job.resetAfter,
        ...(board.spi ? { storage: { code: STORAGES.spinor.code, label: STORAGES.spinor.label } } : {}),
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: async (p) => {
          const where = spiStorageProblem(board, p.capacity);
          if (where) return { stop: where };
          if (!p.read) return { stop: 'The SPI NOR flash cannot be read over MaskROM. Nothing was written.' };
          const r = await checkArmbianOnce(board, p.read);
          if (!r.ok) return { stop: r.reason };
          hooks.log(`ArmbianOnce/1 found in the SPL at SPI NOR byte 0x${r.offset.toString(16)}.`);
          return { regions: [], summary: { kind: 'armbian-once', offset: r.offset } };
        },
        confirm: async () => true,
      }, hooks);
    } else if (job.kind === 'settings') {
      // 1. Read: nothing is written and the board is not reset, so the page can show the settings
      //    and the same loader session takes the write.
      const storage = board.spi ? { storage: { code: STORAGES.spinor.code, label: STORAGES.spinor.label } } : {};
      const wait = m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {};
      let first: BoardArea | null = null;
      const readArea = async (p: Probe): Promise<BoardArea | string> => {
        if (board.spi) { const where = spiStorageProblem(board, p.capacity); if (where) return where; }
        if (!p.read) return 'The board cannot be read over MaskROM.';
        return readBoardArea(board, p.read);
      };
      const read = await writeRegions(runner, {
        loader, readHead: false, spotCheck: false, resetAfter: false, ...storage, ...wait,
        plan: async (p) => {
          const a = await readArea(p);
          if (typeof a === 'string') return { stop: `${a} Nothing was written.` };
          first = a;
          hooks.log(`UEFI settings read from sector ${a.lba} (${a.area.length} bytes)${a.stamp ? `, firmware ${a.stamp}` : ''}${a.problem ? `: ${a.problem}` : ''}.`);
          return { regions: [], summary: { kind: 'settings-read' } };
        },
        confirm: async () => true,
      }, hooks);
      const got = first as BoardArea | null;
      if (!read.ok || !got) { result = read; } else {
        const shown: BoardArea = got;
        const same = sameFirmware(shown.stamp, job.firmwareVersion);
        post({ type: 'settings-read', read: { ...shown, sameFirmware: same } });
        const request = await new Promise<SettingsRequest | { kind: 'close' }>((resolve) => { settingsAnswer = resolve; });
        if (request.kind === 'close') {
          if (job.resetAfter) await runner.run(['rd']);
          result = { ok: true, capacity: read.capacity, written: 0, checks: null, summary: { kind: 'settings', variables: [], written: false } };
        } else {
          // 2. Write: the area again, unchanged since it was shown, the copy on the computer, the new
          //    area, then all of it read back and compared (it lies in the part where reads are trusted).
          result = await writeRegions(runner, {
            loader, readHead: false, spotCheck: false, resetAfter: job.resetAfter, ...storage, ...wait,
            checkHeadBytes: board.spi ? board.spi.bytes : TRUSTED_READ_BYTES,
            plan: keepFirst(async (p) => {
              const now = await readArea(p);
              if (typeof now === 'string') return { stop: `${now} Nothing was written.` };
              if (now.lba !== shown.lba || now.area.length !== shown.area.length || now.area.some((x, i) => x !== shown.area[i])) {
                return { stop: 'The UEFI settings on the board changed since they were read. Read them again. Nothing was written.' };
              }
              const plan = tryPlan(now.area, request, job.options, same);
              if ('stop' in plan) return plan;
              const summary = { kind: 'settings', variables: plan.variables, reclaimed: plan.reclaimed, lba: now.lba, written: !!plan.bytes, restore: request.kind === 'restore' };
              if (!plan.bytes) { hooks.log('The settings on the board already have these values; nothing to write.'); return { regions: [], summary }; }
              hooks.log(`Writing ${plan.bytes.length} bytes at sector ${now.lba}${plan.variables.length ? `: ${plan.variables.join(', ')}` : ''}${plan.reclaimed ? ' (the store was compacted to make room)' : ''}.`);
              return { regions: [{ lba: now.lba, source: bytesSource(plan.bytes), label: 'The UEFI settings' }], summary };
            }),
            confirm: async () => true,
          }, hooks);
        }
      }
    } else if (job.kind === 'factory') {
      const file = xhrSource(job.image.url, job.image.size);
      const pkg = readUpdateImage(file);
      const before: NonNullable<Parameters<typeof writeRegions>[1]['before']> = [];
      result = await writeRegions(runner, {
        loader, readHead: false, spotCheck: true, resetAfter: job.resetAfter, checkHeadBytes: TRUSTED_READ_BYTES, before,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: keepFirst(async (p) => {
          const r = planFactoryRegions(file, pkg, p.capacity);
          if ('stop' in r) return r;
          // As RKDevTool's "Upgrade Firmware": the partition table from parameter.txt, then the loader, then the partitions.
          before.push(
            { what: 'Writing the partition table', files: [{ name: 'parameter.txt', data: r.parameter }], args: ([f]) => ['gpt', f] },
            { what: 'Writing the boot loader', files: [{ name: 'MiniLoaderAll.bin', data: r.loader }], args: ([f]) => ['ul', f] },
          );
          return { regions: r.regions, summary: r.summary };
        }),
        confirm,
      }, hooks);
    } else {
      const target = firmwareTargets(board).find((t) => t.id === job.targetId);
      if (!target) throw new Error(`unknown firmware choice ${job.targetId}`);
      const image = xhrSource(job.image.url, job.image.size);
      result = await writeRegions(runner, {
        loader, readHead: board.firmwareStorage === 'emmc', spotCheck: job.spotCheck, resetAfter: job.resetAfter,
        // The SPI NOR is selected explicitly, and everything written there (16 MiB) is read back and compared.
        ...(board.spi ? { storage: { code: STORAGES.spinor.code, label: STORAGES.spinor.label }, checkHeadBytes: board.spi.bytes } : {}),
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: keepFirst(async (p) => {
          const r = await firmwareRegions(board, target, image, p);
          if ('stop' in r) return r;
          if (!job.settings) return { regions: r.regions, summary: { kind: 'firmware', ...r.summary } };
          const s = await withFlashSettings(board, target, image, r.regions, p.read, job.settings, hooks.log);
          return 'stop' in s ? s : { regions: s.regions, summary: { kind: 'firmware', ...r.summary, applied: s.variables } };
        }),
        confirm,
      }, hooks);
    }
    post({ type: 'result', result });
  } catch (e) {
    post({ type: 'result', result: { ok: false, written: 0, reason: 'The MaskROM writer could not start.', detail: String((e as Error)?.message ?? e) } });
  }
});
