import assert from 'node:assert/strict';
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { sniffImage } from '../src/images.ts';
import { prepareOutputDir, saveImages } from '../src/output.ts';
import { jpeg, png, tempDir } from './helpers.ts';

test('images are recognised by their bytes, with the size when it can be read', () => {
  assert.deepEqual(sniffImage(png(640, 480)), { ext: 'png', mime: 'image/png', width: 640, height: 480 });
  assert.deepEqual(sniffImage(jpeg()), { ext: 'jpg', mime: 'image/jpeg', width: 2, height: 3 });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(sniffImage(webp)?.mime, 'image/webp');
  for (const bytes of [Buffer.from('<svg/>'), Buffer.from('not an image at all'), Buffer.alloc(0), png().subarray(0, 12)]) assert.equal(sniffImage(bytes), undefined);
});

test('the output directory is created inside the project one segment at a time', async t => {
  const cwd = await tempDir(t);
  const target = await prepareOutputDir(cwd, '.pi/generated-images');
  assert.ok(target.dir.endsWith(join('.pi', 'generated-images')));
  assert.deepEqual(await readdir(join(cwd, '.pi')), ['generated-images']);
  assert.equal((await prepareOutputDir(cwd, '.pi/generated-images')).dir, target.dir, 'an existing directory is reused');
});

test('a link or a file in the way of the output directory is refused', async t => {
  const cwd = await tempDir(t), outside = await tempDir(t, 'image-outside-');
  await symlink(outside, join(cwd, 'linked'), 'junction');
  await assert.rejects(prepareOutputDir(cwd, 'linked/images'), /IMAGE_OUTPUT_DIR: .*no links/);
  assert.deepEqual(await readdir(outside), [], 'nothing was created behind the link');
  await writeFile(join(cwd, 'afile'), 'x');
  await assert.rejects(prepareOutputDir(cwd, 'afile'), /IMAGE_OUTPUT_DIR/);
});

test('saving only adds files: names are system made and an existing name is never replaced', async t => {
  const cwd = await tempDir(t);
  const target = await prepareOutputDir(cwd, 'out');
  const now = new Date(Date.UTC(2026, 10, 11, 3, 45, 32, 123));
  const first = await saveImages(target, [{ bytes: png(4, 5), info: sniffImage(png(4, 5))! }, { bytes: jpeg(), info: sniffImage(jpeg())! }], now);
  assert.deepEqual(first.map(file => file.path), ['out/IMG-20261111T034532Z-1.png', 'out/IMG-20261111T034532Z-2.jpg']);
  assert.equal(first[0]!.bytes, 24); assert.equal(first[0]!.width, 4); assert.match(first[0]!.sha256, /^[0-9a-f]{64}$/);
  const again = await saveImages(target, [{ bytes: png(9, 9), info: sniffImage(png(9, 9))! }], now);
  assert.equal(again[0]!.path, 'out/IMG-20261111T034532Z-1-2.png', 'the second save did not replace the first');
  assert.equal((await readFile(join(cwd, first[0]!.path))).readUInt32BE(16), 4);
});
