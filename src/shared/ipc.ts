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
  /** A line of text instead of a byte count (the Windows host build's steps). */
  note?: string;
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
  /** "ARM64", "x64", "x86". */
  archName: string;
  /** "Windows 11 23H2", or null for a preview build. */
  release: string | null;
  languages: string[];
  refuse: string | null;
  warn: string | null;
  /** The check behind refuse/warn, for the page's own language (wim.ts checkEdition). */
  check: { level: 'ok' | 'notice' | 'warn' | 'refuse'; code: string; vars: Record<string, string> };
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
  /** What an ISO's efi\boot folder holds; null for a .wim or .esd, or an ISO without one. */
  boot: { arm64: boolean; x64: boolean; x86: boolean } | null;
  /** Why the whole image is refused (an x64 ISO), or null. */
  refuse: string | null;
  editions: EditionInfo[];
}

/** Armbian's current minimal image for a board and kernel branch, as its .sha, .asc and file name say. */
export interface ArmbianChoice {
  branch: 'vendor' | 'edge';
  file: string;
  /** Compressed (.img.xz) size. */
  size: number;
  version: string;
  kernel: string;
  distro: string;
  variant: string;
  /** Date of Armbian's signature. */
  signed: string | null;
}

/** A factory update.img the user chose, as read on this computer. */
export interface FactoryChoice {
  token: string;
  fileName: string;
  size: number;
  chip: string;
  loaderChip: string | null;
  model: string;
  manufacturer: string;
  version: string;
  released: string;
  hasMd5: boolean;
  partitions: Array<{ name: string; lba: number | null; bytes: number; sparse: boolean }>;
  /** Why it cannot be written to this board, or null. */
  refuse: string | null;
}

/** A firmware image ready for an upgrade: served to the worker, with what it says it is. */
export interface UpgradeImage {
  served: Served;
  /** Where it came from: "edk2-rk3576 0.4.1" or the file name. */
  origin: string;
  version: string | null;
  dt: string;
  nvdataLba: number;
  nvdataSectors: number;
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

/** A staged install or a host build onto an SD card or NVMe drive attached to this PC. */
export interface HostBuildRequest {
  target: 'emmc' | 'sd' | 'nvme';
  boardId: BoardId;
  /** sd, nvme: the drive (drivelist device). */
  device?: string;
  windowsToken: string;
  index: number;
  setup: SetupOptions;
  drivers: string | null;
}

export type HostBuildResult = { ok: true; vhd?: Served } | { ok: false; reason: string; detail?: string };

export type BoardJobRequest =
  | { kind: 'stage-disk'; target: 'sd' | 'nvme'; boardId: BoardId; device: string; windowsToken: string; index: number; setup: SetupOptions; drivers: string | null }
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
  /** Armbian's current image for the board: name, kernel, date (only its .sha and .asc are downloaded). */
  findArmbian(board: BoardId, branch: 'vendor' | 'edge'): Promise<ArmbianChoice | { error: string }>;
  /** Download it, check SHA-256 and signature, decompress it, and serve it. */
  prepareArmbian(board: BoardId, branch: 'vendor' | 'edge'): Promise<Served | { error: string }>;
  /** Choose a factory update.img (dialog) and read it. */
  pickFactory(): Promise<FactoryChoice | { error: string } | null>;
  /** Check its MD5 and serve it. */
  prepareFactory(token: string): Promise<Served | { error: string }>;
  /** The firmware for an upgrade: the latest release's eMMC image (downloaded, checked) or a file chosen here; read and checked for this board. */
  prepareUpgrade(board: BoardId, from: 'release' | 'file'): Promise<UpgradeImage | { error: string } | null>;
  /** Keep a copy of the board's UEFI settings (nvdata) on this computer; returns its path. */
  saveNvdata(board: BoardId, data: Uint8Array): Promise<{ path: string } | { error: string }>;
  /** Serve the chosen Windows file to the Maskrom worker. */
  serveWindows(token: string): Promise<Served | { error: string }>;
  /** Choose a folder of extra driver packages (wddm-mali-g52, gt9271, ...). Errors are translation keys or messages. */
  pickDrivers(): Promise<DriverFolder | { error: string } | null>;
  /** The files that go onto the staging volume besides the image: OpenSSH (pinned release) and the chosen drivers. */
  prepareExtras(o: { ssh: boolean; drivers: string | null }): Promise<{ files: Array<{ path: string; data: Uint8Array }> } | { error: string }>;
  /** Is this app running on an RK3576 board (Linux)? */
  boardHere(): Promise<BoardHereInfo>;
  /** Windows host only: build a finished Windows with DISM on a drive here, or in a VHD for the eMMC. */
  hostBuild(req: HostBuildRequest): Promise<HostBuildResult>;
  /** Write this board's own eMMC or SPI NOR, or a staged install onto a drive attached here (elevated helper). */
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
