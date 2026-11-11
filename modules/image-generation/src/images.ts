export interface ImageInfo { ext: 'png' | 'jpg' | 'webp'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; width?: number; height?: number }

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identifies the bytes by their magic number, never by what a provider claims. Undefined when they are not a supported image. */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_MAGIC)) return { ext: 'png', mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', ...jpegSize(b) };
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return undefined;
}

/** Start-of-frame marker scan; gives up quietly on anything unusual (the size is informational). */
function jpegSize(b: Buffer): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (length < 2) return {};
    i += 2 + length;
  }
  return {};
}
