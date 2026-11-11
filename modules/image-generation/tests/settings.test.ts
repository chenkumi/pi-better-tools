import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ToolError } from '../../../shared/src/tool-error/index.ts';
import { saveSettings } from '../../../shared/src/settings-panel/index.ts';
import type { Field } from '../../../shared/src/settings-panel/index.ts';
import { defaults, loadConfig } from '../src/config.ts';
import { imageGenerationSettings } from '../src/settings.ts';
import { tempDir } from './helpers.ts';

const ctx = { cwd: process.cwd() };

test('every field has a unique key, a page and a label, and the schema never holds a credential', async t => {
  const schema = imageGenerationSettings(ctx, {}, join(await tempDir(t), 'c.json'));
  const keys = schema.fields.map(field => field.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...new Set(schema.fields.map(field => field.tab))], ['General', 'OpenAI', 'Gemini', 'Codex']);
  assert.ok(!schema.fields.some(field => field.type === 'secret' || /key|token|password/i.test(field.key.replace(/^codex\.check$/, ''))), 'no credential field');
  assert.equal(schema.appliesWithoutReload, true);
});

test('toValues mirrors the configuration and toPatch maps edited values back, with an empty codex model removing the key', async t => {
  const schema = imageGenerationSettings(ctx, {}, join(await tempDir(t), 'c.json'));
  const values = schema.toValues(defaults());
  assert.equal(values['openai.model'], 'gpt-image-2.6-sunburst'); assert.equal(values['codex.model'], ''); assert.equal(values.confirm, 'first');
  const patches = schema.toPatch({ ...values, backend: 'gemini', 'openai.quality': 'high', outputDir: '  assets/img ', 'codex.model': '  ' }, new Set(['backend', 'openai.quality', 'outputDir', 'codex.model']), defaults());
  assert.deepEqual(patches, [
    { path: ['backend'], value: 'gemini' }, { path: ['openai', 'quality'], value: 'high' }, { path: ['outputDir'], value: 'assets/img' }, { path: ['codex', 'model'], value: undefined },
  ]);
});

test('saving writes only the changed keys, validates the whole file, and keeps unrelated content', async t => {
  const path = join(await tempDir(t), 'image-generation.json');
  await writeFile(path, JSON.stringify({ backend: 'codex', maxImages: 2 }));
  const schema = imageGenerationSettings(ctx, {}, path);
  const values = { ...schema.toValues(loadConfig(path)), confirm: 'never', 'gemini.resolution': '2K' };
  assert.equal(await saveSettings(schema, values, new Set(['confirm', 'gemini.resolution'])), undefined);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { backend: 'codex', maxImages: 2, confirm: 'never', gemini: { resolution: '2K' } });
  const bad = await saveSettings(schema, { ...values, outputDir: '../outside' }, new Set(['outputDir']));
  assert.match(bad ?? '', /CONFIG_INVALID: outputDir/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).outputDir, undefined, 'the invalid value was not written');
});

test('the check actions report presence only, never a key', async t => {
  const schema = imageGenerationSettings(ctx, { key: async (_c, backend) => { if (backend === 'gemini') throw new ToolError('IMAGE_AUTH_MISSING', 'Gemini needs an API key login in Pi: no API key is stored.'); return 'sk-SECRET'; } }, join(await tempDir(t), 'c.json'));
  const action = (key: string) => schema.fields.find(field => field.key === key) as Extract<Field, { type: 'action' }>;
  const control = { signal: new AbortController().signal, progress() {} };
  const openai = await action('openai.check').run(control);
  assert.equal(openai, 'API key found in Pi'); assert.ok(!openai.includes('SECRET'));
  assert.match(await action('gemini.check').run(control), /Gemini needs an API key login in Pi/);
  assert.ok(action('openai.check').confirm.includes('Nothing is sent'));
});
