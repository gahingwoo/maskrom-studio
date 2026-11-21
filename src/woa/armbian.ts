// Armbian next to Windows on the eMMC, booted by edk2-rk3576 through GRUB.
// Everything here is pure: what the imager checks in an Armbian image, the
// files it puts into the image's root file system and onto the EFI
// partition, and the debugfs script that puts them there. The Node side
// (src/main/armbian-image.ts) runs e2fsprogs on a copy of the root file
// system; the staged layout (stage-layout.ts) gives it a partition at the
// end of the eMMC. Design and reasons: docs/DESIGN.md, "Armbian next to
// Windows".
//
// What boots, in order:
//   firmware Boot#### "Armbian" -> \EFI\armbian\grubaa64.efi (GRUB_EFI, built
//   by scripts/build-grub.sh; its embedded config is fixed)
//   -> \EFI\armbian\grub.cfg beside it (espGrubCfg: written per install, it
//      knows the root file system's UUID and has a fallback menu)
//   -> /boot/grub/armbian-uefi.cfg on the root file system (rootfsGrubCfg,
//      rewritten by UPDATE_SCRIPT whenever a kernel is installed or removed,
//      so a kernel upgrade with a new version number still boots).
// No devicetree is loaded: the firmware's own is passed to Linux.

import type { BoardId } from './boards';
import { parsePrimaryGpt, SECTOR } from './gpt';

/** GPT type of the Armbian partition: "Linux filesystem". */
export const TYPE_LINUX_FS = '0fc63daf-8483-4772-8e79-3d69d8477de4';
/** Linux root partition types the Armbian images use (arm64 root, generic root) and plain Linux data. */
const LINUX_TYPES = new Set([TYPE_LINUX_FS, 'b921b045-1df0-41c3-af44-4c6f280d3fae', '4f68bce3-e8cd-4db1-96e7-fbcaf984b709']);

/** The GRUB binary in resources/armbian (scripts/build-grub.sh, GRUB 2.12-1ubuntu7.3, GPL-3.0-or-later). */
export const GRUB_EFI = {
  file: 'grubaa64.efi',
  size: 1560576,
  sha256: '56b3a229fcb10fd7a4556a470580f3e9a651b3bb5f56784db647a3d9c5ac6572',
  version: '2.12-1ubuntu7.3',
};

export const GIB = 1024 ** 3;

export interface ArmbianBoard {
  /** BOARD= in /etc/armbian-release. */
  armbian: string;
  /** systemd units that must not run under UEFI (masked by a /dev/null link and on the kernel command line). */
  mask: string[];
  /** Extra files for the root file system. */
  files: Array<{ path: string; content: string }>;
  /** Shown on the page: what is known about this board under UEFI. */
  tested: boolean;
}

// Under UEFI the kernel names the sound cards after the SMBIOS product
// ("LCKFB-TaishanPi3M-0"), the ES8388 and the HDMI card alike, so ALSA's
// UCM finds no profile by name. This one sends the card whose id is the
// ES8388's on to the profile Armbian ships. Verified on the board
// 2026-11-21; desktop audio was still silent afterwards.
const TSPI3M_UCM = `Syntax 6
If.es8388 {
  Condition { Type String Haystack "\${CardId}" Needle "rockchipes8388" }
  True.Include.es8388.File "/conf.d/simple-card/rockchip-es8388.conf"
}
`;

export const ARMBIAN_BOARDS: Partial<Record<BoardId, ArmbianBoard>> = {
  tspi3m: {
    armbian: 'lckfb-taishanpi-3m',
    // Under U-Boot it writes a device tree overlay into armbianEnv.txt and
    // reboots; under UEFI nothing reads that file, so it reboots forever.
    mask: ['lckfb-tspi-3m-screen.service'],
    files: [{ path: '/usr/share/alsa/ucm2/conf.d/simple-card/LCKFB-TaishanPi3M-0.conf', content: TSPI3M_UCM }],
    tested: true,
  },
  cm5io: { armbian: 'armsom-cm5-io', mask: [], files: [], tested: false },
};

