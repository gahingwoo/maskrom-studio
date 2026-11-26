// The Electron main process: the window, the app:// protocol, WebUSB access
// for the Maskrom worker, and everything that touches disks or the network.

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, screen, session, shell, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { CHROME_MSI, chromeAssociations } from '../woa/trim';
import { homedir, release as osRelease, tmpdir, type as osType, userInfo } from 'node:os';
import { fullLog, issueUrl, type ReportFacts, type Who } from '../shared/report';
import { dirname, join } from 'node:path';
import * as drivelist from 'drivelist';
import { classifyDrives, isOfferedTarget, type DriveInfo } from '../shared/targets';
import { withDiskFacts } from './linux-disks';
import { isWindowsSourceUrl } from '../shared/windows-sources';
import { checkArmbianSignature, checkFactoryMd5, findArmbian, inspectFactory, listArmbian, type ArmbianImage, type FactoryImage } from './restore';
import { planFactory } from '../woa/rkfw';
import { checkNewImage } from '../woa/upgrade-plan';
import type { UpgradeImage } from '../shared/ipc';
import { ARMBIAN_RESTORE, minimumDiskBytes, parseArmbianIndex, type ArmbianOffer } from '../woa/armbian-restore';
import type { ArmbianChoice, DriveWriteRequest, FactoryChoice } from '../shared/ipc';
import type { BoardHereInfo, BoardJobRequest, JobProgress, JobResult, Releases, Served, WindowsChoice } from '../shared/ipc';
import { helperLaunch, loadSudoPrompt, runHelper, sudoPromptElevate } from './elevate';
import { decompress, fetchImage, forgetFile, serveFile, serveFileAs } from './images';
import { ensureLoader } from './loader-cache';
import { handleProtocol, ORIGIN, registerScheme } from './protocol';
import { migrateOldData } from './migrate';
import { cacheInfo, clearCache } from './cache';
import { macWrite, macWriteRegions } from './mac-write';
import { loadSettings, saveSettings } from './settings';
import { afterUpdateCleanup, cancelUpdate, checkForUpdate, installUpdate, restartApp } from './updater';
import { installUsbHandlers, ROCKCHIP_VID, type UsbChoice } from './usb';
import { boardHere, NO_MTD_HELP } from './board-here';
import { hashWindowsImage, inspectWindowsImage, type WindowsImage } from './windows-image';
import { firmwareRelease, FIRMWARE_REPO, tierRelease, WINPE_REPO, winpeRelease, type FirmwareRelease, type GithubRelease, type WinpeRelease } from '../woa/releases';
import { ciCommit, isChannel, releaseLabel, type Channel } from '../shared/channel';
import type { BoardId } from '../woa/boards';
import { fileSource, planDiskStage, type BoardJob } from '../helper/board-write';
import { hostBuildFiles } from '../woa/host-build';
import { MIN_DISK_BYTES, targetRefusal } from '../woa/stage-layout';
import { woaBoard } from '../woa/boards';
import type { HostBuildRequest, HostBuildResult } from '../shared/ipc';

/** The eMMC size the Windows host build makes its virtual disk for (the boards' eMMC as seen). */
import { OPENSSH, type SetupOptions } from '../woa/setup-files';
import { unzip } from '../woa/zip';
import { inflateRawSync } from 'node:zlib';
import { readdirSync } from 'node:fs';

registerScheme();
// Before anything reads the settings: carry them over from the old name's folder.
migrateOldData(app.getPath('appData'), app.getPath('userData'));

// For screenshots and tests: do not show the window.
const HIDDEN = process.env.WOA_IMAGER_HIDDEN === '1';
// Unpackaged builds only: a pretend board for the screenshots (a folder laid out like / with proc and sys).
const FAKE_ROOT = !app.isPackaged ? process.env.WOA_IMAGER_FAKE_ROOT : undefined;

const appDir = app.getAppPath();
const resourcesDir = join(appDir, 'resources');
const cacheDir = () => join(app.getPath('userData'), 'images');
const loaderDir = () => join(app.getPath('userData'), 'loaders');

const WRITER = process.platform === 'win32' ? 'maskrom-studio-writer.exe' : 'maskrom-studio-writer';
const RAWDISK = 'maskrom-studio-rawdisk';
function writerPath(name = WRITER): string {
  return app.isPackaged ? join(process.resourcesPath, 'writer', name) : join(appDir, 'build-res', 'writer', name);
}

