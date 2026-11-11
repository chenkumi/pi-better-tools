import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolError } from '../../../shared/src/tool-error/index.ts';
import type { Config } from '../src/config.ts';
import { createImageTool, imageNamespace, type ImageParameters } from '../src/tool.ts';
import { config, jpeg, json, png, startServer, tempDir } from './helpers.ts';

const ok = (image: Buffer) => ({ data: [{ b64_json: image.toString('base64') }], usage: { total_tokens: 5 } });
const geminiOk = (image: Buffer) => ({ steps: [{ type: 'model_output', content: [{ type: 'image', data: image.toString('base64') }] }] });

async function setup(t: TestContext, options: { config?: Partial<Config>; hasUI?: boolean; answer?: boolean; sessionId?: string; key?: () => Promise<string> } = {}) {
  const cwd = await tempDir(t);
  const asked: string[] = [];
  const server = await startServer(t, (_req, res) => json(res, 200, ok(png(16, 8))));
  const gemini = await startServer(t, (_req, res) => json(res, 200, geminiOk(jpeg())));
  let session = options.sessionId ?? 's1';
  const cfg = config({ outputDir: 'out', ...options.config });
  const tool = createImageTool({
    readConfig: () => cfg,
    key: options.key ?? (async () => 'k'),
    now: () => new Date(Date.UTC(2026, 10, 11, 1, 2, 3)),
    confirm: async (_ctx, title, message) => { asked.push(`${title}: ${message}`); return options.answer ?? true; },
    openai: { endpoint: server.url }, gemini: { endpoint: gemini.url },
  });
  const ctx = () => ({ cwd, hasUI: options.hasUI ?? true, mode: 'tui', ui: {}, sessionManager: { getSessionId: () => session } }) as never;
  const run = (params: Partial<ImageParameters> = {}) => tool.execute('id', { prompt: 'a green triangle', ...params } as never, undefined, undefined, ctx()) as Promise<any>;
  return { cwd, asked, server, gemini, run, newSession: (id: string) => { session = id; }, tool };
}

test('the tool is deferred in the image namespace and is not default-active', async t => {
  const { tool } = await setup(t);
  assert.equal(tool.name, 'image_generate'); assert.equal((tool as { exposure?: string }).exposure, 'deferred');
  assert.deepEqual((tool as { namespace?: unknown }).namespace, imageNamespace);
  assert.equal((tool as { defaultActive?: boolean }).defaultActive, undefined);
  assert.equal(typeof tool.renderCall, 'function'); assert.equal(typeof tool.renderResult, 'function');
});

test('a call saves the image as a new project file and reports path, size, hash and options not applied', async t => {
  const { run, cwd, server } = await setup(t, { config: { confirm: 'never' } });
  const result = await run({ aspectRatio: '16:9' });
  const file = result.details.files[0];
  assert.equal(file.path, 'out/IMG-20261111T010203Z-1.png'); assert.equal(file.width, 16); assert.equal(file.height, 8);
  assert.equal((await readFile(join(cwd, file.path))).length, 24);
  assert.match(result.content[0].text, /^Generated 1 image with OpenAI \(gpt-image-2\.6-sunburst\)\.\nout\/IMG-20261111T010203Z-1\.png · 24 bytes · 16x8 · sha256 [0-9a-f]{12}$/);
  assert.deepEqual(result.structuredContent, result.details); assert.equal(result.content.length, 1, 'no preview unless configured');
  assert.equal(JSON.parse(server.requests[0]!.body).size, '1088x608');
  assert.equal(result.details.backend, 'openai'); assert.equal(result.details.controls, 'api');
});

test('inlinePreview attaches the first image to the result', async t => {
  const { run } = await setup(t, { config: { confirm: 'never', inlinePreview: true } });
  const result = await run();
  assert.equal(result.content[1].type, 'image'); assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(result.content[1].data, 'base64').length, 24);
});

test('the backend argument overrides the default, and a disabled backend is refused before anything is sent', async t => {
  const { run, gemini, server } = await setup(t, { config: { confirm: 'never', gemini: { ...config().gemini, enabled: true }, codex: { ...config().codex, enabled: false } } });
  const result = await run({ backend: 'gemini' });
  assert.equal(result.details.backend, 'gemini'); assert.match(result.details.files[0].path, /\.jpg$/);
  assert.equal(gemini.requests.length, 1); assert.equal(server.requests.length, 0);
  await assert.rejects(run({ backend: 'codex' }), /IMAGE_BACKEND_DISABLED/);
});

