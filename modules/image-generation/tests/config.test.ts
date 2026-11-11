import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { defaults, loadConfig, parseConfig } from '../src/config.ts';
import { tempDir } from './helpers.ts';

test('an empty object is the defaults, and a partial file keeps the other defaults', () => {
  assert.deepEqual(parseConfig({}), defaults());
  const parsed = parseConfig({ backend: 'gemini', openai: { quality: 'high' }, codex: { model: 'some-model' } });
  assert.equal(parsed.backend, 'gemini'); assert.equal(parsed.openai.quality, 'high'); assert.equal(parsed.openai.model, defaults().openai.model); assert.equal(parsed.codex.model, 'some-model');
  assert.equal(parseConfig({ codex: { model: null } }).codex.model, undefined);
});

test('unknown keys and wrong values are rejected with the field path and never echo the value', () => {
  const rejects = (value: unknown, pattern: RegExp) => assert.throws(() => parseConfig(value), error => pattern.test((error as Error).message) && !/SECRET_VALUE/.test((error as Error).message));
  rejects({ apiKey: 'SECRET_VALUE' }, /^CONFIG_INVALID: config: unknown field/);
  rejects({ openai: { apiKey: 'SECRET_VALUE' } }, /openai: unknown field/);
  rejects({ backend: 'SECRET_VALUE' }, /backend: must be one of/);
  rejects({ confirm: 'SECRET_VALUE' }, /confirm: must be one of/);
  rejects({ maxImages: 0 }, /maxImages: must be an integer/);
  rejects({ maxImages: 11 }, /maxImages/);
  rejects({ timeoutMs: 5 }, /timeoutMs/);
  rejects({ inlinePreview: 'yes' }, /inlinePreview: must be true or false/);
  rejects({ openai: { model: 'bad model!' } }, /openai.model/);
  rejects({ gemini: { resolution: '8K' } }, /gemini.resolution/);
  rejects({ version: 2 }, /version/);
  rejects([], /must be a JSON object/);
});

test('the output directory stays inside the project and the codex path is not a shell shim', () => {
  assert.equal(parseConfig({ outputDir: 'assets\\generated/' }).outputDir, 'assets/generated');
  for (const bad of ['..', '../x', 'a/../b', '/abs', 'C:/abs', '\\\\server\\share', '', '   ', 'a|b']) assert.throws(() => parseConfig({ outputDir: bad }), /outputDir/, bad);
  for (const bad of ['codex.cmd', 'C:\\tools\\codex.BAT']) assert.throws(() => parseConfig({ codex: { path: bad } }), /not a \.cmd\/\.bat shim/, bad);
  assert.equal(parseConfig({ codex: { path: 'C:\\Program Files\\Codex\\codex.exe' } }).codex.path, 'C:\\Program Files\\Codex\\codex.exe');
});

test('a missing file is the defaults; an unreadable one fails without quoting its content', async t => {
  const dir = await tempDir(t);
  assert.deepEqual(loadConfig(join(dir, 'none.json')), defaults());
  const file = join(dir, 'bad.json');
  await writeFile(file, '{ "backend": "SECRET_VALUE", ');
  assert.throws(() => loadConfig(file), error => /not readable as JSON/.test((error as Error).message) && !/SECRET_VALUE/.test((error as Error).message));
  await writeFile(file, JSON.stringify({ backend: 'codex', maxImages: 2 }));
  assert.equal(loadConfig(file).backend, 'codex');
});