export class ArmbianError extends Error {}

/** KEY=value lines (/etc/armbian-release, os-release), quotes taken off. */
export function parseReleaseFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Why this /etc/armbian-release is not an arm64 Armbian for the board, or null. */
export function armbianReleaseProblem(rel: Record<string, string>, boardId: BoardId): string | null {
  const b = ARMBIAN_BOARDS[boardId];
  if (!b) return 'Armbian next to Windows is not offered for this board.';
  if (!rel.BOARD) return 'The image has no /etc/armbian-release with a BOARD line: it is not an Armbian image.';
  if (rel.BOARD !== b.armbian) return `This Armbian image is for the board "${rel.BOARD}", not "${b.armbian}". Nothing was changed.`;
  if (rel.ARCH && rel.ARCH !== 'arm64') return `This Armbian image is for ${rel.ARCH}, not arm64.`;
  if (rel.BOOT_SOC && rel.BOOT_SOC !== 'rk3576') return `This Armbian image is for the ${rel.BOOT_SOC}, not the RK3576.`;
  return null;
}

/** Where the root file system is in an Armbian image: its one Linux partition. */
export function rootfsPartition(head: Uint8Array, imageBytes: number): { offset: number; bytes: number } {
  let parts: Array<{ first: number; sectors: number; linux: boolean }> = [];
  try {
    const t = parsePrimaryGpt(head);
    parts = t.partitions.map((p) => ({ first: p.firstLba, sectors: p.lastLba - p.firstLba + 1, linux: LINUX_TYPES.has(p.type) }));
  } catch {
    // An MBR image: four primary records, type 0x83 is Linux.
    if (head[510] !== 0x55 || head[511] !== 0xaa) throw new ArmbianError('The image has neither a GUID nor an MBR partition table. Is it an Armbian .img or .img.xz?');
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    for (let i = 0; i < 4; i++) {
      const o = 446 + i * 16;
      const type = head[o + 4];
      const first = dv.getUint32(o + 8, true);
      const sectors = dv.getUint32(o + 12, true);
      if (type === 0xee) throw new ArmbianError('The partition table is damaged (a protective MBR without a GPT).');
      if (type && sectors) parts.push({ first, sectors, linux: type === 0x83 });
    }
  }
  if (parts.length !== 1 || !parts[0].linux) {
    throw new ArmbianError(`The image has ${parts.length} partitions; the imager takes Armbian images with one Linux root partition and no separate boot partition.`);
  }
  const p = parts[0];
  const offset = p.first * SECTOR;
  const bytes = p.sectors * SECTOR;
  if (offset + bytes > imageBytes) throw new ArmbianError('The image is shorter than its partition table says. Is the download complete?');
  return { offset, bytes };
}

/** The Armbian partition's size: the root file system's, rounded up to whole GiB. */
export function defaultPartitionBytes(rootfsBytes: number): number {
  return Math.ceil(rootfsBytes / GIB) * GIB;
}

/** Kernel versions in /boot (vmlinuz-<version>), newest first, as `sort -V -r` orders them. */
export function sortKernels(versions: string[]): string[] {
  const parts = (s: string) => s.split(/(\d+)/).filter((x) => x !== '');
  const cmp = (a: string, b: string) => {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
      if (nx && ny) return Number(x[i]) - Number(y[i]) || x[i].length - y[i].length;
      return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  };
  return [...new Set(versions)].sort((a, b) => cmp(b, a));
}

// --- the boot configuration ----------------------------------------------------

export interface BootOptions {
  boardId: BoardId;
  /** The root file system's UUID after the imager gave it a new one. */
  uuid: string;
  /** Which system starts when nobody picks one. */
  defaultOs: 'armbian' | 'windows';
  timeout: number;
}

