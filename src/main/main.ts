// The Electron main process: the window, the app:// protocol, WebUSB access
// for the Maskrom worker, and everything that touches disks or the network.

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, session, shell, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as drivelist from 'drivelist';
import { classifyDrives, isOfferedTarget, type DriveInfo } from '../shared/targets';
import { withDiskFacts } from './linux-disks';
import type { ArmbianChoice, ArmbianRequest, BoardHereInfo, BoardJobRequest, JobProgress, JobResult, Releases, Served, WindowsChoice } from '../shared/ipc';
import { applyEdits, clearWork, extractRootfs, findE2fsprogs, inspectRootfs, newUuid, NO_E2FSPROGS, type ArmbianImage } from './armbian-image';
import { ARMBIAN_BOARDS, ArmbianError, defaultPartitionBytes, espFiles, GRUB_EFI, linuxUserProblem, timeZoneProblem } from '../woa/armbian';
import { createHash } from 'node:crypto';
import { helperLaunch, loadSudoPrompt, runHelper, sudoPromptElevate } from './elevate';
import { decompress, fetchImage, forgetFile, serveFile, serveFileAs } from './images';
import { ensureLoader } from './loader-cache';
import { handleProtocol, ORIGIN, registerScheme } from './protocol';
import { macWrite } from './mac-write';
import { loadSettings, saveSettings } from './settings';
import { afterUpdateCleanup, cancelUpdate, checkForUpdate, installUpdate, restartApp } from './updater';
import { installUsbHandlers, ROCKCHIP_VID, type UsbChoice } from './usb';
import { boardHere, NO_MTD_HELP } from './board-here';
import { hashWindowsImage, inspectWindowsImage, type WindowsImage } from './windows-image';
import { firmwareRelease, FIRMWARE_REPO, latestRelease, WINPE_REPO, winpeRelease, type FirmwareRelease, type WinpeRelease } from '../woa/releases';
import type { BoardId } from '../woa/boards';
import { fileSource, type BoardJob } from '../helper/board-write';
import { hostBuildFiles } from '../woa/host-build';
import { MIN_DISK_BYTES } from '../woa/stage-layout';
import { woaBoard } from '../woa/boards';
import type { HostBuildRequest, HostBuildResult } from '../shared/ipc';

/** The eMMC size the Windows host build makes its virtual disk for (the boards' eMMC as seen). */
const EMMC_BYTES: Partial<Record<BoardId, number>> = { tspi3m: 62008590336, cm5io: 31272730624 };
import { OPENSSH, type SetupOptions } from '../woa/setup-files';
import { unzip } from '../woa/zip';
import { inflateRawSync } from 'node:zlib';
import { readdirSync } from 'node:fs';

registerScheme();

// For screenshots and tests: do not show the window.
const HIDDEN = process.env.WOA_IMAGER_HIDDEN === '1';
// Unpackaged builds only: a pretend board for the screenshots (a folder laid out like / with proc and sys).
const FAKE_ROOT = !app.isPackaged ? process.env.WOA_IMAGER_FAKE_ROOT : undefined;

const appDir = app.getAppPath();
const resourcesDir = join(appDir, 'resources');
const cacheDir = () => join(app.getPath('userData'), 'images');
const loaderDir = () => join(app.getPath('userData'), 'loaders');

const WRITER = process.platform === 'win32' ? 'woa-rk3576-imager-writer.exe' : 'woa-rk3576-imager-writer';
const RAWDISK = 'woa-rk3576-imager-rawdisk';
function writerPath(name = WRITER): string {
  return app.isPackaged ? join(process.resourcesPath, 'writer', name) : join(appDir, 'build-res', 'writer', name);
}

const LINKS = /^https:\/\/(github\.com\/gahingwoo\/|flash\.gahingwoo\.com\/|edk2\.gahingwoo\.com\/|zadig\.akeo\.ie\/)/;

let win: BrowserWindow | null = null;
let job: AbortController | null = null;
const pendingUsb = new Map<number, (id: string) => void>();

function sendProgress(wc: WebContents, p: JobProgress) {
  if (!wc.isDestroyed()) wc.send('job:progress', p);
}

