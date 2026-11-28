// The files of a Windows host build (stage-scripts.ts HOST_BUILD): the
// script, its settings, the RK3576 drivers taken out of the WinPE release's
// volume, and the same generated files as the staged install (certificates,
// SetupComplete.cmd, the answer file, OpenSSH, extra drivers). The main
// process writes them into a folder of its own and runs the script elevated.

import { certsCmd, trustedCerts } from './certs';
import { FatVolume } from './fat32';
import { versionIni } from '../shared/windows-version';
import type { ByteSource } from './pieces';
import { AUTOLOGON_FILE, autoLogonScript, setupComplete, unattendXml, type SetupOptions } from './setup-files';
import { stageIni, StageError, winpeVolume, type DiskTarget } from './stage-layout';
import { crlf, HOST_BUILD } from './stage-scripts';
import { anyTrim, trimCmd } from './trim';
import { SELFTEST_FILE, selfTestScript } from './selftest';
import { desktopScripts } from './desktop-tools';
import { BROWSER_GPU_FILE, browserGpuScript } from './browser-gpu';
import { CHARSIU_SETUP_PATH, charsiuGenerated } from './charsiu-desktop';

export interface HostBuildInput {
  target: DiskTarget;
  mode: 'disk' | 'vhd';
  /** disk: the PC's disk number (\\.\PhysicalDriveN) and its size in bytes. */
  diskNumber?: number;
  diskBytes?: number;
  /** vhd: where to make it and how big (the board's eMMC). */
  vhdPath?: string;
  vhdBytes?: number;
  /** The Windows image as the user chose it: an ISO (install.wim inside) or a WIM/ESD file. */
  source: { path: string; kind: 'iso' | 'wim'; inner: string };
  index: number;
  edition: string;
  build: number;
  winpe: ByteSource;
  setup: SetupOptions;
  extras: Array<{ path: string; data: Uint8Array }>;
  appVersion: string;
}

export function hostBuildFiles(o: HostBuildInput): Array<{ path: string; data: Uint8Array }> {
  const fat = new FatVolume(winpeVolume(o.winpe));
  const drivers = fat.listFiles('woa-drivers');
  if (!drivers.some((p) => /dwcsdhc\.inf$/i.test(p))) throw new StageError('The WinPE image has no woa-drivers\\dwcsdhc. Use woa-rk3576 release 0.1.1 or later.');
  // woa-audio: the WinPE image's audio drivers, added when the release has no driver package.
  const out: Array<{ path: string; data: Uint8Array }> = [...drivers, ...fat.listFiles('woa-audio')].map((p) => ({ path: p, data: fat.readFile(p) }));
  const catalogs = [
    ...out.filter((f) => /\.cat$/i.test(f.path)).map((f) => f.data),
    ...o.extras.filter((e) => /^(extra-drivers|rk3576-drivers)\/.*\.cat$/i.test(e.path)).map((e) => e.data),
  ];
  const certs = trustedCerts(catalogs);
  if (o.setup.charsiuDesktop && !o.extras.some((e) => e.path === CHARSIU_SETUP_PATH)) throw new StageError('Charsiu Desktop is chosen, but its installer is missing.');
  const ini: Record<string, string | number> = {
    tool: `Maskrom Studio ${o.appVersion}`,
    mode: o.mode,
    target: o.target,
    source: o.source.path,
    source_kind: o.source.kind,
    inner: o.source.inner,
    index: o.index,
    edition: o.edition.replace(/[^\x20-\x7e]/g, '?'),
    build: o.build,
    ...versionIni(o.build),
  };
  if (o.mode === 'disk') {
    if (o.diskNumber === undefined || !o.diskBytes) throw new StageError('No disk was chosen.');
    ini.disk_number = o.diskNumber;
    ini.disk_bytes = o.diskBytes;
  } else {
    if (!o.vhdPath || !o.vhdBytes) throw new StageError('No virtual disk path.');
    ini.vhd_path = o.vhdPath;
    ini.vhd_mb = Math.floor(o.vhdBytes / (1024 * 1024));
  }
  out.push(
    { path: 'host-build.cmd', data: crlf(HOST_BUILD) },
    { path: 'host-build.ini', data: new TextEncoder().encode(stageIni(ini)) },
    { path: 'SetupComplete.cmd', data: crlf(setupComplete(o.setup)) },
    { path: SELFTEST_FILE, data: crlf(selfTestScript({ appVersion: o.appVersion })) },
    ...desktopScripts().map((f) => ({ path: f.name, data: crlf(f.text) })),
    ...(o.setup.browserGpu !== false ? [{ path: BROWSER_GPU_FILE, data: crlf(browserGpuScript()) }] : []),
    ...(o.setup.charsiuDesktop ? charsiuGenerated(o.extras).map((f) => ({ path: f.name, data: crlf(f.text) })) : []),
    ...(certs.length ? [{ path: 'woa-certs.cmd', data: crlf(certsCmd(certs)) }] : []),
    ...(o.setup.skipSetup ? [{ path: 'unattend.xml', data: crlf(unattendXml(o.setup.skipSetup)) }] : []),
    ...(o.setup.skipSetup?.autoLogonAlways ? [{ path: AUTOLOGON_FILE, data: crlf(autoLogonScript(o.setup.skipSetup)) }] : []),
    ...(anyTrim(o.setup.trim) ? [{ path: 'woa-trim.cmd', data: crlf(trimCmd(o.setup.trim!)) }] : []),
    ...(o.setup.ssh && o.setup.sshKey.trim() ? [{ path: 'ssh-key/administrators_authorized_keys', data: crlf(`${o.setup.sshKey.trim()}\n`) }] : []),
    ...o.extras.filter((e) => o.setup.ssh || !e.path.startsWith('openssh/')),
  );
  return out;
}