/** Everything after root=UUID=... on the kernel command line. */
export function kernelArgs(boardId: BoardId): string {
  const mask = (ARMBIAN_BOARDS[boardId]?.mask ?? []).map((u) => ` systemd.mask=${u}`).join('');
  return `rootwait rw console=ttyS0,1500000 console=tty1 loglevel=4${mask}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkBoot(o: BootOptions) {
  if (!UUID_RE.test(o.uuid)) throw new ArmbianError(`not a file system UUID: ${o.uuid}`);
  if (!Number.isInteger(o.timeout) || o.timeout < 0 || o.timeout > 60) throw new ArmbianError('the menu timeout must be 0 to 60 seconds');
}

// The Windows entry finds the EFI partition by the boot manager's file, as
// bcdboot left it; the firmware's own menu is the way back otherwise.
const WINDOWS_ENTRY = [
  "menuentry 'Windows' --id windows {",
  '  insmod fat',
  '  insmod chain',
  '  search --no-floppy --file --set=esp /EFI/Microsoft/Boot/bootmgfw.efi',
  '  chainloader ($esp)/EFI/Microsoft/Boot/bootmgfw.efi',
  '}',
  '',
  "menuentry 'UEFI firmware settings' --id fwsetup {",
  '  fwsetup',
  '}',
];

/**
 * \EFI\armbian\grub.cfg on the EFI partition. The one per-install piece of
 * the boot chain: it finds the root file system by its UUID and hands over
 * to the menu kept there; when that file is missing, its own entries boot
 * the kernel and initramfs that Debian's /vmlinuz and /initrd.img links
 * point to, which every kernel package updates.
 */
export function espGrubCfg(o: BootOptions & { appVersion: string }): string {
  checkBoot(o);
  const args = kernelArgs(o.boardId);
  return [
    `# Written by WoA RK3576 Imager ${o.appVersion} for the Armbian on this eMMC.`,
    '# grubaa64.efi beside it reads this file. The menu itself is on the root',
    '# file system, in /boot/grub/armbian-uefi.cfg, rewritten by',
    '# armbian-uefi-grub-update whenever a kernel is installed or removed.',
    'insmod part_gpt',
    'insmod ext2',
    `set armbian_uuid=${o.uuid}`,
    'search --no-floppy --fs-uuid --set=root $armbian_uuid',
    'if [ -f /boot/grub/armbian-uefi.cfg ]; then',
    '  configfile /boot/grub/armbian-uefi.cfg',
    'fi',
    '',
    '# The menu on the root file system is missing: the kernel the /vmlinuz link names.',
    `set timeout=${o.timeout}`,
    `set default=${o.defaultOs === 'windows' ? 'windows' : '0'}`,
    '',
    "menuentry 'Armbian' {",
    `  linux /vmlinuz root=UUID=$armbian_uuid ${args}`,
    '  initrd /initrd.img',
    '}',
    '',
    "menuentry 'Armbian, previous kernel' {",
    `  linux /vmlinuz.old root=UUID=$armbian_uuid ${args}`,
    '  initrd /initrd.img.old',
    '}',
    '',
    ...WINDOWS_ENTRY,
    '',
  ].join('\n');
}

/** /etc/default/armbian-uefi: what armbian-uefi-grub-update writes the menu from. */
export function defaultsFile(o: BootOptions): string {
  checkBoot(o);
  return [
    '# Read by armbian-uefi-grub-update, which writes /boot/grub/armbian-uefi.cfg,',
    '# the GRUB menu grubaa64.efi on the EFI partition shows. Run it after a change.',
    '# Written by WoA RK3576 Imager.',
    `ARMBIAN_UEFI_CMDLINE="${kernelArgs(o.boardId)}"`,
    '# armbian or windows',
    `ARMBIAN_UEFI_DEFAULT=${o.defaultOs}`,
    `ARMBIAN_UEFI_TIMEOUT=${o.timeout}`,
    '',
  ].join('\n');
}

/**
 * /boot/grub/armbian-uefi.cfg exactly as UPDATE_SCRIPT writes it (a test
 * runs the script and compares), so the first start has the same menu as
 * every start after a kernel upgrade.
 */
