import assert from 'node:assert/strict';
import test from 'node:test';
import { generateGemini } from '../src/backends/gemini.ts';
import { config, jpeg, json, startServer } from './helpers.ts';

const request = { prompt: 'a red circle', count: 1 };
const output = (image: Buffer | undefined, extra: unknown[] = []) => ({
  id: 'v1_x', status: 'completed', usage: { total_input_tokens: 17, total_output_tokens: 1365, total_tokens: 1697, input_tokens_by_modality: [{ modality: 'text', tokens: 17 }] },
  steps: [{ type: 'thought', signature: 'S'.repeat(2000) }, { type: 'model_output', content: [...(image ? [{ type: 'image', mime_type: 'image/jpeg', data: image.toString('base64') }] : []), ...extra] }],
});

test('the Interactions request: key header only, jpeg response format, ratio and size, and the thought step is ignored', async t => {
  const server = await startServer(t, (_req, res) => json(res, 200, output(jpeg()), { 'x-goog-request-id': 'g1' }));
  const result = await generateGemini({ ...request, aspectRatio: '16:9', resolution: '2K' }, config().gemini, 'AIza-TESTKEY', { timeoutMs: 5000, endpoint: server.url });
  const seen = server.requests[0]!;
  assert.equal(seen.headers['x-goog-api-key'], 'AIza-TESTKEY'); assert.ok(!seen.url.includes('TESTKEY') && !seen.body.includes('TESTKEY'));
  assert.deepEqual(JSON.parse(seen.body), { model: 'gemini-nano-banana-2.1', input: [{ type: 'text', text: 'a red circle' }], response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '2K' } });
  assert.equal(result.images.length, 1); assert.equal(result.images[0]!.info.mime, 'image/jpeg'); assert.equal(result.controls, 'api'); assert.equal(result.requestId, 'g1');
  assert.deepEqual(result.usage, { total_input_tokens: 17, total_output_tokens: 1365, total_tokens: 1697 });
  assert.deepEqual(result.ignored, []);
});

test('options Gemini cannot apply are reported as ignored, not silently dropped', async t => {
  const server = await startServer(t, (_req, res) => json(res, 200, output(jpeg())));
  const result = await generateGemini({ ...request, format: 'png', quality: 'high', transparentBackground: true }, config().gemini, 'k', { timeoutMs: 5000, endpoint: server.url });
  assert.equal(result.ignored.length, 3);
  assert.match(result.ignored.join(' | '), /format png.*JPEG only.*quality.*transparentBackground/);
  assert.equal(JSON.parse(server.requests[0]!.body).response_format.mime_type, 'image/jpeg');
});

test('aspect ratios are checked per model before anything is sent; 2.5 Flash Image has no size parameter', async t => {
  const server = await startServer(t, (_req, res) => json(res, 200, output(jpeg())));
  await assert.rejects(generateGemini({ ...request, aspectRatio: '7:3' }, config().gemini, 'k', { timeoutMs: 5000, endpoint: server.url }), /IMAGE_INVALID_ARGUMENT: .*does not support aspectRatio 7:3/);
  await assert.rejects(generateGemini({ ...request, aspectRatio: '1:8' }, { ...config().gemini, model: 'gemini-3-pro-image' }, 'k', { timeoutMs: 5000, endpoint: server.url }), /IMAGE_INVALID_ARGUMENT/);
  assert.equal(server.requests.length, 0);
  const result = await generateGemini({ ...request, resolution: '4K' }, { ...config().gemini, model: 'gemini-2.5-flash-image' }, 'k', { timeoutMs: 5000, endpoint: server.url });
  assert.equal('image_size' in JSON.parse(server.requests[0]!.body).response_format, false);
  assert.match(result.ignored.join(' '), /resolution.*fixed output sizes/);
});

test('count makes one call per image; a later failure keeps the images already produced', async t => {
  const server = await startServer(t, (_req, res, index) => index < 2 ? json(res, 200, output(jpeg())) : json(res, 503, { error: { message: 'busy', code: 'unavailable' } }));
  const result = await generateGemini({ ...request, count: 3 }, config().gemini, 'k', { timeoutMs: 5000, endpoint: server.url });
  assert.equal(server.requests.length, 3); assert.equal(result.images.length, 2);
  assert.match(result.notes.join(' '), /Stopped after 2 of 3 images: IMAGE_PROVIDER_ERROR/);
  assert.equal(result.usage?.total_tokens, 3394, 'usage is summed over the calls that succeeded');
  const first = await startServer(t, (_req, res) => json(res, 503, { error: { message: 'busy' } }));
  await assert.rejects(generateGemini({ ...request, count: 2 }, config().gemini, 'k', { timeoutMs: 5000, endpoint: first.url }), /IMAGE_PROVIDER_ERROR/);
  assert.equal(first.requests.length, 1, 'no further call after the first failure');
});

test('errors and answers without an image are coded', async t => {
  const rejected = await startServer(t, (_req, res) => json(res, 400, { error: { message: "The value 'image/png' is not supported", code: 'invalid_request' } }));
  await assert.rejects(generateGemini(request, config().gemini, 'k', { timeoutMs: 5000, endpoint: rejected.url }), /IMAGE_REQUEST_REJECTED: Gemini returned HTTP 400 \(invalid_request\)/);
  const text = await startServer(t, (_req, res) => json(res, 200, output(undefined, [{ type: 'text', text: 'I cannot draw that.' }])));
  await assert.rejects(generateGemini(request, config().gemini, 'k', { timeoutMs: 5000, endpoint: text.url }), /IMAGE_NO_OUTPUT: Gemini returned no image: I cannot draw that\./);
  const junk = await startServer(t, (_req, res) => json(res, 200, { steps: [{ type: 'model_output', content: [{ type: 'image', data: Buffer.from('nope').toString('base64') }] }] }));
  await assert.rejects(generateGemini(request, config().gemini, 'k', { timeoutMs: 5000, endpoint: junk.url }), /IMAGE_BAD_IMAGE/);
});
