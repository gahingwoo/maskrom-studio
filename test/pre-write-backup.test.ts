// What is kept on the computer before a write over MaskROM replaces the
// eMMC's start: the partition table and the UEFI settings slot, found from
// the installed firmware's FIT (pre-write-backup.ts).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECTOR } from '../src/woa/edk2-image';
import { readPreWriteBackup } from '../src/woa/pre-write-backup';
import { edk2Image as image, store } from './edk2-fixture';

const head = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'tspi3m-emmc-head.bin')));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function probe(emmc: Uint8Array, o: { head?: boolean; reads?: Array<[number, number]> } = {}) {
  const disk = new Uint8Array(emmc);
  disk.set(head, 0);
  return {
    capacity: 62008590336, head: o.head === false ? null : head,
    read: async (lba: number, n: number) => { o.reads?.push([lba, n]); return disk.slice(lba * SECTOR, (lba + n) * SECTOR); },
  };
}

describe('the copy taken before a write', () => {
  it('keeps the partition table and the UEFI settings, with their SHA-256, all read below 32 MiB', async () => {
    const nv = store();
    const reads: Array<[number, number]> = [];
    const b = await readPreWriteBackup('tspi3m', probe(image({ nvdata: nv }), { reads }), () => {}, new Date('2026-11-24T08:00:00Z'));
    expect(b).not.toBeNull();
    expect(b!.files.map((f) => f.name)).toEqual(['gpt-sectors-0-33.bin', 'nvdata-sector-43648-384.bin']);
    expect(b!.files[1].data).toEqual(nv);
    expect(b!.settings).toBe('kept');
    expect(b!.notes).toContain('board: tspi3m');
    expect(b!.notes).toContain('taken: 2026-11-24T08:00:00.000Z');
    expect(b!.notes.join('\n')).toContain(`sha256 ${sha(head)}`);
    expect(b!.notes.join('\n')).toContain(`sha256 ${sha(nv)}`);
    expect(b!.notes.join('\n')).toMatch(/firmware 0\.4\.2 \(rk3576-lckfb-tspi-3m\), sectors 43648\.\.44031/);
    expect(reads.every(([lba, n]) => (lba + n) * SECTOR <= 32 * 1024 * 1024)).toBe(true);
  });
  it('reads the table itself when the write did not ask for it', async () => {
    const reads: Array<[number, number]> = [];
    const b = await readPreWriteBackup('cm5io', probe(image({ dt: 'rk3576-armsom-cm5-io', nvdata: store() }), { head: false, reads }), () => {});
    expect(reads[0]).toEqual([0, 34]);
    expect(b!.files[0].data).toEqual(head);
  });
  it('follows the firmware\'s own slot when it is somewhere else', async () => {
    const b = await readPreWriteBackup('tspi3m', probe(image({ nvOffset: 0xc4f000, nvdata: store() })), () => {});
    expect(b!.files[1].name).toBe(`nvdata-sector-${16384 + 8 + 0xc4f000 / SECTOR}-384.bin`);
  });
  it('keeps only the table when the slot is empty or there is no edk2-rk3576 firmware', async () => {
    const log: string[] = [];
    const empty = await readPreWriteBackup('tspi3m', probe(image()), (l) => log.push(l));
    expect(empty!.files.map((f) => f.name)).toEqual(['gpt-sectors-0-33.bin']);
    expect(empty!.settings).toBe('empty');
    const none = await readPreWriteBackup('tspi3m', probe(new Uint8Array(32 * 1024 * 1024)), (l) => log.push(l));
    expect(none!.settings).toBe('none');
    expect(log.join('\n')).toMatch(/No edk2-rk3576 firmware/);
  });
  it('gives nothing when nothing could be read', async () => {
    expect(await readPreWriteBackup('tspi3m', { capacity: null, head: null }, () => {})).toBeNull();
  });
});
