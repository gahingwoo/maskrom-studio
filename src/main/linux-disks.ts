// What lsblk and sysfs tell about the disks on Linux (shared/targets.ts,
// linuxDiskFacts). No Electron here: the app and the elevated writer
// (helper/write-helper.ts) both use it, the writer for its own check just
// before it writes.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  LINUX_LSBLK_ARGS, linuxDiskFacts, withLinuxFacts, type DriveInfo, type LinuxDiskFacts, type LsblkNode,
} from '../shared/targets';

/**
 * The facts per disk, or none at all when lsblk fails: also when it is
 * older than util-linux 2.37 and does not know the MOUNTPOINTS column
 * (LINUX_LSBLK_ARGS). Without facts a built-in disk stays what drivelist
 * says: a system disk, never offered.
 */
export async function readLinuxDiskFacts(): Promise<Record<string, LinuxDiskFacts>> {
  if (process.platform !== 'linux') return {};
  try {
    const { stdout } = await promisify(execFile)('lsblk', LINUX_LSBLK_ARGS, { timeout: 10000 });
    const tree = JSON.parse(stdout) as { blockdevices?: LsblkNode[] };
    const mmcTypes: Record<string, string> = {};
    for (const d of tree.blockdevices ?? []) {
      const m = /^\/dev\/(mmcblk\d+)$/.exec(d.name);
      if (!m) continue;
      try { mmcTypes[d.name] = await readFile(`/sys/block/${m[1]}/device/type`, 'utf8'); } catch { /* unknown kind: 'disk' */ }
    }
    return linuxDiskFacts(tree, mmcTypes);
  } catch {
    return {};
  }
}

/** drivelist's drives, with the Linux facts where lsblk has them. */
export async function withDiskFacts<T extends DriveInfo>(drives: T[]): Promise<T[]> {
  return withLinuxFacts(drives, await readLinuxDiskFacts()) as T[];
}