test('confirm "first" asks once per session and backend; a new session or backend asks again', async t => {
  const { run, asked, newSession } = await setup(t);
  await run(); await run();
  assert.equal(asked.length, 1, 'the second call in the same session was not asked');
  assert.match(asked[0]!, /Generate image: Generate 1 image with OpenAI \(gpt-image-2\.6-sunburst\)\?\nPrompt \(16 characters\): a green triangle\nThe prompt is sent to api\.openai\.com, billed to your OpenAI API account\. Files are saved under out\//);
  await run({ backend: 'gemini' }); assert.equal(asked.length, 2);
  newSession('s2'); await run(); assert.equal(asked.length, 3);
});

test('confirm "always" asks every time and "never" never asks', async t => {
  const always = await setup(t, { config: { confirm: 'always' } });
  await always.run(); await always.run(); assert.equal(always.asked.length, 2);
  const never = await setup(t, { config: { confirm: 'never' } });
  await never.run(); assert.equal(never.asked.length, 0);
});

test('a declined request sends nothing and a later one asks again', async t => {
  const { run, asked, server } = await setup(t, { answer: false });
  await assert.rejects(run(), /IMAGE_DECLINED: .*Nothing was sent/);
  await assert.rejects(run(), /IMAGE_DECLINED/);
  assert.equal(asked.length, 2); assert.equal(server.requests.length, 0);
});

test('without an interactive UI a paid request that needs approval is refused (a Fork); "never" lets it run', async t => {
  const refused = await setup(t, { hasUI: false });
  await assert.rejects(refused.run(), /IMAGE_CONFIRM_UNAVAILABLE: .*"confirm": "never"/);
  assert.equal(refused.server.requests.length, 0); assert.equal(refused.asked.length, 0);
  const allowed = await setup(t, { hasUI: false, config: { confirm: 'never' } });
  assert.equal((await allowed.run()).details.files.length, 1);
});

test('everything that can fail for free fails before the confirmation: login, arguments, configuration', async t => {
  const noKey = await setup(t, { key: async () => { throw new ToolError('IMAGE_AUTH_MISSING', 'no key'); } });
  await assert.rejects(noKey.run(), /IMAGE_AUTH_MISSING/);
  assert.equal(noKey.asked.length, 0); assert.equal(noKey.server.requests.length, 0);
  const { run, asked } = await setup(t, { config: { maxImages: 2 } });
  await assert.rejects(run({ count: 3 }), /IMAGE_INVALID_ARGUMENT: count 3 is above the configured maximum of 2/);
  await assert.rejects(run({ aspectRatio: 'wide' }), /IMAGE_INVALID_ARGUMENT/);
  await assert.rejects(run({ prompt: '   ' }), /IMAGE_INVALID_ARGUMENT: prompt must not be empty/);
  assert.equal(asked.length, 0);
  const cwd = await tempDir(t);
  const broken = createImageTool({ readConfig: () => { throw new Error('CONFIG_INVALID: backend: must be one of: openai, gemini, codex'); } });
  await assert.rejects(broken.execute('i', { prompt: 'x' } as never, undefined, undefined, { cwd } as never), /IMAGE_CONFIG_INVALID: backend: must be one of.*\/settings:image-generation/);
});

test('provider failures reach the caller as coded errors and leave no file behind', async t => {
  const cwd = await tempDir(t);
  const server = await startServer(t, (_req, res) => json(res, 400, { error: { message: 'bad', code: 'invalid_value', param: 'size' } }));
  const tool = createImageTool({ readConfig: () => config({ confirm: 'never', outputDir: 'out' }), key: async () => 'k', openai: { endpoint: server.url } });
  await assert.rejects(tool.execute('i', { prompt: 'x' } as never, undefined, undefined, { cwd, hasUI: true, sessionManager: { getSessionId: () => 's' } } as never), /IMAGE_REQUEST_REJECTED/);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(cwd, 'out')).catch(() => []), []);
});

test('a declined request does not create the output directory', async t => {
  const { run, cwd } = await setup(t, { answer: false });
  await assert.rejects(run(), /IMAGE_DECLINED/);
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(join(cwd, 'out')), 'nothing is created before the user approves');
});
