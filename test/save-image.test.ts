import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import { freeBytes, saveImage } from '../src/main/save-image';
import { uncompressedName } from '../src/shared/format';
import type { ImageSource } from '../src/main/image-source';

const work = mkdtempSync(join(tmpdir(), 'save-image-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let n = 0;
/** A new empty folder to save into, and one with the source. */
const dirs = () => {
  n++;
  const out = join(work, `out-${n}`);
  const src = join(work, `src-${n}`);
  mkdirSync(out);
  mkdirSync(src);
  return { out, src };
};

// etcher-sdk's decompressors are loaded with require(), which the tests do
// not have; a gzip stream stands in for them.
const gunzip = async (path: string): Promise<ImageSource> => ({
  stream: createReadStream(path).pipe(createGunzip()),
  close: async () => {},
});
const plenty = async () => 1e15;

const image = randomBytes(300000);
const gz = gzipSync(image);
const expected = { size: image.length, sha256: sha(image) };

describe('saving an image as a file', () => {
  it('saves the decompressed image under the chosen name, with nothing else left', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'r.img.gz'), gz);
    const seen: [number, number][] = [];
    const r = await saveImage({
      source: join(src, 'r.img.gz'), dest: join(out, 'r.img'), expected, open: gunzip, freeSpace: plenty,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(r).toEqual({ path: join(out, 'r.img'), size: image.length, sha256: sha(image) });
    expect(readFileSync(join(out, 'r.img')).equals(image)).toBe(true);
    expect(readdirSync(out)).toEqual(['r.img']);
    expect(seen.at(-1)).toEqual([image.length, image.length]);
  });

  it('writes to a temporary file in the same folder and renames it at the end', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'r.img.gz'), gz);
    const during: string[][] = [];
    await saveImage({
      source: join(src, 'r.img.gz'), dest: join(out, 'r.img'), expected, open: gunzip, freeSpace: plenty,
      onProgress: () => { during.push(readdirSync(out)); },
    });
    // By the last piece the temporary file is open; the chosen name is not there yet.
    expect(during.at(-1)).toHaveLength(1);
    expect(during.at(-1)![0]).toMatch(/^\.r\.img\.[0-9a-f]{8}\.part$/);
    expect(readdirSync(out)).toEqual(['r.img']);
  });

  it('leaves nothing when the size does not match the release, and keeps a file that was there', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'r.img.gz'), gz);
    writeFileSync(join(out, 'r.img'), 'before');
    await expect(saveImage({
      source: join(src, 'r.img.gz'), dest: join(out, 'r.img'), expected: { ...expected, size: image.length + 1 },
      open: gunzip, freeSpace: plenty,
    })).rejects.toThrow(/does not match the release.*Nothing was saved/);
    expect(readdirSync(out)).toEqual(['r.img']);
    expect(readFileSync(join(out, 'r.img'), 'utf8')).toBe('before');
  });

  it('leaves nothing when the SHA-256 does not match the release', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'r.img.gz'), gz);
    await expect(saveImage({
      source: join(src, 'r.img.gz'), dest: join(out, 'r.img'), expected: { ...expected, sha256: 'f'.repeat(64) },
      open: gunzip, freeSpace: plenty,
    })).rejects.toThrow(/SHA-256 [0-9a-f]{64}; the release has 300000 bytes, f{64}\. Nothing was saved/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses before reading anything when there is not enough free space', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'r.img.gz'), gz);
    const open = vi.fn(gunzip);
    const freeSpace = vi.fn(async () => 1000);
    await expect(saveImage({ source: join(src, 'r.img.gz'), dest: join(out, 'r.img'), expected, open, freeSpace }))
      .rejects.toThrow(/not enough free space in .*out-\d+: the image needs 293\.0 KiB, 1000 bytes is free\. Nothing was saved/);
    expect(freeSpace).toHaveBeenCalledWith(out);
    expect(open).not.toHaveBeenCalled();
    expect(readdirSync(out)).toEqual([]);
  });

  it('goes ahead when the free space cannot be told', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'r.img.gz'), gz);
    await saveImage({ source: join(src, 'r.img.gz'), dest: join(out, 'r.img'), expected, open: gunzip,
      freeSpace: async () => { throw new Error('ENOSYS'); } });
    expect(readdirSync(out)).toEqual(['r.img']);
  });

  it('says plainly when the disk fills up, and leaves nothing', async () => {
    const { out } = dirs();
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const open = async (): Promise<ImageSource> => ({
      stream: new Readable({ read() { this.push(Buffer.alloc(1024)); setImmediate(() => this.destroy(full)); } }),
      close: async () => {},
    });
    await expect(saveImage({ source: '/nowhere/c.img.gz', dest: join(out, 'c.img'), expected: null, open }))
      .rejects.toThrow(/^The disk that holds .*out-\d+ is full\. Nothing was saved\.$/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('leaves nothing when cancelled', async () => {
    const { out } = dirs();
    const ac = new AbortController();
    const closed = vi.fn(async () => {});
    // One piece per turn of the event loop, so the timer below can fire.
    const endless = new Readable({ read() { setImmediate(() => this.push(Buffer.alloc(64 * 1024))); } });
    setTimeout(() => ac.abort(), 50);
    await expect(saveImage({
      source: '/nowhere/big.img.xz', dest: join(out, 'big.img'), expected, signal: ac.signal, freeSpace: plenty,
      open: async () => ({ stream: endless, close: closed }),
    })).rejects.toThrow();
    expect(readdirSync(out)).toEqual([]);
    expect(closed).toHaveBeenCalled();
  });

  it('saves a custom image without a release to compare with, and takes its SHA-256', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'mine.img.gz'), gz);
    const freeSpace = vi.fn(plenty);
    const r = await saveImage({ source: join(src, 'mine.img.gz'), dest: join(out, 'mine.img'), expected: null, open: gunzip, freeSpace });
    expect(r.sha256).toBe(sha(image));
    // Its size is not known before it is read: no free space to compare.
    expect(freeSpace).not.toHaveBeenCalled();
    expect(readFileSync(join(out, 'mine.img')).equals(image)).toBe(true);
  });

  it('refuses an empty image and a save over the file it reads', async () => {
    const { out, src } = dirs();
    writeFileSync(join(src, 'empty.img.gz'), gzipSync(Buffer.alloc(0)));
    await expect(saveImage({ source: join(src, 'empty.img.gz'), dest: join(out, 'empty.img'), expected: null, open: gunzip }))
      .rejects.toThrow(/empty\. Nothing was saved/);
    expect(readdirSync(out)).toEqual([]);
    writeFileSync(join(src, 'same.img'), image);
    await expect(saveImage({ source: join(src, 'same.img'), dest: join(src, '.', 'same.img'), expected: null, open: gunzip }))
      .rejects.toThrow(/cannot be saved over the file it is read from/);
    expect(readFileSync(join(src, 'same.img')).equals(image)).toBe(true);
  });

  it('reads the free space of a real folder', async () => {
    const free = await freeBytes(work);
    expect(Number.isFinite(free)).toBe(true);
    expect(free).toBeGreaterThan(0);
    expect(existsSync(work)).toBe(true);
  });
});

describe('the name a saved image gets', () => {
  it('is the release file name without the compression suffix', () => {
    expect(uncompressedName('roxora-radxa-rock-4d-noble-edge-2026.11.3.img.xz')).toBe('roxora-radxa-rock-4d-noble-edge-2026.11.3.img');
    expect(uncompressedName('mine.img.gz')).toBe('mine.img');
    expect(uncompressedName('mine.img.BZ2')).toBe('mine.img');
    expect(uncompressedName('plain.img')).toBe('plain.img');
    expect(uncompressedName('.xz')).toBe('.xz');
  });
});