export function rootfsGrubCfg(o: { uuid: string; cmdline: string; defaultOs: 'armbian' | 'windows'; timeout: number; kernels: string[] }): string {
  const lines = [
    '# Written by armbian-uefi-grub-update. Do not edit: change /etc/default/armbian-uefi',
    '# and run armbian-uefi-grub-update.',
    'insmod part_gpt',
    'insmod ext2',
    `search --no-floppy --fs-uuid --set=root ${o.uuid}`,
    `set timeout=${o.timeout}`,
    `set default=${o.defaultOs === 'windows' ? 'windows' : '0'}`,
  ];
  for (const v of sortKernels(o.kernels)) {
    lines.push('', `menuentry 'Armbian, Linux ${v}' {`, `  linux /boot/vmlinuz-${v} root=UUID=${o.uuid} ${o.cmdline}`, `  initrd /boot/initrd.img-${v}`, '}');
  }
  lines.push('', "menuentry 'Armbian, the kernel /vmlinuz names' {", `  linux /vmlinuz root=UUID=${o.uuid} ${o.cmdline}`, '  initrd /initrd.img', '}', '', ...WINDOWS_ENTRY, '');
  return lines.join('\n');
}

/**
 * /usr/sbin/armbian-uefi-grub-update. Run by the hooks below after a kernel
 * package is installed or removed and after an initramfs is made (Debian
 * may make it later than the kernel's own hooks run, through a trigger).
 * ARMBIAN_UEFI_ROOT and ARMBIAN_UEFI_UUID are for the tests.
 */
export const UPDATE_SCRIPT = `#!/bin/sh
# Writes /boot/grub/armbian-uefi.cfg, the GRUB menu that \\EFI\\armbian\\grubaa64.efi
# on the EFI partition shows: one entry per kernel in /boot, newest first, so a
# kernel upgrade that changes the version number still boots. Installed by
# WoA RK3576 Imager; settings in /etc/default/armbian-uefi.
set -e
ROOT="\${ARMBIAN_UEFI_ROOT:-}"
OUT="$ROOT/boot/grub/armbian-uefi.cfg"
ARMBIAN_UEFI_CMDLINE="rootwait rw"
ARMBIAN_UEFI_DEFAULT=armbian
ARMBIAN_UEFI_TIMEOUT=5
if [ -r "$ROOT/etc/default/armbian-uefi" ]; then . "$ROOT/etc/default/armbian-uefi"; fi
uuid="\${ARMBIAN_UEFI_UUID:-$(findmnt -n -o UUID / 2>/dev/null || true)}"
if [ -z "$uuid" ]; then
  echo "armbian-uefi-grub-update: the root file system has no UUID; $OUT is unchanged" >&2
  exit 0
fi
kernels=$(cd "$ROOT/boot" && for f in vmlinuz-*; do [ -f "$f" ] && echo "\${f#vmlinuz-}"; done | sort -V -r -u)
if [ "$ARMBIAN_UEFI_DEFAULT" = windows ]; then default=windows; else default=0; fi
mkdir -p "$ROOT/boot/grub"
{
  echo "# Written by armbian-uefi-grub-update. Do not edit: change /etc/default/armbian-uefi"
  echo "# and run armbian-uefi-grub-update."
  echo "insmod part_gpt"
  echo "insmod ext2"
  echo "search --no-floppy --fs-uuid --set=root $uuid"
  echo "set timeout=$ARMBIAN_UEFI_TIMEOUT"
  echo "set default=$default"
  for v in $kernels; do
    echo ""
    echo "menuentry 'Armbian, Linux $v' {"
    echo "  linux /boot/vmlinuz-$v root=UUID=$uuid $ARMBIAN_UEFI_CMDLINE"
    echo "  initrd /boot/initrd.img-$v"
    echo "}"
  done
  echo ""
  echo "menuentry 'Armbian, the kernel /vmlinuz names' {"
  echo "  linux /vmlinuz root=UUID=$uuid $ARMBIAN_UEFI_CMDLINE"
  echo "  initrd /initrd.img"
  echo "}"
  echo ""
  echo "menuentry 'Windows' --id windows {"
  echo "  insmod fat"
  echo "  insmod chain"
  echo "  search --no-floppy --file --set=esp /EFI/Microsoft/Boot/bootmgfw.efi"
  echo '  chainloader ($esp)/EFI/Microsoft/Boot/bootmgfw.efi'
  echo "}"
  echo ""
  echo "menuentry 'UEFI firmware settings' --id fwsetup {"
  echo "  fwsetup"
  echo "}"
} > "$OUT.new"
mv "$OUT.new" "$OUT"
`;

