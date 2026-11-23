// The cache Settings can clear: what it measures, what it deletes, what it keeps.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheInfo, clearCache } from '../src/main/cache';

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'cache-'));
  const put = (p: string, n: number) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), Buffer.alloc(n, 1)); };
  put('images/TaishanPi3M-emmc-edk2-0.4.1.img', 1000);
  put('images/armbian/Armbian.img', 3000);
  put('images/armbian/Armbian.img.sha256', 70);
  put('loaders/rk3576_spl_loader.bin', 200);
  put('nvdata-backups/tspi3m-nvdata-1.bin', 500);
  put('settings.json', 20);
  return d;
}

describe('the cache', () => {
  it('measures the downloads, the loader pieces and the settings copies apart', () => {
    const d = dataDir();
    const c = cacheInfo(d);
    expect(c.images).toMatchObject({ bytes: 4070, files: 3, names: ['TaishanPi3M-emmc-edk2-0.4.1.img', 'armbian'] });
    expect(c.loaders).toMatchObject({ bytes: 200, files: 1 });
    expect(c.nvdata).toMatchObject({ bytes: 500, files: 1 });
    rmSync(d, { recursive: true, force: true });
    expect(cacheInfo(d).images).toMatchObject({ bytes: 0, files: 0, names: [] });
  });
  it('deletes the downloads and loader pieces, keeps the settings copies and the settings', () => {
    const d = dataDir();
    const r = clearCache(d, { nvdata: false, busy: false });
    expect(r).toMatchObject({ ok: true, freed: 4270 });
    expect(existsSync(join(d, 'images'))).toBe(false);
    expect(existsSync(join(d, 'loaders'))).toBe(false);
    expect(existsSync(join(d, 'nvdata-backups', 'tspi3m-nvdata-1.bin'))).toBe(true);
    expect(existsSync(join(d, 'settings.json'))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('deletes the settings copies only when asked', () => {
    const d = dataDir();
    expect(clearCache(d, { nvdata: true, busy: false })).toMatchObject({ ok: true, freed: 4770 });
    expect(existsSync(join(d, 'nvdata-backups'))).toBe(false);
    expect(existsSync(join(d, 'settings.json'))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('refuses while a write runs, and deletes nothing', () => {
    const d = dataDir();
    expect(clearCache(d, { nvdata: true, busy: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/write is running/) });
    expect(cacheInfo(d).images.files).toBe(3);
    rmSync(d, { recursive: true, force: true });
  });
});
