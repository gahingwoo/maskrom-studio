// What the preload script exposes to the page as window.imager.
import type { HiddenDrive, Target } from './targets';
import type { UpdateCheck, UpdateResult } from './update';
import type { BoardId } from '../woa/boards';
import type { Extent } from '../woa/udf';
import type { SetupOptions } from '../woa/setup-files';

export type JobProgress = {
  stage: 'download' | 'check' | 'decompress' | 'write' | 'verify';
  bytes: number;
  total: number;
  speed?: number;
};

export type JobResult = { ok: true; sha256: string } | { ok: false; reason: string; detail?: string };

/** The latest edk2-rk3576 and woa-rk3576 releases, as far as they could be read. */
export interface Releases {
  firmware: { tag: string; url: string | null; boards: Partial<Record<BoardId, { file: string; size: number }>> } | null;
  winpe: { tag: string; url: string | null; file: string; size: number } | null;
  problems: string[];
}

/** A file the main process serves to the Maskrom worker (app://local/file/<token>). */
export interface Served {
  token: string;
  url: string;
  size: number;
  name: string;
}

export interface EditionInfo {
  index: number;
  name: string;
  build: number | null;
  spBuild: number | null;
  refuse: string | null;
  totalBytes: number;
}

/** The Windows image the user chose, as read on this computer. */
export interface WindowsChoice {
  token: string;
  fileName: string;
  container: 'iso' | 'wim' | 'esd';
  imageName: 'install.wim' | 'install.esd';
  imageSize: number;
  fileSize: number;
  extents: Extent[] | null;
  editions: EditionInfo[];
}

export interface DriverFolder { token: string; name: string; files: number; bytes: number; infs: number }

export interface BoardHereInfo {
  rk3576: boolean;
  boardId: BoardId | null;
  boardName: string | null;
  compatible: string[];
  smbiosProduct: string | null;
  emmc: { device: string; bytes: number; model: string; mounts: string[] } | null;
  emmcRefusal: string | null;
  mtd: Array<{ device: string; name: string; bytes: number }>;
  noMtdHelp: string;
}

export type BoardJobRequest =
  | { kind: 'stage'; boardId: BoardId; device: string; windowsToken: string; index: number; setup: SetupOptions; drivers: string | null }
  | { kind: 'firmware'; boardId: BoardId; device: string; targetId: string }
  | { kind: 'spinor'; boardId: BoardId; device: string };

export interface ImagerApi {
  platform: string;
  version: string;
  releases(force?: boolean): Promise<Releases>;
  /** Download the board's firmware from the release, checked, and serve it to the Maskrom worker. */
  prepareFirmware(board: BoardId): Promise<Served | { error: string }>;
  /** Download and decompress the WinPE image from the release, and serve it. */
  prepareWinpe(): Promise<Served | { error: string }>;
  /** Choose the Windows ISO, WIM or ESD (dialog), and read its editions. */
  pickWindows(): Promise<WindowsChoice | { error: string } | null>;
  /** The same for a file dropped onto the window. */
  dropWindows(file: File): Promise<WindowsChoice | { error: string }>;
  /** Read the whole image once for its SHA-256, which the board checks again. */
  hashWindows(token: string): Promise<{ sha256: string } | { error: string }>;
  /** Serve the chosen Windows file to the Maskrom worker. */
  serveWindows(token: string): Promise<Served | { error: string }>;
  /** Choose a folder of extra driver packages (wddm-mali-g52, gt9271, ...). Errors are translation keys or messages. */
  pickDrivers(): Promise<DriverFolder | { error: string } | null>;
  /** The files that go onto the staging volume besides the image: OpenSSH (pinned release) and the chosen drivers. */
  prepareExtras(o: { ssh: boolean; drivers: string | null }): Promise<{ files: Array<{ path: string; data: Uint8Array }> } | { error: string }>;
  /** Is this app running on an RK3576 board (Linux)? */
  boardHere(): Promise<BoardHereInfo>;
  /** Write this board's own eMMC or SPI NOR (elevated helper). */
  writeBoard(req: BoardJobRequest): Promise<JobResult>;
  listDrives(minSize: number): Promise<{ targets: Target[]; hidden: HiddenDrive[] }>;
  /** Write the WinPE image to a USB drive (the fallback install stick). */
  writeWinpeStick(device: string): Promise<JobResult>;
  cancel(): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  getLoader(name: string): Promise<{ url: string } | { error: string }>;
  releaseServed(token: string): Promise<void>;
  onUsbChoice(cb: (choices: { deviceId: string; productName?: string; productId: number }[]) => void): () => void;
  answerUsbChoice(deviceId: string): void;
  getSettings(): Promise<{ updateCheck: boolean; betaUpdates?: boolean; resetAfterMaskrom: boolean }>;
  setSettings(s: { updateCheck?: boolean; betaUpdates?: boolean; resetAfterMaskrom?: boolean }): Promise<void>;
  checkUpdate(force: boolean): Promise<UpdateCheck | null>;
  installUpdate?(): Promise<UpdateResult>;
  cancelUpdate?(): Promise<void>;
  restartApp?(): Promise<void>;
  onUpdateProgress?(cb: (p: { bytes: number; total: number }) => void): () => void;
  onUpdateStage?(cb: (stage: string) => void): () => void;
  onUpdateLog?(cb: (text: string) => void): () => void;
  copyText?(text: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
}