const OWN_LINKS = /^https:\/\/(github\.com\/gahingwoo\/|flash\.gahingwoo\.com\/|edk2\.gahingwoo\.com\/|zadig\.akeo\.ie\/|www\.armbian\.com\/boards\/|wiki\.lckfb\.com\/|docs\.armsom\.org\/|gahingwoo\.com$|gahingwoo\.com\/|github\.com\/roxora-os\/imager)/;
/** Links the page may open in the browser: ours, and the listed places to get Windows. */
const LINKS = { test: (url: string) => OWN_LINKS.test(url) || isWindowsSourceUrl(url) };

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
  // Never larger than the screen's work area (a 1366x768 laptop at 125%
  // has 1093x614 to give): a window taller than the screen hides its bottom,
  // and no scrolling inside it can reach that. At least 560 high (UX audit
  // D7): at 480 the content had about 250 px and the confirm page's "erased"
  // row needed scrolling.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1100, area.width), height: Math.min(780, area.height),
    minWidth: Math.min(720, area.width), minHeight: Math.min(560, area.height),
    show: false,
    title: 'Maskrom Studio',
    icon: join(resourcesDir, 'icons', 'png', 'maskrom-studio-256.png'),
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
  // Closing the window in the middle of a write leaves the board, card or drive half written: ask first.
  win.on('close', (e) => {
    if (!busy || HIDDEN || !win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: [busy.stay, busy.leave], defaultId: 0, cancelId: 0, noLink: true, title: busy.title, message: busy.title, detail: busy.text,
    });
    if (choice === 0) e.preventDefault();
    else busy = null;
  });
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
/** What the page is told about each: the tier asked for, the tier used, the release's label and commit. */
interface Tier { asked: Channel; used: Channel; label: string; commit: string | null }
let firmwareTier: Tier | null = null;
let winpeTier: Tier | null = null;

/**
 * The release of `repo` for `channel`. A repository without a CI release yet
 * falls back to its Prerelease tier, and says so (used !== asked).
 */
async function tiered(repo: string, channel: Channel, fetchFn: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>):
  Promise<{ rel: GithubRelease; sums: Map<string, string>; tier: Tier }> {
  let used = channel;
  let got;
  try { got = await tierRelease(repo, channel, fetchFn); } catch (e) {
    if (channel !== 'ci' || !/no CI build release/.test((e as Error).message)) throw e;
    used = 'prerelease';
    got = await tierRelease(repo, used, fetchFn);
  }
  return { ...got, tier: { asked: channel, used, label: releaseLabel(got.rel), commit: got.rel.tag_name === 'ci' ? ciCommit(got.rel) : null } };
}

// Unpackaged builds only, for the screenshots: made-up releases, no network.
const FAKE_RELEASES = !app.isPackaged && process.env.WOA_IMAGER_FAKE_RELEASES === '1';
if (FAKE_RELEASES) {
  const a = (file: string, size: number) => ({ file, url: `https://example.invalid/${file}`, size, sha256: '0'.repeat(64), sample: false as const });
  firmware = { tag: '0.4.1', url: null, problems: [], images: {
    tspi3m: a('TaishanPi3M-emmc-edk2-0.4.1.img', 33554432), cm5io: a('CM5IO-emmc-edk2-0.4.1.img', 33554432), rock4d: a('ROCK4D-spi-edk2-0.4.1.img', 16777216),
  }, sdcard: { tspi3m: a('TaishanPi3M-sdcard-edk2-0.4.1.img', 33554432), cm5io: a('CM5IO-sdcard-edk2-0.4.1.img', 33554432) } };
  winpe = { tag: '0.1.1', url: null, problems: [], image: a('woa-rk3576-winpe-0.1.1.img.xz', 352252908) };
  firmwareTier = { asked: 'stable', used: 'stable', label: '0.4.1', commit: null };
  winpeTier = { asked: 'stable', used: 'stable', label: '0.1.1', commit: null };
}

