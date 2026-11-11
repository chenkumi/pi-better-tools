import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptsCustomSize, generateOpenAI, openaiSize } from '../src/backends/openai.ts';
import { postJson } from '../src/http.ts';
import { config, json, png, startServer } from './helpers.ts';

const request = { prompt: 'a green triangle', count: 1 };
const ok = (images: Buffer[], extra: Record<string, unknown> = {}) => ({ created: 1, data: images.map(image => ({ b64_json: image.toString('base64') })), usage: { input_tokens: 22, output_tokens: 824, total_tokens: 846, other: { x: 1 } }, ...extra });

test('size: auto without options; ratios become sizes the API accepts (multiples of 16, 1:3 to 3:1, pixel limits)', () => {
  const model = 'gpt-image-2.6-sunburst';
  assert.deepEqual(openaiSize(model), { size: 'auto' });
  assert.equal(openaiSize(model, '1:1', '1K').size, '1024x1024');
  assert.equal(openaiSize(model, '16:9', '1K').size, '1088x608', '1024x576 is below the 655,360 pixel minimum, so the long edge grows by 16 until it fits');
  assert.equal(openaiSize(model, '16:9', '4K').size, '3840x2160');
  assert.equal(openaiSize(model, '9:16', '2K').size, '1152x2048');
  assert.equal(openaiSize(model, '16:9').size, '1088x608');
  const wide = openaiSize(model, '3:1', '1K').size.split('x').map(Number);
  assert.ok(wide[0]! * wide[1]! >= 655_360 && wide[0]! % 16 === 0 && wide[1]! % 16 === 0, `a thin ratio is enlarged until it has enough pixels: ${wide}`);
  const square = openaiSize(model, '1:1', '4K');
  const [sw, sh] = square.size.split('x').map(Number);
  assert.ok(sw! * sh! <= 8_294_400 && sw! % 16 === 0 && sh! % 16 === 0, `a square 4K is shrunk to the pixel cap: ${square.size}`);
  assert.match(square.note ?? '', /pixel limit/);
  assert.ok(openaiSize(model, '4:3', '4K').size.split('x').map(Number).reduce((a, b) => a * b, 1) <= 8_294_400);
  assert.throws(() => openaiSize(model, '4:1'), /between 1:3 and 3:1/);
  assert.throws(() => openaiSize(model, 'wide'), /must look like/);
});

test('older models only take the fixed sizes, and the substitution is reported', () => {
  assert.equal(acceptsCustomSize('gpt-image-2'), true); assert.equal(acceptsCustomSize('gpt-image-2.5-flare'), true);
  assert.equal(acceptsCustomSize('gpt-image-1.5'), false); assert.equal(acceptsCustomSize('gpt-image-1-mini'), false);
  const landscape = openaiSize('gpt-image-1.5', '16:9', '2K');
  assert.equal(landscape.size, '1536x1024'); assert.match(landscape.note!, /fixed sizes.*resolution was not applied/);
  assert.equal(openaiSize('gpt-image-1.5', '9:16').size, '1024x1536');
  assert.equal(openaiSize('gpt-image-1.5', '1:1').size, '1024x1024');
});

test('the request carries the key only in the Authorization header, and the response is decoded and checked', async t => {
  const server = await startServer(t, (_req, res) => json(res, 200, ok([png(1024, 1024, 100)]), { 'x-request-id': 'req_abc' }));
  const result = await generateOpenAI({ ...request, aspectRatio: '16:9', quality: 'low', format: 'webp' }, config().openai, 'sk-TESTKEY', { timeoutMs: 5000, endpoint: server.url });
  const seen = server.requests[0]!;
  assert.equal(seen.method, 'POST'); assert.equal(seen.headers.authorization, 'Bearer sk-TESTKEY');
  assert.ok(!seen.url.includes('TESTKEY') && !seen.body.includes('TESTKEY'), 'the key is neither in the URL nor the body');
  assert.deepEqual(JSON.parse(seen.body), { model: 'gpt-image-2.6-sunburst', prompt: 'a green triangle', n: 1, size: '1088x608', quality: 'low', output_format: 'webp' });
  assert.equal(result.images.length, 1); assert.equal(result.images[0]!.info.mime, 'image/png');
  assert.equal(result.controls, 'api'); assert.equal(result.requestId, 'req_abc');
  assert.deepEqual(result.usage, { input_tokens: 22, output_tokens: 824, total_tokens: 846 }, 'only the numeric token fields are kept');
});

