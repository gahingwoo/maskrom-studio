// Read the files out of a zip (the Win32-OpenSSH release), with the
// inflate function the caller has (node:zlib's inflateRawSync in the main
// process). Stored and deflated entries only, which is what the release has.

export interface ZipEntry { path: string; data: Uint8Array }

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function unzip(zip: Uint8Array, inflateRaw: (d: Uint8Array) => Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (le32(zip, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = le16(zip, eocd + 10);
  let p = le32(zip, eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (le32(zip, p) !== 0x02014b50) throw new Error('zip central directory is damaged');
    const method = le16(zip, p + 10);
    const csize = le32(zip, p + 20);
    const usize = le32(zip, p + 24);
    const nameLen = le16(zip, p + 28);
    const extraLen = le16(zip, p + 30);
    const commentLen = le16(zip, p + 32);
    const local = le32(zip, p + 42);
    const path = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue;
    if (le32(zip, local) !== 0x04034b50) throw new Error('zip entry is damaged');
    const start = local + 30 + le16(zip, local + 26) + le16(zip, local + 28);
    const raw = zip.subarray(start, start + csize);
    const data = method === 0 ? raw.slice() : method === 8 ? inflateRaw(raw) : null;
    if (!data) throw new Error(`zip entry ${path} uses compression method ${method}`);
    if (data.length !== usize) throw new Error(`zip entry ${path} has the wrong size`);
    out.push({ path, data });
  }
  return out;
}