/** The same tiny hook in /etc/kernel/postinst.d, /etc/kernel/postrm.d and /etc/initramfs/post-update.d. */
export const HOOK_SCRIPT = `#!/bin/sh
# WoA RK3576 Imager: keep the UEFI GRUB menu in step with the kernels in /boot.
exec /usr/sbin/armbian-uefi-grub-update
`;

export const FIRSTBOOT_SCRIPT = `#!/bin/sh
# WoA RK3576 Imager, once on the first start of Armbian under UEFI: grow the
# root file system to its partition (Armbian's own resize is switched off by
# /root/.no_rootfs_resize, see docs/DESIGN.md), and write the GRUB menu from
# the running system.
dev=$(findmnt -n -o SOURCE /)
resize2fs "$dev" || echo "armbian-uefi-firstboot: resize2fs $dev failed" >&2
/usr/sbin/armbian-uefi-grub-update || true
rm -f /var/lib/armbian-uefi/firstboot
`;

export const FIRSTBOOT_UNIT = `[Unit]
Description=Armbian under UEFI: grow the root file system, write the GRUB menu (WoA RK3576 Imager)
ConditionPathExists=/var/lib/armbian-uefi/firstboot
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/armbian-uefi-firstboot

[Install]
WantedBy=multi-user.target
`;

/**
 * startup.nsh at the root of the EFI partition. The UEFI Shell runs it on
 * its own (F1 in the firmware's countdown starts the Shell). It adds the
 * "Armbian" boot option once, renames itself so it does not run again, and
 * starts GRUB. A boot option written by an operating system does not stay
 * with the current firmware, but one written by the Shell does.
 */
export function startupNsh(defaultOs: 'armbian' | 'windows'): string {
  // bcfg puts the option at that position in BootOrder; past the end it goes last.
  const pos = defaultOs === 'armbian' ? 0 : 99;
  const fs = Array.from({ length: 10 }, (_, i) => `fs${i}`).join(' ');
  return [
    '@echo -off',
    '# WoA RK3576 Imager: add the boot option "Armbian" for \\EFI\\armbian\\grubaa64.efi,',
    '# once. Afterwards this file is \\EFI\\armbian\\startup.nsh.done.',
    `for %a in ${fs}`,
    '  if exist %a:\\startup.nsh then',
    '    if exist %a:\\EFI\\armbian\\grubaa64.efi then',
    `      bcfg boot add ${pos} %a:\\EFI\\armbian\\grubaa64.efi "Armbian"`,
    '      mv %a:\\startup.nsh %a:\\EFI\\armbian\\startup.nsh.done',
    '      echo "Boot option Armbian added. Starting it."',
    '      %a:\\EFI\\armbian\\grubaa64.efi',
    '      goto done',
    '    endif',
    '  endif',
    'endfor',
    'echo "No \\EFI\\armbian\\grubaa64.efi next to startup.nsh."',
    ':done',
    '',
  ].join('\r\n');
}

/**
 * The files for the EFI partition, as staging-volume paths: woa-stage.cmd
 * copies "armbian-esp\" onto the new EFI partition after bcdboot.
 */
export function espFiles(grubEfi: Uint8Array, o: BootOptions & { appVersion: string }): Array<{ path: string; data: Uint8Array }> {
  if (grubEfi.length !== GRUB_EFI.size) throw new ArmbianError(`${GRUB_EFI.file} is not the one this version was built with.`);
  const enc = new TextEncoder();
  return [
    { path: 'armbian-esp/EFI/armbian/grubaa64.efi', data: grubEfi },
    { path: 'armbian-esp/EFI/armbian/grub.cfg', data: enc.encode(espGrubCfg(o)) },
    { path: 'armbian-esp/startup.nsh', data: enc.encode(startupNsh(o.defaultOs)) },
  ];
}