ipcMain.handle('woa:releases', async (_e, force: boolean): Promise<Releases> => {
  const problems: string[] = [];
  if (FAKE_RELEASES) force = false;
  const fetchFn = (url: string, init?: { headers?: Record<string, string> }) => net.fetch(url, init);
  const channel = loadSettings().firmwareChannel;
  if (!firmware || force || firmwareTier?.asked !== channel) {
    try {
      const { rel, sums, tier } = await tiered(FIRMWARE_REPO, channel, fetchFn);
      firmware = firmwareRelease(rel, sums);
      firmwareTier = tier;
    } catch (e) { problems.push(`edk2-rk3576: ${(e as Error).message}`); firmware = null; firmwareTier = null; }
  }
  if (!winpe || force || winpeTier?.asked !== channel) {
    try {
      const { rel, sums, tier } = await tiered(WINPE_REPO, channel, fetchFn);
      winpe = winpeRelease(rel, sums);
      winpeTier = tier;
    } catch (e) { problems.push(`woa-rk3576: ${(e as Error).message}`); winpe = null; winpeTier = null; }
  }
  return {
    firmware: firmware ? {
      tag: firmware.tag, url: firmware.url,
      boards: Object.fromEntries(Object.entries(firmware.images).map(([k, v]) => [k, { file: v!.file, size: v!.size }])),
      sdcard: Object.fromEntries(Object.entries(firmware.sdcard).map(([k, v]) => [k, { file: v!.file, size: v!.size }])),
      tier: firmwareTier!,
    } : null,
    winpe: winpe?.image ? { tag: winpe.tag, url: winpe.url, file: winpe.image.file, size: winpe.image.size, tier: winpeTier!,
      tools: toolsAsset() ? { file: toolsAsset()!.file, size: toolsAsset()!.size } : null } : null,
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
  forgetFile(token, false);
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
      fileSize: img.fileSize, extents: img.extents, boot: img.boot, refuse: img.refuse,
      editions: img.editions.map((x) => ({
        index: x.index, name: x.name, build: x.build, spBuild: x.spBuild, archName: x.archName, release: x.release, languages: x.languages,
        refuse: x.refuse, warn: x.warn, check: { level: x.check.level, code: x.check.code, vars: x.check.vars }, totalBytes: x.totalBytes,
      })),
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

// --- upgrading the firmware, keeping Windows and the settings -------------

/** Where the copies of the boards' UEFI settings are kept. */
const nvdataDir = () => join(app.getPath('userData'), 'nvdata-backups');

ipcMain.handle('upgrade:prepare', (e, board: BoardId, from: 'release' | 'file') => exclusive(async (signal): Promise<UpgradeImage | { error: string } | null> => {
  try {
    let path: string;
    let origin: string;
    let name: string;
    // Screenshots: the made-up releases have no file; a test image stands in for both choices.
    const testImage = !app.isPackaged ? process.env.WOA_IMAGER_TEST_FIRMWARE : undefined;
    if (from === 'release' && FAKE_RELEASES && testImage) from = 'file';
    if (from === 'file') {
      const pick = testImage;
      if (pick) path = pick;
      else {
        const r = await dialog.showOpenDialog(win!, {
          title: 'Choose an edk2-rk3576 eMMC image', properties: ['openFile'],
          filters: [{ name: 'Firmware image', extensions: ['img'] }, { name: 'All files', extensions: ['*'] }],
        });
        if (r.canceled || r.filePaths.length === 0) return null;
        path = r.filePaths[0];
      }
      name = path.split(/[\\/]/).pop()!;
      origin = name;
    } else {
      path = await firmwareFile(e.sender, board, signal);
      name = firmware!.images[board]!.file;
      origin = `edk2-rk3576 ${firmware!.tag}`;
    }
    const f = fileSource(path);
    let info;
    try { info = await checkNewImage(f, board); } finally { f.close(); }
    if (typeof info === 'string') return { error: info };
    return { served: serve(path, name), origin, version: info.version, dt: info.dt, nvdataLba: info.nvdata.lba, nvdataSectors: info.nvdata.sectors };
  } catch (err) {
    if (signal.aborted) return { error: 'Cancelled.' };
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

ipcMain.handle('upgrade:save-nvdata', (_e, board: BoardId, data: Uint8Array) => {
  try {
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 1 << 20) return { error: 'Not a settings copy.' };
    mkdirSync(nvdataDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(nvdataDir(), `${board}-nvdata-${stamp}.bin`);
    writeFileSync(path, data);
    return { path: shownPath(path) };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

/** Before a write over MaskROM: the partition table and UEFI settings, with a note of what each is. */
ipcMain.handle('backup:save-before-write', (_e, board: BoardId, files: Array<{ name: string; data: Uint8Array }>, notes: string[]) => {
  try {
    if (!woaBoard(board)) return { error: 'Unknown board.' };
    if (!Array.isArray(files) || files.length === 0 || files.length > 4) return { error: 'Nothing to keep.' };
    for (const f of files) {
      if (!/^[a-z0-9.-]{1,64}\.bin$/.test(f?.name ?? '') || !(f.data instanceof Uint8Array) || f.data.length > 1 << 20) return { error: 'Not a backup file.' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(nvdataDir(), `${board}-before-write-${stamp}`);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f.name), f.data);
    const text = (Array.isArray(notes) ? notes : []).map((l) => String(l).replace(/[\r\n]/g, ' ')).join('\n');
    writeFileSync(join(dir, 'backup.txt'), `${text}\n`);
    return { path: shownPath(dir) };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

// --- restoring Armbian or a factory image ----------------------------------

const armbianFound = new Map<string, ArmbianImage>();
const armbianKey = (board: BoardId, id: string) => `${board}:${id}`;

/** Screenshots: Armbian's offers as the index had them on 2026-11-24, no network. */
function fakeArmbianOffers(board: BoardId): ArmbianOffer[] {
  const k = (branch: string) => (branch === 'edge' ? '7.3.5' : '6.1.172');
  const rows: Array<[string, string, string, number, boolean]> = [
    ['trixie', 'vendor', 'minimal', 352968008, true], ['trixie', 'edge', 'minimal', 370574004, false],
    ['resolute', 'vendor', 'minimal', 365602440, false], ['resolute', 'edge', 'minimal', 370312004, false],
    ['resolute', 'vendor', 'gnome', 984104848, true], ['resolute', 'edge', 'gnome', 1002010176, false],
    ['resolute', 'vendor', 'kde-plasma', 1203277816, false], ['resolute', 'edge', 'kde-plasma', 1235194848, false],
  ];
  return parseArmbianIndex({ assets: rows.map(([distro, branch, variant, size, promoted]) => ({
    board_slug: ARMBIAN_RESTORE[board]!.slug, file_extension: 'img.xz', file_application: '', distro, branch, variant,
    redi_url: `https://dl.armbian.com/${ARMBIAN_RESTORE[board]!.slug}/${distro[0].toUpperCase()}${distro.slice(1)}_${branch}_${variant}`,
    file_size: String(size), file_date: '2026-11-20T19:44:46Z', promoted: String(promoted), armbian_version: '26.11.0-trunk.137', kernel_version: k(branch),
  })) }, ARMBIAN_RESTORE[board]!.slug);
}

ipcMain.handle('restore:list-armbian', async (_e, board: BoardId): Promise<{ offers: ArmbianOffer[] } | { error: string }> => {
  try {
    return { offers: FAKE_RELEASES ? fakeArmbianOffers(board) : await listArmbian(board, (url, init) => net.fetch(url, init)) };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

ipcMain.handle('restore:find-armbian', async (_e, board: BoardId, id: string): Promise<ArmbianChoice | { error: string }> => {
  try {
    let a: ArmbianImage;
    if (FAKE_RELEASES) {
      const o = fakeArmbianOffers(board).find((x) => x.id === id);
      if (!o) throw new Error(`No ${id}.`);
      const imageBytes = o.desktop ? 6979321856 : 2059403264;
      const slugName = ARMBIAN_RESTORE[board]!.slug.replace(/^./, (c) => c.toUpperCase());
      a = { board, id, branch: o.branch, file: `Armbian_community_${o.version}_${slugName}_${o.distro}_${o.branch}_${o.kernel}_${o.variant}${o.desktop ? '_desktop' : ''}.img.xz`,
        url: 'https://example.invalid/a.img.xz', size: o.size, sha256: '0'.repeat(64), asc: '', version: o.version, kernel: o.kernel, distro: o.distro,
        variant: o.variant, signed: o.date, desktop: o.desktop, imageBytes, minBytes: minimumDiskBytes(imageBytes, o.desktop) };
    } else a = await findArmbian(board, id, (url, init) => net.fetch(url, init));
    armbianFound.set(armbianKey(board, id), a);
    return { id, branch: a.branch, file: a.file, size: a.size, version: a.version, kernel: a.kernel, distro: a.distro, variant: a.variant,
      signed: a.signed, desktop: a.desktop, imageBytes: a.imageBytes, minBytes: a.minBytes };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

/** Armbian's image for the board, downloaded, checked (SHA-256, signature) and decompressed into the cache. */
async function armbianFile(wc: WebContents, board: BoardId, id: string, signal: AbortSignal): Promise<{ path: string; name: string; size: number; sha256: string; minBytes: number }> {
  const a = armbianFound.get(armbianKey(board, id));
  if (!a) throw new Error('Look up the Armbian image again.');
  const progress = (p: JobProgress) => sendProgress(wc, p);
  const xz = await fetchImage({ file: a.file, url: a.url, size: a.size, sha256: a.sha256, sample: false }, cacheDir(), progress, signal);
  const bad = await checkArmbianSignature(xz, a.asc, (bytes) => progress({ stage: 'check', bytes, total: a.size }), signal);
  if (bad) { rmSync(xz, { force: true }); throw new Error(`${bad} The download was deleted.`); }
  const dir = join(cacheDir(), 'armbian');
  const name = a.file.replace(/\.xz$/, '');
  const keep = join(dir, name);
  const done = (size: number, sha256: string) => ({ path: keep, name, size, sha256, minBytes: minimumDiskBytes(size, a.desktop) });
  try {
    const [sum, size] = readFileSync(`${keep}.sha256`, 'utf8').trim().split(/\s+/);
    if (/^[0-9a-f]{64}$/.test(sum) && statSync(keep).size === Number(size)) return done(Number(size), sum);
  } catch { /* not there yet */ }
  rmSync(dir, { recursive: true, force: true });
  const out = await decompress(xz, dir, progress, signal);
  renameSync(out.path, keep);
  writeFileSync(`${keep}.sha256`, `${out.sha256} ${out.size}\n`);
  return done(out.size, out.sha256);
}

/** The drive's size, as the drive list has it; null when it is not listed. */
async function driveSize(device: string): Promise<number | null> {
  const drives = await drivelist.list() as unknown as Array<{ device: string; size: number | null }>;
  return drives.find((d) => d.device === device)?.size ?? null;
}

/** Write an image file to a removable drive of this computer (the Roxora path: elevated helper or authopen), read back and compared. */
async function writeImageToDrive(wc: WebContents, signal: AbortSignal, img: { path: string; size: number; sha256: string }, device: string): Promise<JobResult> {
  const out = process.platform === 'darwin'
    ? await macWrite({
      signal, image: img.path, device, extractSize: img.size, extractSha256: img.sha256, helperPath: writerPath(RAWDISK),
      onProgress: (p) => sendProgress(wc, { stage: p.stage, bytes: p.bytes, total: img.size, speed: p.speed }),
    })
    : await runHelper({
      signal,
      launch: (dir) => helperLaunch({ writerPath: writerPath(), dir, appImage: process.env.APPIMAGE }),
      args: (socket, token) => ['--socket', socket, '--token', token, '--image', img.path, '--device', device,
        '--extract-size', String(img.size), '--extract-sha256', img.sha256],
      onMessage: (m) => { if (m.type === 'progress') sendProgress(wc, { stage: m.stage, bytes: m.bytes, total: img.size, speed: m.speed }); },
      elevate: sudoPromptElevate,
    });
  return out.ok ? { ok: true, sha256: out.sha256 } : { ok: false, reason: out.reason, ...(out.detail ? { detail: out.detail } : {}) };
}

/** Armbian, or the SD card variant of the firmware, onto an SD card or USB drive of this computer. */
ipcMain.handle('restore:write-drive', (e, req: DriveWriteRequest) => exclusive(async (signal): Promise<JobResult> => {
  try {
    let img: { path: string; size: number; sha256: string };
    if (req.kind === 'armbian') {
      const a = await armbianFile(e.sender, req.board, req.id, signal);
      const have = await driveSize(req.device);
      if (have !== null && have < a.minBytes) {
        return { ok: false, reason: `The drive is ${(have / 1e9).toFixed(1)} GB; this Armbian image needs at least ${(a.minBytes / 1e9).toFixed(1)} GB (the image and room for its first start). Nothing was written.` };
      }
      img = a;
    }
    else {
      const a = firmware?.sdcard[req.board];
      if (!a) return { ok: false, reason: 'The edk2-rk3576 release has no SD card image for this board.' };
      const path = await fetchImage(a, cacheDir(), (p) => sendProgress(e.sender, p), signal);
      img = { path, size: a.size, sha256: a.sha256 };
    }
    return await writeImageToDrive(e.sender, signal, img, req.device);
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}, { ok: false, reason: 'Another write is running.' }));

ipcMain.handle('restore:prepare-armbian', (e, board: BoardId, id: string) => exclusive(async (signal) => {
  try {
    const f = await armbianFile(e.sender, board, id, signal);
    const emmc = woaBoard(board)?.emmc?.bytes ?? null;
    if (emmc !== null && emmc < f.minBytes) return { error: `This Armbian image needs at least ${(f.minBytes / 1e9).toFixed(1)} GB; the board's eMMC has ${(emmc / 1e9).toFixed(1)} GB. Nothing was written.` };
    return serve(f.path, f.name);
  } catch (err) {
    if (signal.aborted) return { error: 'Cancelled.' };
    return { error: String((err as Error).message ?? err) };
  }
}, { error: 'Another job is running.' }));

const factoryImages = new Map<string, FactoryImage & { md5Checked?: boolean }>();

ipcMain.handle('restore:pick-factory', async (): Promise<FactoryChoice | { error: string } | null> => {
  const pick = !app.isPackaged ? process.env.WOA_IMAGER_TEST_FACTORY : undefined;
  let path = pick;
  if (!path) {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the factory update.img',
      properties: ['openFile'],
      filters: [{ name: 'Rockchip firmware', extensions: ['img'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    path = r.filePaths[0];
  }
  try {
    const f = inspectFactory(path);
    const token = randomBytes(16).toString('hex');
    factoryImages.set(token, f);
    const plan = planFactory(f.info, null);
    return {
      token, fileName: f.fileName, size: f.size, chip: f.info.chip, loaderChip: f.info.loader?.chip ?? null,
      model: f.info.model, manufacturer: f.info.manufacturer, version: f.info.version, released: f.info.released, hasMd5: !!f.info.md5,
      partitions: f.info.parts.map((p) => ({ name: p.name, lba: p.lba, bytes: p.size, sparse: p.sparse })),
      refuse: 'stop' in plan ? plan.stop : null,
    };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

ipcMain.handle('restore:prepare-factory', (e, token: string) => exclusive(async (signal) => {
  const f = factoryImages.get(token);
  if (!f) return { error: 'Choose the update.img again.' };
  try {
    if (!f.md5Checked) {
      const bad = await checkFactoryMd5(f, (bytes, total) => sendProgress(e.sender, { stage: 'check', bytes, total }), signal);
      if (bad) return { error: bad };
      f.md5Checked = true;
    }
    return serve(f.path, f.fileName);
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

/**
 * The RK3576 tools bundle: the woa-rk3576 release's rk3576-tools-arm64*.zip,
 * or for testing a build not yet released, WOA_IMAGER_RK3576_TOOLS_URL with
 * _SHA256 and _SIZE (e.g. the CI artifact's zip put somewhere reachable).
 */
function toolsAsset(): { file: string; url: string; size: number; sha256: string } | null {
  const url = process.env.WOA_IMAGER_RK3576_TOOLS_URL;
  const sha = process.env.WOA_IMAGER_RK3576_TOOLS_SHA256;
  const size = Number(process.env.WOA_IMAGER_RK3576_TOOLS_SIZE);
  if (url && sha && /^[0-9a-f]{64}$/i.test(sha) && size > 0) return { file: 'rk3576-tools-arm64.zip', url, size, sha256: sha.toLowerCase() };
  return winpe?.tools ?? null;
}

/** The bundle, checked against its SHA-256, as files under rk3576-tools/ (the folder holding offline-install.cmd). */
async function toolsFiles(wc: WebContents, signal: AbortSignal): Promise<Array<{ path: string; data: Uint8Array }>> {
  const a = toolsAsset();
  if (!a) throw new Error('The woa-rk3576 release has no RK3576 tools bundle. Turn the RK3576 tools off, or try again later.');
  const zip = await fetchImage({ ...a, sample: false }, cacheDir(), (p) => sendProgress(wc, p), signal);
  const entries = unzip(new Uint8Array(readFileSync(zip)), (d) => new Uint8Array(inflateRawSync(d)));
  const marker = entries.find((e) => /(^|\/)offline-install\.cmd$/i.test(e.path));
  if (!marker) throw new Error('The RK3576 tools bundle has no offline-install.cmd.');
  const root = marker.path.slice(0, marker.path.length - 'offline-install.cmd'.length);
  return entries.filter((e) => e.path.startsWith(root) && e.data.length > 0 && !e.path.split('/').includes('..'))
    .map((e) => ({ path: `rk3576-tools/${e.path.slice(root.length)}`, data: e.data }));
}

/**
 * Google's Chrome MSI for Windows on Arm, downloaded from Google at write
 * time (it is not ours to ship) and kept a week. Google publishes no
 * checksum for it: here it must be an MSI for Arm64 of a plausible size;
 * on the board SetupComplete.cmd installs it only when its Authenticode
 * signature is valid and Google LLC's (trim.ts chromeFirstStart).
 */
async function chromeFiles(wc: WebContents, signal: AbortSignal): Promise<Array<{ path: string; data: Uint8Array }>> {
  const dest = join(cacheDir(), CHROME_MSI.file);
  const fresh = (() => { try { return Date.now() - statSync(dest).mtimeMs < 7 * 86400e3; } catch { return false; } })();
  if (!fresh) {
    mkdirSync(cacheDir(), { recursive: true });
    const r = await net.fetch(CHROME_MSI.url, { signal } as RequestInit);
    if (!r.ok || !r.body) throw new Error(`Downloading Google Chrome failed: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    let done = 0;
    const out = createWriteStream(`${dest}.part`);
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
      done += c.length;
      sendProgress(wc, { stage: 'download', bytes: done, total: total || done });
      if (!out.write(c)) await new Promise<void>((res) => { out.once('drain', () => res()); });
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    renameSync(`${dest}.part`, dest);
  }
  const data = new Uint8Array(readFileSync(dest));
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => data[i] === b);
  if (!ole || data.length < 50e6 || data.length > 600e6 || !Buffer.from(data.buffer, data.byteOffset, data.length).includes('Arm64;')) {
    rmSync(dest, { force: true });
    throw new Error('What Google sent is not the Chrome installer for Windows on Arm. Nothing was written.');
  }
  return [
    { path: CHROME_MSI.path, data },
    { path: 'chrome/defaults.xml', data: new TextEncoder().encode(chromeAssociations()) },
  ];
}

/** Everything besides the image that goes onto the staging volume (or the PC build's folder). */
async function extrasFor(wc: WebContents, signal: AbortSignal, o: { ssh: boolean; drivers: string | null; chrome?: boolean; rkTools?: boolean }) {
  return [
    ...(o.ssh ? await opensshFiles(wc, signal) : []),
    ...(o.drivers ? driverFiles(o.drivers) : []),
    ...(o.chrome ? await chromeFiles(wc, signal) : []),
    ...(o.rkTools ? await toolsFiles(wc, signal) : []),
  ];
}

ipcMain.handle('woa:pick-drivers', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose a folder with driver packages (.inf, .cat, .sys)', properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return null;
  return readDriverFolder(r.filePaths[0]);
});

ipcMain.handle('woa:prepare-extras', (e, o: { ssh: boolean; drivers: string | null; chrome?: boolean; rkTools?: boolean }) => exclusive(async (signal) => {
  try {
    const files = await extrasFor(e.sender, signal, o);
    return { files };
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
    const extras = await extrasFor(wc, signal, { ssh: req.setup.ssh, drivers: req.drivers, chrome: !!req.setup.trim?.chrome, rkTools: !!req.setup.rkTools });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const vhdPath = join(dir, 'woa-emmc.vhd');
    const board = woaBoard(req.boardId);
    if (!board) return { ok: false, reason: `There is no board ${req.boardId}.` };
    if (!board.windowsTargets.includes(req.target)) return { ok: false, reason: targetRefusal(board, req.target) };
    const winpeSrc = fileSource(pe.path);
    let files;
    try {
      files = hostBuildFiles({
        target: req.target, mode: req.target === 'emmc' ? 'vhd' : 'disk',
        ...(req.target === 'emmc' ? { vhdPath, vhdBytes: board.emmc!.bytes } : { diskNumber, diskBytes }),
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
        sudo.exec(`cmd.exe /c ""${join(dir, 'host-build.cmd')}" > "${consoleFile}" 2>&1"`, { name: 'Maskrom Studio' },
          (err: Error | undefined) => (err ? reject(err) : resolve()));
      }).catch(() => { /* the log says what happened */ });
    } finally {
      clearInterval(timer);
    }
    const log = (() => { try { return readFileSync(join(dir, 'host-build.log'), 'utf8'); } catch { return ''; } })();
    // The answer file held the password: gone before anything else happens.
    rmSync(join(dir, 'unattend.xml'), { force: true });
    rmSync(join(dir, 'woa-autologon.ps1'), { force: true });
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

/**
 * macOS: the staged layout on an SD card or NVMe drive, planned here (it is
 * plain TypeScript) and written through maskrom-studio-rawdisk --regions,
 * which macOS lets open the disk after the password dialog.
 */
async function stageDiskMac(wc: WebContents, signal: AbortSignal, job: Extract<BoardJob, { kind: 'stage-disk' }>): Promise<JobResult> {
  const size = await driveSize(job.device);
  if (size === null) return { ok: false, reason: `${job.device} is no longer connected. Nothing was written.` };
  let planned: ReturnType<typeof planDiskStage>;
  try {
    planned = planDiskStage(job, size);
  } catch (err) {
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
  if ('stop' in planned) return { ok: false, reason: planned.stop };
  try {
    const out = await macWriteRegions({
      signal, device: job.device, regions: planned.regions, minSize: MIN_DISK_BYTES, helperPath: writerPath(RAWDISK),
      onProgress: (p) => sendProgress(wc, { stage: p.stage, bytes: p.bytes, total: p.total, speed: p.speed }),
    });
    return out.ok ? { ok: true, sha256: out.sha256 } : { ok: false, reason: out.reason, ...(out.detail ? { detail: out.detail } : {}) };
  } finally {
    planned.close();
  }
}

ipcMain.handle('woa:write-board', (e, req: BoardJobRequest) => exclusive(async (signal): Promise<JobResult> => {
  if (process.platform !== 'linux' && req.kind !== 'stage-disk') return { ok: false, reason: 'Writing the board this runs on works on Linux only.' };
  const wc = e.sender;
  let bj: BoardJob;
  let total = 0;
  try {
    if (req.kind === 'stage-disk') {
      const img = windowsImages.get(req.windowsToken);
      if (!img) return { ok: false, reason: 'Choose the Windows image again. Nothing was written.' };
      const ed = img.editions.find((x) => x.index === req.index);
      if (!ed || ed.refuse) return { ok: false, reason: ed?.refuse ?? 'Choose an edition. Nothing was written.' };
      const pe = await winpeFile(wc, signal);
      if (!img.sha256) img.sha256 = await hashWindowsImage(img, (bytes) => sendProgress(wc, { stage: 'check', bytes, total: img.imageSize }), signal);
      const extras = await extrasFor(wc, signal, { ssh: req.setup.ssh, drivers: req.drivers, chrome: !!req.setup.trim?.chrome, rkTools: !!req.setup.rkTools });
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
      const extras = await extrasFor(wc, signal, { ssh: req.setup.ssh, drivers: req.drivers, chrome: !!req.setup.trim?.chrome, rkTools: !!req.setup.rkTools });
      bj = { kind: 'stage', device: req.device, boardId: req.boardId, winpe: pe.path, appVersion: app.getVersion(),
        setup: req.setup, extras: extras.map((x) => ({ path: x.path, base64: Buffer.from(x.data).toString('base64') })),
        image: { path: img.path, extents: img.extents, name: img.imageName, size: img.imageSize, sha256: img.sha256,
          index: ed.index, edition: ed.name, build: ed.build ?? 0 } };
      total = img.imageSize + pe.size;
    } else {
      const path = await firmwareFile(wc, req.boardId, signal);
      bj = req.kind === 'firmware'
        ? { kind: 'firmware', device: req.device, boardId: req.boardId, targetId: req.targetId, image: path }
        : { kind: 'spinor', device: req.device, boardId: req.boardId, image: path, ...(req.targetId ? { targetId: req.targetId } : {}) };
      total = firmware!.images[req.boardId]!.size;
    }
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled. Nothing was written.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
  if (process.platform === 'darwin' && bj.kind === 'stage-disk') return stageDiskMac(wc, signal, bj);
  const dir = mkdtempSync(join(tmpdir(), 'maskrom-studio-job-'));
  const jobFile = join(dir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(bj), { mode: 0o600 });
  try {
    return await runElevated(wc, signal, (socket, token) => ['--socket', socket, '--token', token, '--job', jobFile], () => total);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    return await writeImageToDrive(wc, signal, w, device);
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}, { ok: false, reason: 'Another write is running.' }));

// --- reporting a problem -------------------------------------------------------------

const reporter = (): Who => ({ home: homedir(), user: (() => { try { return userInfo().username; } catch { return ''; } })() });
declare const __BUILD_COMMIT__: string;
const reportFacts = (f: Partial<ReportFacts>): ReportFacts => ({
  version: app.getVersion(), commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
  os: `${osType()} ${osRelease()}`, arch: process.arch,
  board: typeof f.board === 'string' ? f.board : null, mode: typeof f.mode === 'string' ? f.mode : '?',
  task: typeof f.task === 'string' ? f.task : null, step: typeof f.step === 'string' ? f.step : null,
  error: typeof f.error === 'string' ? f.error : null, detail: typeof f.detail === 'string' ? f.detail : null,
  log: Array.isArray(f.log) ? f.log.map(String).slice(-5000) : [],
});

/** Open a new GitHub issue with what the page knows, scrubbed. */
ipcMain.handle('report:open', (_e, f: Partial<ReportFacts>) => shell.openExternal(issueUrl(reportFacts(f), reporter())));

/** The whole log, scrubbed, into a file the user picks (to attach to the issue). */
ipcMain.handle('report:save-log', async (_e, f: Partial<ReportFacts>): Promise<{ path: string } | { error: string } | null> => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const r = await dialog.showSaveDialog(win!, {
    title: 'Save the log', defaultPath: join(app.getPath('documents'), `maskrom-studio-log-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  try {
    writeFileSync(r.filePath, fullLog(reportFacts(f), reporter()));
    return { path: shownPath(r.filePath) };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

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

// Screenshots only (unpackaged builds): the data folder as a neutral profile
// would have it, instead of the path on the machine that takes them.
const SHOWN_DATA_DIR = !app.isPackaged ? process.env.WOA_IMAGER_SHOW_DATA_DIR : undefined;
const shownPath = (p: string) => (SHOWN_DATA_DIR ? p.replace(app.getPath('userData'), SHOWN_DATA_DIR) : p);

ipcMain.handle('cache:info', () => {
  const c = cacheInfo(app.getPath('userData'));
  for (const part of [c.images, c.loaders, c.nvdata]) part.dir = shownPath(part.dir);
  return c;
});
ipcMain.handle('cache:clear', (_e, o: { nvdata: boolean }) => {
  // A running job, or files served to a MaskROM run (the worker reads them
  // while it writes), may be the cached images themselves.
  const r = clearCache(app.getPath('userData'), { nvdata: o?.nvdata === true, busy: job !== null || servedPaths.size > 0 });
  if (r.ok) winpeImg = null;
  return r;
});

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  // Tests and screenshots (unpackaged builds) start in the mode they ask for.
  const forced = !app.isPackaged ? process.env.WOA_IMAGER_UI_MODE : undefined;
  const uiMode = forced === 'simple' || forced === 'advanced' ? forced : s.uiMode;
  return { updateCheck: s.updateCheck, appChannel: s.appChannel, firmwareChannel: s.firmwareChannel, resetAfterMaskrom: s.resetAfterMaskrom, uiMode };
});
ipcMain.handle('settings:set', (_e, patch: { updateCheck?: boolean; appChannel?: unknown; firmwareChannel?: unknown; resetAfterMaskrom?: boolean; uiMode?: unknown }) => {
  const s = loadSettings();
  saveSettings({
    ...s,
    ...(typeof patch.updateCheck === 'boolean' ? { updateCheck: patch.updateCheck } : {}),
    // A new tier for the app: the last check's offer was for the old one.
    ...(isChannel(patch.appChannel) ? { appChannel: patch.appChannel, lastUpdateCheck: 0, knownRelease: null } : {}),
    ...(isChannel(patch.firmwareChannel) ? { firmwareChannel: patch.firmwareChannel } : {}),
    ...(patch.uiMode === 'simple' || patch.uiMode === 'advanced' ? { uiMode: patch.uiMode } : {}),
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
  e.returnValue = {
    // Screenshots only (unpackaged builds): the page as another system shows it (the Windows driver steps).
    platform: (!app.isPackaged && process.env.WOA_IMAGER_SHOW_PLATFORM) || process.platform,
    version: app.getVersion(), dataDir: shownPath(app.getPath('userData')),
    // What the "skip setup" page preselects; tests set their own (unpackaged builds).
    systemLocale: (!app.isPackaged && process.env.WOA_IMAGER_TEST_LOCALE) || app.getSystemLocale(),
    timeZone: (!app.isPackaged && process.env.WOA_IMAGER_TEST_TZ) || Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Screenshots only (unpackaged builds): a worker with a pretend board.
    ...(!app.isPackaged && process.env.WOA_IMAGER_TEST_WORKER ? { testWorker: process.env.WOA_IMAGER_TEST_WORKER } : {}),
  };
});
ipcMain.on('theme', (_e, t: 'light' | 'dark') => { nativeTheme.themeSource = t; });
let busy: { title: string; text: string; stay: string; leave: string } | null = null;
ipcMain.on('app:busy', (_e, ask: typeof busy) => { busy = ask; });

app.whenReady().then(() => {
  afterUpdateCleanup();
  handleProtocol(join(appDir, 'build', 'renderer'), resourcesDir, loaderDir());
  const testVid = !app.isPackaged ? Number(process.env.WOA_IMAGER_USB_TEST_VID ?? NaN) : NaN;
  const vendorIds = Number.isInteger(testVid) ? [ROCKCHIP_VID, testVid] : [ROCKCHIP_VID];
  if (!app.isPackaged && process.env.WOA_IMAGER_TEST_SERVE) serveFileAs('test', process.env.WOA_IMAGER_TEST_SERVE);
  if (!app.isPackaged && process.env.WOA_IMAGER_TEST_SERVE_XZ) serveFileAs('xz', process.env.WOA_IMAGER_TEST_SERVE_XZ);
  installUsbHandlers(session.defaultSession, { origins: [ORIGIN], vendorIds }, askUsb);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
