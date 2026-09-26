import fs from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/** Bounded, read-only ZIP inspection. Never extracts paths or executes APK contents.
 * These strings are scope suggestions, never evidence that a service belongs to the app. */
export async function apkEndpointCandidates(filename: string, packageName?: string): Promise<string[]> {
  const file = await fs.open(filename, 'r');
  const counts = new Map<string, number>();
  const read = async (position: number, length: number) => {
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, position);
    if (result.bytesRead !== length) throw new Error('Truncated APK container.');
    return buffer;
  };
  try {
    const {size} = await file.stat();
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0) throw new Error('APK ZIP directory is missing.');
    const length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (length > 16 * 1024 * 1024 || offset + length > size) throw new Error('APK ZIP directory exceeds inspection limits.');
    const directory = await read(offset, length);
    let budget = 64 * 1024 * 1024;
    for (let p = 0; p + 46 <= directory.length;) {
      if (directory.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid APK ZIP directory.');
      const flags = directory.readUInt16LE(p+8), method = directory.readUInt16LE(p+10);
      const compressed = directory.readUInt32LE(p+20), uncompressed = directory.readUInt32LE(p+24);
      const nameLen = directory.readUInt16LE(p+28), extraLen = directory.readUInt16LE(p+30), commentLen = directory.readUInt16LE(p+32);
      const localOffset = directory.readUInt32LE(p+42), name = directory.toString('utf8', p+46, p+46+nameLen);
      p += 46+nameLen+extraLen+commentLen;
      if (!/^(classes\d*\.dex|resources\.arsc|AndroidManifest\.xml|assets\/.*\.(json|js|html|xml|txt|properties))$/.test(name)) continue;
      if (flags & 1 || ![0,8].includes(method) || uncompressed > 16*1024*1024 || compressed > 16*1024*1024 || uncompressed > budget) continue;
      budget -= uncompressed;
      const header = await read(localOffset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid APK ZIP entry.');
      const start = localOffset+30+header.readUInt16LE(26)+header.readUInt16LE(28);
      if (start+compressed > offset) throw new Error('Invalid APK ZIP entry bounds.');
      const data = await read(start, compressed);
      const bytes = method === 8 ? inflateRawSync(data, {maxOutputLength: Math.max(1, uncompressed)}) : data;
      if (bytes.length !== uncompressed) throw new Error('Invalid APK entry size.');
      for (const text of [bytes.toString('utf8'), bytes.toString('utf16le')]) {
        for (const match of text.matchAll(/https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[a-zA-Z0-9_./~-]*)?/g)) {
          try {
            const url = new URL(match[0]);
            if (!url.hostname.includes('.') && url.hostname !== 'localhost') continue;
            if (/^(schemas\.|www\.w3\.org$|developer\.android\.com$|schemas\.android\.com$)/.test(url.hostname)) continue;
            if (counts.size < 200 || counts.has(url.origin)) counts.set(url.origin, (counts.get(url.origin)||0)+1);
          } catch { /* Strings may contain incomplete URLs. */ }
        }
      }
    }
    const domain = packageName?.split('.').slice(0,2).reverse().join('.');
    const score = (url: string) => { const host = new URL(url).hostname; return (domain && (host===domain || host.endsWith('.'+domain)) ? 10000 : 0)+(counts.get(url)||0); };
    return [...counts.keys()].sort((a,b)=>score(b)-score(a)).slice(0,30);
  } finally { await file.close(); }
}