test('a transparent background needs png or webp; jpeg is refused and a configured jpeg becomes png', async t => {
  const server = await startServer(t, (_req, res) => json(res, 200, ok([png()])));
  await assert.rejects(generateOpenAI({ ...request, transparentBackground: true, format: 'jpeg' }, config().openai, 'k', { timeoutMs: 5000, endpoint: server.url }), /IMAGE_INVALID_ARGUMENT/);
  assert.equal(server.requests.length, 0, 'refused before anything was sent');
  const configured = { ...config().openai, format: 'jpeg' as const };
  const result = await generateOpenAI({ ...request, transparentBackground: true }, configured, 'k', { timeoutMs: 5000, endpoint: server.url });
  const body = JSON.parse(server.requests[0]!.body);
  assert.equal(body.background, 'transparent'); assert.equal(body.output_format, 'png');
  assert.match(result.notes.join(' '), /jpeg cannot be transparent/);
});

test('provider errors become coded failures with the provider message and request id, and are never retried', async t => {
  const cases: Array<[number, unknown, RegExp]> = [
    [400, { error: { message: "Invalid size '100x100'.", type: 'image_generation_user_error', param: 'size', code: 'invalid_value' } }, /IMAGE_REQUEST_REJECTED: OpenAI returned HTTP 400 \(invalid_value, size\): Invalid size '100x100'\. \[request req_1\]/],
    [400, { error: { message: 'blocked', code: 'moderation_blocked' } }, /IMAGE_BLOCKED/],
    [401, { error: { message: 'Incorrect API key' } }, /IMAGE_AUTH_FAILED: .*\/login/],
    [429, { error: { message: 'slow down' } }, /IMAGE_RATE_LIMITED/],
    [503, { error: { message: 'overloaded' } }, /IMAGE_PROVIDER_ERROR: .*may have been processed and billed; it was not retried/],
  ];
  for (const [status, body, pattern] of cases) {
    const server = await startServer(t, (_req, res) => json(res, status, body, { 'x-request-id': 'req_1' }));
    await assert.rejects(generateOpenAI(request, config().openai, 'k', { timeoutMs: 5000, endpoint: server.url }), pattern);
    assert.equal(server.requests.length, 1, `HTTP ${status} was sent once`);
  }
});

test('an answer without usable images fails with a code instead of saving junk', async t => {
  const missing = await startServer(t, (_req, res) => json(res, 200, { data: [] }));
  await assert.rejects(generateOpenAI(request, config().openai, 'k', { timeoutMs: 5000, endpoint: missing.url }), /IMAGE_NO_OUTPUT/);
  const url = await startServer(t, (_req, res) => json(res, 200, { data: [{ url: 'https://example.invalid/x.png' }] }));
  await assert.rejects(generateOpenAI(request, config().openai, 'k', { timeoutMs: 5000, endpoint: url.url }), /IMAGE_NO_OUTPUT: .*only base64/);
  const junk = await startServer(t, (_req, res) => json(res, 200, { data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
  await assert.rejects(generateOpenAI(request, config().openai, 'k', { timeoutMs: 5000, endpoint: junk.url }), /IMAGE_BAD_IMAGE/);
  const fewer = await startServer(t, (_req, res) => json(res, 200, ok([png()])));
  const result = await generateOpenAI({ ...request, count: 3 }, config().openai, 'k', { timeoutMs: 5000, endpoint: fewer.url });
  assert.match(result.notes.join(' '), /returned 1 of 3/);
});

test('the response is bounded while it streams, redirects are not followed, and an abort is reported as cancelled', async t => {
  const big = await startServer(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(5000)); });
  await assert.rejects(postJson({ url: big.url, headers: {}, body: {}, timeoutMs: 5000, maxBytes: 1000 }), /IMAGE_RESPONSE_TOO_LARGE/);
  const redirect = await startServer(t, (_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  await assert.rejects(postJson({ url: redirect.url, headers: {}, body: {}, timeoutMs: 5000, maxBytes: 1000 }), /IMAGE_NETWORK: .*redirect/);
  const controller = new AbortController();
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  const hanging = await startServer(t, () => received());
  const pending = postJson({ url: hanging.url, headers: {}, body: {}, timeoutMs: 60_000, maxBytes: 1000, signal: controller.signal });
  await arrived; controller.abort();
  await assert.rejects(pending, /IMAGE_CANCELLED/);
  await assert.rejects(postJson({ url: 'http://127.0.0.1:1/', headers: {}, body: {}, timeoutMs: 5000, maxBytes: 1000 }), /IMAGE_NETWORK: The request could not be sent/);
});