// --- first-start presets -------------------------------------------------------

export interface ArmbianAccount {
  /** The Linux user (lower case). */
  user: string;
  /** Shown as the user's full name; the Windows user name. */
  realName: string;
  /** For the user and for root. */
  password: string;
  /** en_US.UTF-8 */
  locale: string;
  /** IANA, such as Asia/Shanghai */
  timeZone: string;
}

export function linuxUserProblem(u: string): string | null {
  if (!u) return 'armbian.user.empty';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) return 'armbian.user.bad';
  if (/^(root|daemon|bin|sys|sync|games|man|lp|mail|news|uucp|proxy|www-data|backup|list|irc|nobody|systemd-.*|messagebus|sshd)$/.test(u)) return 'armbian.user.reserved';
  return null;
}

/** A Windows user name made into a Linux one: lower case, only what useradd takes. */
export function linuxUserFrom(windowsUser: string): string {
  const s = windowsUser.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return /^[a-z_]/.test(s) ? s.slice(0, 32) : `u${s}`.slice(0, 32);
}

/** A language tag (zh-CN) as a glibc locale (zh_CN.UTF-8). */
export function localeFrom(tag: string): string {
  const m = /^([a-z]{2,3})(?:-[A-Za-z]{4})?(?:-([A-Z]{2}))?$/.exec(tag.trim());
  if (!m) return 'en_US.UTF-8';
  const region = m[2] ?? ({ en: 'US', zh: 'CN', de: 'DE', fr: 'FR', ja: 'JP', ko: 'KR', es: 'ES', it: 'IT', pt: 'BR', ru: 'RU' } as Record<string, string>)[m[1]];
  return region ? `${m[1]}_${region}.UTF-8` : 'en_US.UTF-8';
}

