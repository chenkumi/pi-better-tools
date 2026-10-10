// Regression D16: settings images.autoResize=false must be honoured by file-tools' read for large images, exactly like Pi's native read.
// file-tools hands image reads to a host read definition created WITHOUT autoResizeImages, so the host default (true) applies.
// Level: real Pi 1.1.0 CLI (print mode, offline scripted provider with image input), real file-tools entry, programmatically generated PNG.
// Note: BMP is not covered because Pi's native read does not treat BMP as an image, so there is no native control to compare against.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { makeSandbox, root, runCli } from '../../../tests/helpers/regression/run-cli.mjs';

const fileTools = join(root, 'modules/file-tools/src/index.ts');
const WIDTH = 3200, HEIGHT = 2600;

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) { const row = y * (1 + width * 3); for (let x = 0; x < width; x++) { raw[row + 1 + x * 3] = x & 255; raw[row + 2 + x * 3] = y & 255; raw[row + 3 + x * 3] = (x + y) & 255; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
function dimensions(base64, mimeType) {
  const b = Buffer.from(base64, 'base64');
  if (mimeType === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (mimeType === 'image/jpeg') {
    for (let i = 2; i < b.length;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }; i += 2 + b.readUInt16BE(i + 2); }
  }
  throw new Error(`cannot read dimensions of ${mimeType}`);
}
async function readImage({ autoResize, withFileTools }) {
  const label = `D16-${withFileTools ? 'file-tools' : 'native'}-resize-${autoResize}`;
  const sb = await makeSandbox(label, { images: { autoResize } });
  try {
    console.error(`[repro:${label}] generating ${WIDTH}x${HEIGHT} PNG...`);
    await writeFile(join(sb.cwd, 'big.png'), makePng(WIDTH, HEIGHT));
    const script = [{ content: [{ type: 'toolCall', id: 'read1', name: 'read', arguments: { path: 'big.png' } }] }, { content: [{ type: 'text', text: 'done' }] }];
    const run = await runCli(sb, { script, label, extensions: withFileTools ? [fileTools] : [], args: ['--tools', 'read'] });
    assert.equal(run.requests.length, 2, `read call then final answer expected; stderr=${run.stderr}`);
    const result = run.requests[1].messages.find(m => m.role === 'toolResult' && m.toolName === 'read');
    assert.ok(result && !result.isError, `read must succeed: ${JSON.stringify(result)?.slice(0, 400)}`);
    const image = result.content.find(b => b.type === 'image');
    assert.ok(image, `read must return an image block, got ${JSON.stringify(result.content.map(b => b.type))}`);
    const dims = dimensions(image.data, image.mimeType);
    console.error(`[repro:${label}] delivered image ${image.mimeType} ${dims.width}x${dims.height}`);
    return dims;
  } finally { await sb.cleanup(); }
}

test('D16 control: native read with autoResize=false keeps original size', { timeout: 180000 }, async () => {
  assert.deepEqual(await readImage({ autoResize: false, withFileTools: false }), { width: WIDTH, height: HEIGHT });
});
test('D16 sanity: native read with autoResize=true shrinks the large image', { timeout: 180000 }, async () => {
  const dims = await readImage({ autoResize: true, withFileTools: false });
  assert.ok(dims.width <= 2000 && dims.height <= 2000, `expected resizing, got ${dims.width}x${dims.height}`);
});
test('D16 file-tools read with autoResize=false must keep original size like native read', { timeout: 180000 }, async () => {
  assert.deepEqual(await readImage({ autoResize: false, withFileTools: true }), { width: WIDTH, height: HEIGHT });
});
test('D16 file-tools read with autoResize=true (default behaviour) still shrinks the large image', { timeout: 180000 }, async () => {
  const dims = await readImage({ autoResize: true, withFileTools: true });
  assert.ok(dims.width <= 2000 && dims.height <= 2000, `expected resizing, got ${dims.width}x${dims.height}`);
});
