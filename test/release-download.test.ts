// Release downloads against a local server standing in for GitHub: a file
// that is one download, and an image a release carries in parts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadReleaseFile, type FetchFn, type ReleaseFile } from '../src/main/release-download';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'download-test-'));
const image = randomBytes(700000);
// Three parts, the last one smaller, as the release workflow cuts them.
const cuts = [image.subarray(0, 300000), image.subarray(300000, 600000), image.subarray(600000)];
const requests: string[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const m = /^\/(ok|slow|swapped)\/image\.img\.xz(?:\.part(\d))?$/.exec(req.url ?? '');
    if (!m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let data = m[2] ? cuts[Number(m[2]) - 1] : image;
    // A part that is not the release's: the bytes of another part.
    if (m[1] === 'swapped' && m[2] === '2') data = cuts[0];
    if (!data) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-length', data.length);
    res.write(data.subarray(0, 1000));
    // The second part slow enough to be cancelled.
    if (m[1] === 'slow' && m[2] === '2') setTimeout(() => res.end(data.subarray(1000)), 2000);
    else res.end(data.subarray(1000));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(work, { recursive: true, force: true }); });

const f = fetch as unknown as FetchFn;
const whole = (dir = 'ok'): ReleaseFile =>
  ({ file: 'image.img.xz', url: `${base}/${dir}/image.img.xz`, size: image.length, sha256: sha(image), sample: false });
const inParts = (dir = 'ok', count = 3): ReleaseFile => ({
  ...whole(dir), url: '',
  parts: cuts.slice(0, count).map((c, i) => ({
    file: `image.img.xz.part${i + 1}`, url: `${base}/${dir}/image.img.xz.part${i + 1}`, size: c.length, sha256: sha(c),
  })),
});
const cache = (name: string) => join(work, name);
const left = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe('a release file that is one download', () => {
  it('is downloaded, checked and kept under its name', async () => {
    const seen: number[] = [];
    const path = await downloadReleaseFile(whole(), cache('one'), (p) => { if (p.stage === 'download') seen.push(p.bytes); }, undefined, f);
    expect(path).toBe(join(cache('one'), 'image.img.xz'));
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(seen[seen.length - 1]).toBe(image.length);
    expect(left(cache('one'))).toEqual(['image.img.xz']);
  });

  it('is taken from the cache when it is there and still matches', async () => {
    requests.length = 0;
    const stages = new Set<string>();
    await downloadReleaseFile(whole(), cache('one'), (p) => stages.add(p.stage), undefined, f);
    expect(requests).toEqual([]);
    expect([...stages]).toEqual(['check']);
  });

  it('is refused when it is not the release file, and nothing is left', async () => {
    const wrong = { ...whole(), sha256: '0'.repeat(64) };
    await expect(downloadReleaseFile(wrong, cache('wrong'), () => {}, undefined, f)).rejects.toThrow(/does not match the release/);
    expect(left(cache('wrong'))).toEqual([]);
  });

  it('refuses sample entries', async () => {
    await expect(downloadReleaseFile({ ...whole(), sample: true }, cache('sample'), () => {}, undefined, f)).rejects.toThrow(/Sample entries/);
  });
});

describe('an image in parts', () => {
  it('is downloaded part after part into one file, with the progress over the whole image', async () => {
    requests.length = 0;
    const seen: { bytes: number; total: number }[] = [];
    const path = await downloadReleaseFile(inParts(), cache('parts'), (p) => { if (p.stage === 'download') seen.push(p); }, undefined, f);
    expect(requests).toEqual(['/ok/image.img.xz.part1', '/ok/image.img.xz.part2', '/ok/image.img.xz.part3']);
    expect(path).toBe(join(cache('parts'), 'image.img.xz'));
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(seen.every((p) => p.total === image.length)).toBe(true);
    // The count goes on from part to part and never starts again.
    expect(seen.every((p, i) => i === 0 || p.bytes > seen[i - 1].bytes)).toBe(true);
    expect(seen[seen.length - 1].bytes).toBe(image.length);
    // Only the joined file stays in the cache.
    expect(left(cache('parts'))).toEqual(['image.img.xz']);
  });

  it('is taken from the cache once joined', async () => {
    requests.length = 0;
    await downloadReleaseFile(inParts(), cache('parts'), () => {}, undefined, f);
    expect(requests).toEqual([]);
  });

  it('replaces a joined file in the cache that no longer matches', async () => {
    const dir = cache('stale');
    await downloadReleaseFile(inParts(), dir, () => {}, undefined, f);
    const broken = Buffer.from(image);
    broken[5] ^= 0xff;
    writeFileSync(join(dir, 'image.img.xz'), broken);
    const path = await downloadReleaseFile(inParts(), dir, () => {}, undefined, f);
    expect(readFileSync(path).equals(image)).toBe(true);
  });

  it('stops at a part that is not the release part, naming it, and leaves nothing', async () => {
    requests.length = 0;
    await expect(downloadReleaseFile(inParts('swapped'), cache('swapped'), () => {}, undefined, f))
      .rejects.toThrow(/part 2 of 3 does not match the release/);
    // The third part is not asked for.
    expect(requests).toEqual(['/swapped/image.img.xz.part1', '/swapped/image.img.xz.part2']);
    expect(left(cache('swapped'))).toEqual([]);
  });

  it('refuses parts that are each right but do not join to the image', async () => {
    const short = { ...inParts('ok', 2) };
    await expect(downloadReleaseFile(short, cache('short'), () => {}, undefined, f)).rejects.toThrow(/The download does not match the release/);
    expect(left(cache('short'))).toEqual([]);
  });

  it('fails plainly when a part is not in the release', async () => {
    const img = inParts();
    img.parts![2] = { ...img.parts![2], url: `${base}/ok/image.img.xz.part7` };
    await expect(downloadReleaseFile(img, cache('missing'), () => {}, undefined, f)).rejects.toThrow(/HTTP 404 for part 3 of 3/);
    expect(left(cache('missing'))).toEqual([]);
  });

  it('can be cancelled in a later part, and leaves nothing', async () => {
    const stop = new AbortController();
    const run = downloadReleaseFile(inParts('slow'), cache('cancel'), (p) => {
      // Past the first part: cancel while the second is coming in.
      if (p.stage === 'download' && p.bytes > cuts[0].length) stop.abort();
    }, stop.signal, f);
    await expect(run).rejects.toThrow();
    expect(stop.signal.aborted).toBe(true);
    expect(left(cache('cancel'))).toEqual([]);
  });
});
