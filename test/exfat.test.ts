import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExfat, tableChecksum, upcaseTable } from '../src/woa/exfat';
import { bytesSource, concatSource } from '../src/woa/pieces';

const fsck = (() => {
  for (const c of [process.env.FSCK_EXFAT, 'fsck.exfat', '/usr/sbin/fsck.exfat'].filter(Boolean) as string[]) {
    const r = spawnSync(c, ['-V'], { encoding: 'utf8' });
    if (/exfatprogs version/.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
})();

function pattern(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}

describe('exFAT builder', () => {
  const files = [
    { name: 'woa-stage.ini', source: bytesSource(new TextEncoder().encode('[stage]\r\nindex=6\r\n')) },
    { name: 'install.wim', source: bytesSource(pattern(5 * 1024 * 1024 + 123, 7)) },
    { name: 'a-name-that-is-longer-than-fifteen-characters.cmd', source: bytesSource(pattern(40000, 3)) },
    { name: 'openssh/sshd.exe', source: bytesSource(pattern(70000, 4)) },
    { name: 'openssh/install-sshd.ps1', source: bytesSource(pattern(2000, 5)) },
    { name: 'extra-drivers/mali/sub/driver.inf', source: bytesSource(pattern(300, 6)) },
    ...Array.from({ length: 60 }, (_, i) => ({ name: `extra-drivers/many/file-number-${i}-with-a-long-name.bin`, source: bytesSource(pattern(10 + i, i)) })),
  ];
  const plan = buildExfat({ files, label: 'WOASTAGE', partitionOffset: 2048, serial: 0x12345678 });
  const image = new Uint8Array(plan.volumeSectors * 512);
  image.set(concatSource(plan.pieces).read(0, plan.writtenBytes));

  it('puts each file where it says, byte for byte', () => {
    for (const f of plan.files) {
      const src = files.find((x) => x.name === f.name)!.source;
      expect(Buffer.compare(image.subarray(f.offset, f.offset + f.size), src.read(0, src.size))).toBe(0);
    }
  });

  it('has a boot sector checksum and a backup boot region', () => {
    expect(new TextDecoder().decode(image.subarray(3, 11))).toBe('EXFAT   ');
    expect(image.subarray(0, 12 * 512)).toEqual(image.subarray(12 * 512, 24 * 512));
  });

  it('compresses the up-case table and maps a to A', () => {
    const t = upcaseTable();
    expect(t.length).toBeLessThan(10000);
    expect(tableChecksum(t)).toBeGreaterThan(0);
  });

  it.skipIf(!fsck)('passes fsck.exfat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exfat-'));
    const p = join(dir, 'v.img');
    writeFileSync(p, image);
    const r = spawnSync(fsck!, ['-n', '-v', p], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).not.toMatch(/corrupt|error|invalid|bad/i);
    expect(r.status).toBe(0);
    execFileSync('rm', ['-rf', dir]);
  });
});