function askUsb(wc: WebContents, choices: UsbChoice[]): Promise<string> {
  return new Promise((resolve) => {
    pendingUsb.get(wc.id)?.('');
    pendingUsb.set(wc.id, resolve);
    wc.send('usb:choose', choices.map((c) => ({ deviceId: c.deviceId, productName: c.productName, productId: c.productId })));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 780, minWidth: 720, minHeight: 560,
    show: false,
    title: 'WoA RK3576 Imager',
    icon: join(resourcesDir, 'icons', 'png', 'woa-rk3576-imager-256.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f0f0f0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(appDir, 'build', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(HIDDEN ? { offscreen: true } : {}),
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (LINKS.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  if (!HIDDEN) win.once('ready-to-show', () => win?.show());
  win.loadURL(`${ORIGIN}/index.html`);
}

/** Run one job at a time; a second one is refused. */
async function exclusive<T>(fn: (signal: AbortSignal) => Promise<T>, busy: T): Promise<T> {
  if (job) return busy;
  job = new AbortController();
  try {
    return await fn(job.signal);
  } finally {
    job = null;
  }
}

// --- releases ---------------------------------------------------------------

let firmware: FirmwareRelease | null = null;
let winpe: WinpeRelease | null = null;

// Unpackaged builds only, for the screenshots: made-up releases, no network.
const FAKE_RELEASES = !app.isPackaged && process.env.WOA_IMAGER_FAKE_RELEASES === '1';
if (FAKE_RELEASES) {
  const a = (file: string, size: number) => ({ file, url: `https://example.invalid/${file}`, size, sha256: '0'.repeat(64), sample: false as const });
  firmware = { tag: '0.4.1', url: null, problems: [], images: {
    tspi3m: a('TaishanPi3M-emmc-edk2-0.4.1.img', 33554432), cm5io: a('CM5IO-emmc-edk2-0.4.1.img', 33554432), rock4d: a('ROCK4D-spi-edk2-0.4.1.img', 16777216),
  } };
  winpe = { tag: '0.1.1', url: null, problems: [], image: a('woa-rk3576-winpe-0.1.1.img.xz', 352252908) };
}

ipcMain.handle('woa:releases', async (_e, force: boolean): Promise<Releases> => {
  const problems: string[] = [];
  if (FAKE_RELEASES) force = false;
  const fetchFn = (url: string, init?: { headers?: Record<string, string> }) => net.fetch(url, init);
  if (!firmware || force) {
    try {
      const { rel, sums } = await latestRelease(FIRMWARE_REPO, fetchFn);
      firmware = firmwareRelease(rel, sums);
    } catch (e) { problems.push(`edk2-rk3576: ${(e as Error).message}`); }
  }
  if (!winpe || force) {
    try {
      const { rel, sums } = await latestRelease(WINPE_REPO, fetchFn);
      winpe = winpeRelease(rel, sums);
    } catch (e) { problems.push(`woa-rk3576: ${(e as Error).message}`); }
  }
  return {
    firmware: firmware ? {
      tag: firmware.tag, url: firmware.url,
      boards: Object.fromEntries(Object.entries(firmware.images).map(([k, v]) => [k, { file: v!.file, size: v!.size }])),
    } : null,
    winpe: winpe?.image ? { tag: winpe.tag, url: winpe.url, file: winpe.image.file, size: winpe.image.size } : null,
    problems: [...problems, ...(firmware?.problems ?? []), ...(winpe?.problems ?? [])],
  };
});

// Files served to the Maskrom worker, and the paths behind them (the page holds tokens only).
const servedPaths = new Map<string, string>();
const serve = (path: string, name: string): Served => {
  const s = serveFile(path);
  servedPaths.set(s.token, path);
  return { token: s.token, url: `${ORIGIN}/file/${s.token}`, size: s.size, name };
};

async function firmwareFile(wc: WebContents, board: BoardId, signal: AbortSignal): Promise<string> {
  const img = firmware?.images[board];
  if (!img) throw new Error('The edk2-rk3576 release has no firmware image for this board (or it could not be read).');
  return fetchImage(img, cacheDir(), (p) => sendProgress(wc, p), signal);
}

ipcMain.handle('woa:prepare-firmware', (e, board: BoardId) => exclusive(async (signal) => {
  try {
    const path = await firmwareFile(e.sender, board, signal);
    return serve(path, firmware!.images[board]!.file);
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

/** The WinPE image, decompressed once into the cache (about 540 MB). */
let winpeImg: { tag: string; path: string; size: number; sha256: string } | null = null;
async function winpeFile(wc: WebContents, signal: AbortSignal): Promise<typeof winpeImg & object> {
  if (!winpe?.image) throw new Error('The woa-rk3576 release has no WinPE image (or it could not be read).');
  if (winpeImg && winpeImg.tag === winpe.tag) return winpeImg;
  const xz = await fetchImage(winpe.image, cacheDir(), (p) => sendProgress(wc, p), signal);
  // One decompressed copy per release, kept with its SHA-256 beside it; older ones are removed.
  const dir = join(cacheDir(), 'winpe');
  const name = `${winpe.image.file.replace(/\.xz$/, '')}`;
  const keep = join(dir, name);
  try {
    const [sum, size] = readFileSync(`${keep}.sha256`, 'utf8').trim().split(/\s+/);
    if (/^[0-9a-f]{64}$/.test(sum) && statSync(keep).size === Number(size)) {
      winpeImg = { tag: winpe.tag, path: keep, size: Number(size), sha256: sum };
      return winpeImg;
    }
  } catch { /* not there yet */ }
  rmSync(dir, { recursive: true, force: true });
  const out = await decompress(xz, dir, (p) => sendProgress(wc, p), signal);
  renameSync(out.path, keep);
  writeFileSync(`${keep}.sha256`, `${out.sha256} ${out.size}\n`);
  winpeImg = { tag: winpe.tag, path: keep, size: out.size, sha256: out.sha256 };
  return winpeImg;
}

ipcMain.handle('woa:prepare-winpe', (e) => exclusive(async (signal) => {
  try {
    const w = await winpeFile(e.sender, signal);
    return serve(w.path, winpe!.image!.file.replace(/\.xz$/, ''));
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

ipcMain.handle('woa:release', (_e, token: string) => {
  servedPaths.delete(token);
  // A prepared Armbian root file system is used once: its copy goes.
  const armbian = armbianServed.has(token);
  armbianServed.delete(token);
  forgetFile(token, armbian);
});

// --- the Windows image --------------------------------------------------------

const windowsImages = new Map<string, WindowsImage & { sha256?: string }>();

function describeWindows(path: string): WindowsChoice | { error: string } {
  try {
    const img = inspectWindowsImage(path);
    const token = randomBytes(16).toString('hex');
    windowsImages.set(token, img);
    return {
      token, fileName: img.fileName, container: img.container, imageName: img.imageName, imageSize: img.imageSize,
      fileSize: img.fileSize, extents: img.extents,
      editions: img.editions.map((x) => ({ index: x.index, name: x.name, build: x.build, spBuild: x.spBuild, refuse: x.refuse, totalBytes: x.totalBytes })),
    };
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
}

const TEST_PICK = !app.isPackaged ? process.env.WOA_IMAGER_TEST_PICK : undefined;

ipcMain.handle('woa:pick-windows', async () => {
  if (TEST_PICK) return describeWindows(TEST_PICK);
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose the Windows 11 23H2 ARM64 image',
    properties: ['openFile'],
    filters: [{ name: 'Windows images', extensions: ['iso', 'wim', 'esd'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return describeWindows(r.filePaths[0]);
});

ipcMain.handle('woa:drop-windows', (_e, path: unknown) => (typeof path === 'string' && path ? describeWindows(path) : { error: 'That is not a file on this computer.' }));

ipcMain.handle('woa:hash-windows', (e, token: string) => exclusive(async (signal) => {
  const img = windowsImages.get(token);
  if (!img) return { error: 'Choose the Windows image again.' };
  if (img.sha256) return { sha256: img.sha256 };
  try {
    img.sha256 = await hashWindowsImage(img, (bytes) => sendProgress(e.sender, { stage: 'check', bytes, total: img.imageSize }), signal);
    return { sha256: img.sha256 };
  } catch (err) {
    if (signal.aborted) return { error: 'Cancelled.' };
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

ipcMain.handle('woa:serve-windows', (_e, token: string) => {
  const img = windowsImages.get(token);
  if (!img) return { error: 'Choose the Windows image again.' };
  return serve(img.path, img.fileName);
});

// --- what goes with the image: OpenSSH, extra drivers -------------------------------

/** The OpenSSH release files, from the pinned Win32-OpenSSH zip (downloaded once, checked). */
async function opensshFiles(wc: WebContents, signal: AbortSignal): Promise<Array<{ path: string; data: Uint8Array }>> {
  const zip = await fetchImage({ ...OPENSSH, sample: false }, cacheDir(), (p) => sendProgress(wc, p), signal);
  return unzip(new Uint8Array(readFileSync(zip)), (d) => new Uint8Array(inflateRawSync(d)))
    .filter((e) => e.path.startsWith(OPENSSH.root) && e.data.length > 0)
    .map((e) => ({ path: `openssh/${e.path.slice(OPENSSH.root.length)}`, data: e.data }));
}

const MAX_DRIVER_BYTES = 512 << 20;
const driverFolders = new Map<string, { dir: string; name: string; files: string[]; bytes: number }>();

function readDriverFolder(dir: string): { token: string; name: string; files: number; bytes: number; infs: number } | { error: string } {
  const files: string[] = [];
  let bytes = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 8) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { files.push(p); bytes += statSync(p).size; }
    }
  };
  try { walk(dir, 0); } catch (err) { return { error: String((err as Error).message ?? err) }; }
  const infs = files.filter((f) => /\.inf$/i.test(f)).length;
  if (!infs) return { error: 'driver.noinf' };
  if (bytes > MAX_DRIVER_BYTES || files.length > 5000) return { error: 'driver.toobig' };
  const token = randomBytes(16).toString('hex');
  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'drivers';
  driverFolders.set(token, { dir, name, files, bytes });
  return { token, name, files: files.length, bytes, infs };
}

function driverFiles(token: string): Array<{ path: string; data: Uint8Array }> {
  const f = driverFolders.get(token);
  if (!f) throw new Error('Choose the driver folder again.');
  const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'drivers';
  return f.files.map((p) => ({
    path: `extra-drivers/${safe}/${p.slice(f.dir.length).split(/[\\/]/).filter(Boolean).map((x) => x.replace(/[\\:*?"<>|]/g, '_')).join('/')}`,
    data: new Uint8Array(readFileSync(p)),
  }));
}

ipcMain.handle('woa:pick-drivers', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose a folder with driver packages (.inf, .cat, .sys)', properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return null;
  return readDriverFolder(r.filePaths[0]);
});

ipcMain.handle('woa:prepare-extras', (e, o: { ssh: boolean; drivers: string | null }) => exclusive(async (signal) => {
  try {
    const files = [...(o.ssh ? await opensshFiles(e.sender, signal) : []), ...(o.drivers ? driverFiles(o.drivers) : [])];
    return { files };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

// --- Armbian next to Windows -------------------------------------------------------
// The user's image is never changed: its root partition is copied into the
// app's folder (one copy at a time), checked there, edited when the write
// starts, written, and removed (src/main/armbian-image.ts).

const armbianDir = () => join(app.getPath('userData'), 'armbian');
const armbianChoices = new Map<string, { boardId: BoardId; fileName: string; img: ArmbianImage; used: boolean }>();
const armbianServed = new Set<string>();
const TEST_PICK_ARMBIAN = !app.isPackaged ? process.env.WOA_IMAGER_TEST_ARMBIAN : undefined;

function dropArmbian(token: string): void {
  const c = armbianChoices.get(token);
  armbianChoices.delete(token);
  if (c) rmSync(c.img.rootfs, { force: true });
}

ipcMain.handle('woa:armbian-tools', () => {
  if (process.platform === 'win32') return { ok: false, reason: 'armbian.windowshost' };
  return findE2fsprogs() ? { ok: true, reason: null } : { ok: false, reason: NO_E2FSPROGS };
});

ipcMain.handle('woa:pick-armbian', (e, boardId: BoardId) => exclusive(async (signal): Promise<ArmbianChoice | { error: string } | null> => {
  const tools = findE2fsprogs();
  if (!tools) return { error: process.platform === 'win32' ? 'armbian.windowshost' : NO_E2FSPROGS };
  if (!ARMBIAN_BOARDS[boardId]) return { error: 'Armbian next to Windows is not offered for this board.' };
  let path = TEST_PICK_ARMBIAN;
  if (!path) {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the Armbian image for this board',
      properties: ['openFile'],
      filters: [{ name: 'Armbian images', extensions: ['img', 'xz', 'gz'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    path = r.filePaths[0];
  }
  for (const t of [...armbianChoices.keys()]) dropArmbian(t);
  mkdirSync(armbianDir(), { recursive: true });
  const out = join(armbianDir(), `rootfs-${randomBytes(6).toString('hex')}.ext4`);
  try {
    await extractRootfs(path, out, (p) => sendProgress(e.sender, p), signal);
    const img = inspectRootfs(tools, out, boardId);
    const token = randomBytes(16).toString('hex');
    const fileName = path.split(/[\\/]/).pop() ?? path;
    armbianChoices.set(token, { boardId, fileName, img, used: false });
    return {
      token, fileName, boardName: img.release.BOARD_NAME ?? img.release.BOARD, version: img.release.VERSION ?? '',
      kernels: img.facts.kernels, rootfsBytes: img.rootfsBytes, defaultBytes: defaultPartitionBytes(img.rootfsBytes),
    };
  } catch (err) {
    rmSync(out, { force: true });
    if (signal.aborted) return { error: 'Cancelled.' };
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

/** Make the changes to the chosen copy (once), and the files for the EFI partition. */
function prepareArmbianFiles(req: ArmbianRequest, setup: SetupOptions, boardId: BoardId):
  { path: string; size: number; esp: Array<{ path: string; data: Uint8Array }> } {
  const tools = findE2fsprogs();
  if (!tools) throw new ArmbianError(NO_E2FSPROGS);
  const c = armbianChoices.get(req.token);
  if (!c) throw new ArmbianError('Choose the Armbian image again. Nothing was written.');
  if (c.boardId !== boardId) throw new ArmbianError('The Armbian image was chosen for another board. Choose it again.');
  if (c.used) throw new ArmbianError('This copy of Armbian was prepared for an earlier write. Choose the Armbian image again.');
  if (!Number.isSafeInteger(req.partitionBytes) || req.partitionBytes < c.img.rootfsBytes) throw new ArmbianError('The Armbian partition is smaller than its root file system.');
  const account = setup.skipSetup ? {
    user: req.user, realName: setup.skipSetup.user, password: setup.skipSetup.password, locale: req.locale, timeZone: req.timeZone,
  } : null;
  if (account) {
    const bad = linuxUserProblem(account.user) ?? timeZoneProblem(account.timeZone);
    if (bad) throw new ArmbianError(bad);
  }
  const grub = new Uint8Array(readFileSync(join(resourcesDir, 'armbian', GRUB_EFI.file)));
  if (createHash('sha256').update(grub).digest('hex') !== GRUB_EFI.sha256) throw new ArmbianError(`${GRUB_EFI.file} in the app is not the one it was built with. Reinstall the app.`);
  c.used = true;
  const boot = { boardId, uuid: newUuid(), defaultOs: req.defaultOs, timeout: 5 };
  applyEdits(tools, c.img, { ...boot, account, sshKey: setup.sshKey }, join(armbianDir(), 'tmp'));
  return { path: c.img.rootfs, size: statSync(c.img.rootfs).size, esp: espFiles(grub, { ...boot, appVersion: app.getVersion() }) };
}

ipcMain.handle('woa:prepare-armbian', (_e, req: ArmbianRequest, setup: SetupOptions, boardId: BoardId) => exclusive(async () => {
  try {
    const p = prepareArmbianFiles(req, setup, boardId);
    const s = serve(p.path, 'armbian-rootfs.ext4');
    armbianServed.add(s.token);
    armbianChoices.delete(req.token);
    return { served: s, esp: p.esp };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

// --- Windows built on this PC (Windows hosts only) -------------------------------

ipcMain.handle('woa:host-build', (e, req: HostBuildRequest) => exclusive(async (signal): Promise<HostBuildResult> => {
  if (process.platform !== 'win32') return { ok: false, reason: 'host.windowsOnly' };
  const wc = e.sender;
  const img = windowsImages.get(req.windowsToken);
  if (!img) return { ok: false, reason: 'Choose the Windows image again. Nothing was written.' };
  const ed = img.editions.find((x) => x.index === req.index);
  if (!ed || ed.refuse) return { ok: false, reason: ed?.refuse ?? 'Choose an edition. Nothing was written.' };
  const dir = join(app.getPath('userData'), 'host-build');
  try {
    let diskNumber: number | undefined;
    let diskBytes: number | undefined;
    if (req.target !== 'emmc') {
      const drives = await withDiskFacts(await drivelist.list() as unknown as DriveInfo[]);
      if (!req.device || !isOfferedTarget(req.device, drives, { minSize: MIN_DISK_BYTES, platform: process.platform, internal: false })) {
        return { ok: false, reason: `${req.device ?? 'The drive'} is not a drive the imager writes to (system disk, read-only, too small, or gone). Nothing was written.` };
      }
      const m = /PhysicalDrive(\d+)$/i.exec(req.device);
      if (!m) return { ok: false, reason: `${req.device} is not a physical drive.` };
      diskNumber = Number(m[1]);
      diskBytes = drives.find((d) => d.device === req.device)!.size ?? undefined;
    }
    const pe = await winpeFile(wc, signal);
    const extras = [...(req.setup.ssh ? await opensshFiles(wc, signal) : []), ...(req.drivers ? driverFiles(req.drivers) : [])];
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const vhdPath = join(dir, 'woa-emmc.vhd');
    const board = woaBoard(req.boardId);
    if (req.target === 'emmc' && !board?.windows) return { ok: false, reason: 'This board has no eMMC for Windows.' };
    const winpeSrc = fileSource(pe.path);
    let files;
    try {
      files = hostBuildFiles({
        target: req.target, mode: req.target === 'emmc' ? 'vhd' : 'disk',
        ...(req.target === 'emmc' ? { vhdPath, vhdBytes: EMMC_BYTES[req.boardId] } : { diskNumber, diskBytes }),
        source: img.container === 'iso' ? { path: img.path, kind: 'iso', inner: `sources\\${img.imageName}` } : { path: img.path, kind: 'wim', inner: '' },
        index: ed.index, edition: ed.name, build: ed.build ?? 0, winpe: winpeSrc, setup: req.setup, extras, appVersion: app.getVersion(),
      });
    } finally {
      winpeSrc.close();
    }
    for (const f of files) {
      const p = join(dir, ...f.path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.data);
    }
    // The script runs elevated (UAC); its console goes to a file this process follows.
    const consoleFile = join(dir, 'console.txt');
    writeFileSync(consoleFile, '');
    let seen = 0;
    const timer = setInterval(() => {
      try {
        const text = readFileSync(consoleFile, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length > seen) { seen = lines.length; sendProgress(wc, { stage: 'write', bytes: seen, total: 0, note: lines[lines.length - 1] }); }
      } catch { /* not yet */ }
    }, 1000);
    try {
      const sudo = await loadSudoPrompt();
      await new Promise<void>((resolve, reject) => {
        sudo.exec(`cmd.exe /c ""${join(dir, 'host-build.cmd')}" > "${consoleFile}" 2>&1"`, { name: 'WoA RK3576 Imager' },
          (err: Error | undefined) => (err ? reject(err) : resolve()));
      }).catch(() => { /* the log says what happened */ });
    } finally {
      clearInterval(timer);
    }
    const log = (() => { try { return readFileSync(join(dir, 'host-build.log'), 'utf8'); } catch { return ''; } })();
    // The answer file held the password: gone before anything else happens.
    rmSync(join(dir, 'unattend.xml'), { force: true });
    if (!/WOA-HOST-BUILD-OK/.test(log)) {
      return { ok: false, reason: 'host.failed', detail: log.split(/\r?\n/).slice(-30).join('\n') };
    }
    if (req.target === 'emmc') {
      const s = serve(vhdPath, 'woa-emmc.vhd');
      return { ok: true, vhd: s };
    }
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}, { ok: false, reason: 'Another job is running.' }));

// --- this board ------------------------------------------------------------------

ipcMain.handle('woa:board-here', async (): Promise<BoardHereInfo> => {
  const h = await boardHere(FAKE_ROOT ?? '');
  return {
    rk3576: h.rk3576, boardId: h.board?.id ?? null, boardName: h.board?.name ?? null,
    compatible: h.compatible, smbiosProduct: h.smbiosProduct,
    emmc: h.emmc ? { device: h.emmc.device, bytes: h.emmc.bytes, model: h.emmc.model, mounts: h.emmc.mounts } : null,
    emmcRefusal: h.emmcRefusal, mtd: h.mtd, noMtdHelp: NO_MTD_HELP,
  };
});

function runElevated(wc: WebContents, signal: AbortSignal, args: (socket: string, token: string) => string[], total: () => number): Promise<JobResult> {
  return runHelper({
    signal,
    launch: (dir) => helperLaunch({ writerPath: writerPath(), dir, appImage: process.env.APPIMAGE }),
    args,
    onMessage: (m) => {
      if (m.type === 'progress') sendProgress(wc, { stage: m.stage, bytes: m.bytes, total: Math.max(total(), m.bytes), speed: m.speed });
    },
    elevate: sudoPromptElevate,
  }).then((out) => (out.ok ? { ok: true, sha256: out.sha256 } : { ok: false, reason: out.reason, ...(out.detail ? { detail: out.detail } : {}) }));
}

ipcMain.handle('woa:write-board', (e, req: BoardJobRequest) => exclusive(async (signal): Promise<JobResult> => {
  if (process.platform !== 'linux' && req.kind !== 'stage-disk') return { ok: false, reason: 'Writing the board this runs on works on Linux only.' };
  if (process.platform === 'darwin') return { ok: false, reason: 'host.macDisk' };
  const wc = e.sender;
  let bj: BoardJob;
  let total = 0;
  let armbianCopy: string | null = null;
  try {
    if (req.kind === 'stage-disk') {
      const img = windowsImages.get(req.windowsToken);
      if (!img) return { ok: false, reason: 'Choose the Windows image again. Nothing was written.' };
      const ed = img.editions.find((x) => x.index === req.index);
      if (!ed || ed.refuse) return { ok: false, reason: ed?.refuse ?? 'Choose an edition. Nothing was written.' };
      const pe = await winpeFile(wc, signal);
      if (!img.sha256) img.sha256 = await hashWindowsImage(img, (bytes) => sendProgress(wc, { stage: 'check', bytes, total: img.imageSize }), signal);
      const extras = [...(req.setup.ssh ? await opensshFiles(wc, signal) : []), ...(req.drivers ? driverFiles(req.drivers) : [])];
      bj = { kind: 'stage-disk', target: req.target, device: req.device, boardId: req.boardId, winpe: pe.path, appVersion: app.getVersion(),
        setup: req.setup, extras: extras.map((x) => ({ path: x.path, base64: Buffer.from(x.data).toString('base64') })),
        image: { path: img.path, extents: img.extents, name: img.imageName, size: img.imageSize, sha256: img.sha256,
          index: ed.index, edition: ed.name, build: ed.build ?? 0 } };
      total = img.imageSize + pe.size;
    } else if (req.kind === 'stage') {
      const img = windowsImages.get(req.windowsToken);
      if (!img) return { ok: false, reason: 'Choose the Windows image again. Nothing was written.' };
      const ed = img.editions.find((x) => x.index === req.index);
      if (!ed || ed.refuse) return { ok: false, reason: ed?.refuse ?? 'Choose an edition. Nothing was written.' };
      const pe = await winpeFile(wc, signal);
      if (!img.sha256) img.sha256 = await hashWindowsImage(img, (bytes) => sendProgress(wc, { stage: 'check', bytes, total: img.imageSize }), signal);
      const extras = [...(req.setup.ssh ? await opensshFiles(wc, signal) : []), ...(req.drivers ? driverFiles(req.drivers) : [])];
      let armbian: { path: string; partitionBytes: number } | undefined;
      if (req.armbian) {
        const p = prepareArmbianFiles(req.armbian, req.setup, req.boardId);
        armbianCopy = p.path;
        armbian = { path: p.path, partitionBytes: req.armbian.partitionBytes };
        extras.push(...p.esp);
        total += p.size;
      }
      bj = { kind: 'stage', device: req.device, boardId: req.boardId, winpe: pe.path, appVersion: app.getVersion(), ...(armbian ? { armbian } : {}),
        setup: req.setup, extras: extras.map((x) => ({ path: x.path, base64: Buffer.from(x.data).toString('base64') })),
        image: { path: img.path, extents: img.extents, name: img.imageName, size: img.imageSize, sha256: img.sha256,
          index: ed.index, edition: ed.name, build: ed.build ?? 0 } };
      total += img.imageSize + pe.size;
    } else {
      const path = await firmwareFile(wc, req.boardId, signal);
      bj = req.kind === 'firmware'
        ? { kind: 'firmware', device: req.device, boardId: req.boardId, targetId: req.targetId, image: path }
        : { kind: 'spinor', device: req.device, boardId: req.boardId, image: path };
      total = firmware!.images[req.boardId]!.size;
    }
  } catch (err) {
    if (armbianCopy) rmSync(armbianCopy, { force: true });
    if (signal.aborted) return { ok: false, reason: 'Cancelled. Nothing was written.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
  const dir = mkdtempSync(join(tmpdir(), 'woa-rk3576-imager-job-'));
  const jobFile = join(dir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(bj), { mode: 0o600 });
  try {
    return await runElevated(wc, signal, (socket, token) => ['--socket', socket, '--token', token, '--job', jobFile], () => total);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // The prepared root file system holds the first-start presets: it goes once written.
    if (armbianCopy) rmSync(armbianCopy, { force: true });
  }
}, { ok: false, reason: 'Another write is running.' }));

// --- the fallback: the WinPE image on a USB drive ----------------------------------

ipcMain.handle('drives:list', async (_e, minSize: number) => {
  const drives = await withDiskFacts(await drivelist.list() as unknown as DriveInfo[]);
  return classifyDrives(drives, { minSize, platform: process.platform, internal: false });
});

ipcMain.handle('woa:write-stick', (e, device: string) => exclusive(async (signal): Promise<JobResult> => {
  const wc = e.sender;
  try {
    const w = await winpeFile(wc, signal);
    const out = process.platform === 'darwin'
      ? await macWrite({
        signal, image: w.path, device, extractSize: w.size, extractSha256: w.sha256, helperPath: writerPath(RAWDISK),
        onProgress: (p) => sendProgress(wc, { stage: p.stage, bytes: p.bytes, total: w.size, speed: p.speed }),
      })
      : await runHelper({
        signal,
        launch: (dir) => helperLaunch({ writerPath: writerPath(), dir, appImage: process.env.APPIMAGE }),
        args: (socket, token) => ['--socket', socket, '--token', token, '--image', w.path, '--device', device,
          '--extract-size', String(w.size), '--extract-sha256', w.sha256],
        onMessage: (m) => { if (m.type === 'progress') sendProgress(wc, { stage: m.stage, bytes: m.bytes, total: w.size, speed: m.speed }); },
        elevate: sudoPromptElevate,
      });
    return out.ok ? { ok: true, sha256: out.sha256 } : { ok: false, reason: out.reason, ...(out.detail ? { detail: out.detail } : {}) };
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}, { ok: false, reason: 'Another write is running.' }));

ipcMain.handle('job:cancel', () => { job?.abort(); });

// --- Maskrom loader, USB, settings, updates ---------------------------------------

ipcMain.handle('maskrom:loader', async (_e, name: string) => {
  try {
    await ensureLoader(loaderDir(), name, (url) => net.fetch(url));
    return { url: `${ORIGIN}/loader/${encodeURIComponent(name)}` };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

ipcMain.on('usb:answer', (e, deviceId: string) => {
  const r = pendingUsb.get(e.sender.id);
  pendingUsb.delete(e.sender.id);
  r?.(deviceId);
});

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  return { updateCheck: s.updateCheck, betaUpdates: s.betaUpdates, resetAfterMaskrom: s.resetAfterMaskrom };
});
ipcMain.handle('settings:set', (_e, patch: { updateCheck?: boolean; betaUpdates?: boolean; resetAfterMaskrom?: boolean }) => {
  const s = loadSettings();
  saveSettings({
    ...s,
    ...(typeof patch.updateCheck === 'boolean' ? { updateCheck: patch.updateCheck } : {}),
    ...(typeof patch.betaUpdates === 'boolean' ? { betaUpdates: patch.betaUpdates } : {}),
    ...(typeof patch.resetAfterMaskrom === 'boolean' ? { resetAfterMaskrom: patch.resetAfterMaskrom } : {}),
  });
});
ipcMain.handle('update:check', (_e, force: boolean) => checkForUpdate(force === true));
ipcMain.handle('update:install', (e) => (job
  ? { ok: false, reason: 'A write is running. Update when it is done.' } : installUpdate(e.sender)));
ipcMain.handle('update:cancel', () => cancelUpdate());
ipcMain.handle('update:restart', () => { if (!job) restartApp(); });
ipcMain.handle('clipboard:write', (_e, text: unknown) => {
  if (typeof text !== 'string' || text.length > 20000) return false;
  clipboard.writeText(text);
  return true;
});
ipcMain.handle('open-external', (_e, url: string) => {
  if (LINKS.test(url)) return shell.openExternal(url);
});
ipcMain.on('app:info', (e) => {
  e.returnValue = { platform: process.platform, version: app.getVersion() };
});
ipcMain.on('theme', (_e, t: 'light' | 'dark') => { nativeTheme.themeSource = t; });

app.on('will-quit', () => { try { clearWork(armbianDir()); } catch { /* best effort */ } });

app.whenReady().then(() => {
  afterUpdateCleanup();
  // Copies of Armbian root file systems left by an earlier run (several GB each).
  try { clearWork(armbianDir()); } catch { /* best effort */ }
  handleProtocol(join(appDir, 'build', 'renderer'), resourcesDir, loaderDir());
  const testVid = !app.isPackaged ? Number(process.env.WOA_IMAGER_USB_TEST_VID ?? NaN) : NaN;
  const vendorIds = Number.isInteger(testVid) ? [ROCKCHIP_VID, testVid] : [ROCKCHIP_VID];
  if (!app.isPackaged && process.env.WOA_IMAGER_TEST_SERVE) serveFileAs('test', process.env.WOA_IMAGER_TEST_SERVE);
  if (!app.isPackaged && process.env.WOA_IMAGER_TEST_SERVE_XZ) serveFileAs('xz', process.env.WOA_IMAGER_TEST_SERVE_XZ);
  installUsbHandlers(session.defaultSession, { origins: [ORIGIN], vendorIds }, askUsb);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