export function timeZoneProblem(tz: string): string | null {
  if (!tz) return null;
  return /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? null : 'armbian.tz.bad';
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * /root/.not_logged_in_yet with Armbian's presets: armbian-firstlogin sources
 * it (bash) on the first start and deletes it when the accounts are made.
 */
export function presetFile(a: ArmbianAccount): string {
  if (linuxUserProblem(a.user)) throw new ArmbianError(`not a Linux user name: ${a.user}`);
  if (!a.password || /[\r\n\0]/.test(a.password)) throw new ArmbianError('the password cannot be used');
  if (/[\r\n\0]/.test(a.realName)) throw new ArmbianError('the name cannot be used');
  if (!/^[A-Za-z0-9_.@-]+$/.test(a.locale)) throw new ArmbianError(`not a locale: ${a.locale}`);
  if (timeZoneProblem(a.timeZone)) throw new ArmbianError(`not a time zone: ${a.timeZone}`);
  return [
    '# Written by WoA RK3576 Imager. armbian-firstlogin reads these on the first',
    '# start, makes the accounts and deletes this file.',
    `PRESET_ROOT_PASSWORD=${sq(a.password)}`,
    `PRESET_USER_NAME=${sq(a.user)}`,
    `PRESET_USER_PASSWORD=${sq(a.password)}`,
    `PRESET_DEFAULT_REALNAME=${sq(a.realName || a.user)}`,
    `PRESET_USER_SHELL=${sq('bash')}`,
    `PRESET_LOCALE=${sq(a.locale)}`,
    ...(a.timeZone ? [`PRESET_TIMEZONE=${sq(a.timeZone)}`] : []),
    'SET_LANG_BASED_ON_LOCATION="n"',
    'PRESET_NET_CHANGE_DEFAULTS="0"',
    '',
  ].join('\n');
}

// --- what goes into the root file system ------------------------------------------

/** One change to the root file system, as debugfs makes it. */
export type FsOp =
  | { op: 'mkdir'; path: string; mode: number }
  | { op: 'write'; path: string; content: string; mode: number; uid?: number; gid?: number; secret?: boolean }
  | { op: 'symlink'; path: string; target: string };

export interface RootfsFacts {
  /** The file system UUID now (from the image). */
  uuid: string;
  /** /etc/fstab and /boot/armbianEnv.txt as they are, with their mode and owner. */
  fstab: { content: string; mode: number; uid: number; gid: number } | null;
  armbianEnv: { content: string; mode: number; uid: number; gid: number } | null;
  /** Kernel versions in /boot. */
  kernels: string[];
  /** Directories that exist already (of the ones the edits need). */
  dirs: string[];
}

export interface EditInput extends BootOptions {
  facts: RootfsFacts;
  /** null: Armbian asks on the first start, as it does from an SD card. */
  account: ArmbianAccount | null;
  /** One OpenSSH public key line for root, or empty. */
  sshKey: string;
}

/** Every change the imager makes to the Armbian root file system, in order. */
export function rootfsEdits(o: EditInput): FsOp[] {
  checkBoot(o);
  const board = ARMBIAN_BOARDS[o.boardId];
  if (!board) throw new ArmbianError('Armbian next to Windows is not offered for this board.');
  if (o.facts.kernels.length === 0) throw new ArmbianError('The image has no kernel in /boot (vmlinuz-<version>).');
  const ops: FsOp[] = [];
  const have = new Set(o.facts.dirs);
  const mkdirs = (path: string, mode = 0o755) => {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`;
      if (!have.has(p)) { ops.push({ op: 'mkdir', path: p, mode: i === parts.length ? mode : 0o755 }); have.add(p); }
    }
  };
  const write = (path: string, content: string, mode = 0o644, extra: Partial<Extract<FsOp, { op: 'write' }>> = {}) => {
    mkdirs(path.slice(0, path.lastIndexOf('/')) || '/');
    ops.push({ op: 'write', path, content, mode, ...extra });
  };
  const reid = (s: string) => s.split(o.facts.uuid).join(o.uuid);

  // The new file system UUID wherever the old one is named.
  if (o.facts.fstab) write('/etc/fstab', reid(o.facts.fstab.content), o.facts.fstab.mode, { uid: o.facts.fstab.uid, gid: o.facts.fstab.gid });
  if (o.facts.armbianEnv) write('/boot/armbianEnv.txt', reid(o.facts.armbianEnv.content), o.facts.armbianEnv.mode, { uid: o.facts.armbianEnv.uid, gid: o.facts.armbianEnv.gid });

  // The GRUB menu and what keeps it current.
  write('/etc/default/armbian-uefi', defaultsFile(o));
  write('/usr/sbin/armbian-uefi-grub-update', UPDATE_SCRIPT, 0o755);
  for (const d of ['/etc/kernel/postinst.d', '/etc/kernel/postrm.d', '/etc/initramfs/post-update.d']) {
    write(`${d}/zz-armbian-uefi-grub`, HOOK_SCRIPT, 0o755);
  }
  write('/boot/grub/armbian-uefi.cfg', rootfsGrubCfg({ uuid: o.uuid, cmdline: kernelArgs(o.boardId), defaultOs: o.defaultOs, timeout: o.timeout, kernels: o.facts.kernels }));

  // First start: grow the file system (Armbian's own resize rewrites the
  // partition with MBR-style fdisk input; it must not touch this GPT).
  write('/root/.no_rootfs_resize', '', 0o644);
  write('/usr/sbin/armbian-uefi-firstboot', FIRSTBOOT_SCRIPT, 0o755);
  write('/etc/systemd/system/armbian-uefi-firstboot.service', FIRSTBOOT_UNIT);
  mkdirs('/etc/systemd/system/multi-user.target.wants');
  ops.push({ op: 'symlink', path: '/etc/systemd/system/multi-user.target.wants/armbian-uefi-firstboot.service', target: '/etc/systemd/system/armbian-uefi-firstboot.service' });
  write('/var/lib/armbian-uefi/firstboot', '');

  // The board's fixes.
  for (const u of board.mask) ops.push({ op: 'symlink', path: `/etc/systemd/system/${u}`, target: '/dev/null' });
  for (const f of board.files) write(f.path, f.content);

  // Accounts and SSH.
  if (o.account) write('/root/.not_logged_in_yet', presetFile(o.account), 0o600, { secret: true });
  const key = o.sshKey.trim();
  if (key) {
    if (/[\r\n]/.test(key)) throw new ArmbianError('the SSH key must be one line');
    mkdirs('/root/.ssh', 0o700);
    write('/root/.ssh/authorized_keys', `${key}\n`, 0o600);
  }
  return ops;
}

/** Paths an edit replaces (removed first: debugfs does not overwrite). */
export function replacedPaths(ops: FsOp[]): string[] {
  return ops.filter((x) => x.op === 'write' || x.op === 'symlink').map((x) => x.path);
}

const safePath = (p: string) => {
  if (!/^\/[A-Za-z0-9._+@/,-]+$/.test(p) || p.split('/').some((s) => s === '..')) throw new ArmbianError(`a path debugfs cannot take: ${p}`);
  return p;
};
const oct = (m: number) => `0${m.toString(8)}`;

/**
 * The debugfs -w -f script for `ops`. File contents go through host files
 * (hostFile(i) names the one for ops[i]); the script itself never holds
 * them, so a password is never in a command line or a log. Files and links
 * that are already there are removed first (debugfs refuses to overwrite;
 * `rm` of a missing one only prints an error, which the caller ignores).
 */
export function debugfsScript(ops: FsOp[], hostFile: (i: number) => string): string {
  const out: string[] = [];
  ops.forEach((x, i) => {
    const p = safePath(x.path);
    if (x.op === 'mkdir') {
      out.push(`mkdir ${p}`, `sif ${p} mode ${oct(0o040000 | x.mode)}`, `sif ${p} uid 0`, `sif ${p} gid 0`);
    } else if (x.op === 'write') {
      const h = hostFile(i);
      if (/[\s"']/.test(h)) throw new ArmbianError(`a temporary path debugfs cannot take: ${h}`);
      out.push(`rm ${p}`, `write ${h} ${p}`, `sif ${p} mode ${oct(0o100000 | x.mode)}`, `sif ${p} uid ${x.uid ?? 0}`, `sif ${p} gid ${x.gid ?? 0}`);
    } else {
      // Short enough to be a "fast" link, which applyEdits() reads back.
      if (!/^\/[A-Za-z0-9._+@/,-]+$/.test(x.target) || x.target.length > 59) throw new ArmbianError(`a link target debugfs cannot take: ${x.target}`);
      out.push(`rm ${p}`, `symlink ${p} ${x.target}`);
    }
  });
  return `${out.join('\n')}\n`;
}

/** The ext4 superblock: magic, UUID and size, from the first 2 KiB of the file system. */
export function ext4Superblock(b: Uint8Array): { uuid: string; bytes: number; label: string; clean: boolean } {
  if (b.length < 2048) throw new ArmbianError('the root partition is too short to hold a file system');
  const sb = b.subarray(1024, 2048);
  const dv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  if (dv.getUint16(56, true) !== 0xef53) throw new ArmbianError('The root partition does not hold an ext4 file system.');
  const blockSize = 1024 << dv.getUint32(24, true);
  const incompat = dv.getUint32(96, true);
  const blocks = dv.getUint32(4, true) + ((incompat & 0x80) ? dv.getUint32(0x150, true) * 2 ** 32 : 0);
  const u = sb.subarray(104, 120);
  const h = Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('');
  const label = new TextDecoder().decode(sb.subarray(120, 136)).replace(/\0.*$/s, '');
  return {
    uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    bytes: blocks * blockSize, label,
    clean: (dv.getUint16(58, true) & 1) === 1 && !(incompat & 0x4),
  };
}

