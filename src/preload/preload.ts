// The page's only way to the main process: window.imager (see shared/ipc.ts).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ImagerApi, JobProgress } from '../shared/ipc';

const info = ipcRenderer.sendSync('app:info') as { platform: string; version: string };

const on = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.off(channel, h); };
};

const api: ImagerApi = {
  ...info,
  releases: (force) => ipcRenderer.invoke('woa:releases', force === true),
  prepareFirmware: (board) => ipcRenderer.invoke('woa:prepare-firmware', board),
  prepareWinpe: () => ipcRenderer.invoke('woa:prepare-winpe'),
  pickWindows: () => ipcRenderer.invoke('woa:pick-windows'),
  // Only the preload script can tell where a dropped file is.
  dropWindows: (file) => ipcRenderer.invoke('woa:drop-windows', webUtils.getPathForFile(file)),
  hashWindows: (token) => ipcRenderer.invoke('woa:hash-windows', token),
  serveWindows: (token) => ipcRenderer.invoke('woa:serve-windows', token),
  boardHere: () => ipcRenderer.invoke('woa:board-here'),
  pickDrivers: () => ipcRenderer.invoke('woa:pick-drivers'),
  prepareExtras: (o) => ipcRenderer.invoke('woa:prepare-extras', o),
  writeBoard: (req) => ipcRenderer.invoke('woa:write-board', req),
  hostBuild: (req) => ipcRenderer.invoke('woa:host-build', req),
  listDrives: (minSize) => ipcRenderer.invoke('drives:list', minSize),
  writeWinpeStick: (device) => ipcRenderer.invoke('woa:write-stick', device),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  onProgress: (cb) => on<JobProgress>('job:progress', cb),
  getLoader: (name) => ipcRenderer.invoke('maskrom:loader', name),
  releaseServed: (token) => ipcRenderer.invoke('woa:release', token),
  onUsbChoice: (cb) => on('usb:choose', cb),
  answerUsbChoice: (id) => ipcRenderer.send('usb:answer', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  checkUpdate: (force) => ipcRenderer.invoke('update:check', force),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  restartApp: () => ipcRenderer.invoke('update:restart'),
  onUpdateStage: (cb) => on<string>('update:stage', cb),
  onUpdateLog: (cb) => on<string>('update:log', cb),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onUpdateProgress: (cb) => on<{ bytes: number; total: number }>('update:progress', cb),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setTheme: (t) => ipcRenderer.send('theme', t),
};

contextBridge.exposeInMainWorld('imager', api);
