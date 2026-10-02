import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, loadConfig, parseConfig, resolveKey } from '../../src/config.ts';

test('missing configuration defaults to native OpenAI with no subscription opt-in', () => {
  assert.deepEqual(parseConfig({}), defaults());
  assert.equal(defaults().providers.openai.captureSources, false);
  assert.deepEqual(loadConfig('/does-not-exist/pi-web-tools.json'), defaults());
});
test('credentials explicit and mutually exclusive, validation never echoes secret values', () => {
  assert.throws(() => parseConfig({ providers: { brave: { apiKey: 'SECRET', apiKeyEnv: 'KEY' } } }), /mutually exclusive/);
  assert.equal(resolveKey({ apiKeyEnv: 'KEY' }, { KEY: ' abc ' }), 'abc');
  assert.throws(() => resolveKey({ apiKeyEnv: 'KEY' }, {}), /AUTH_REQUIRED/);
  assert.throws(() => parseConfig({ providers: { brave: { apiKeyEnv: '!echo secret' } } }), /apiKeyEnv/);
  for (const value of [{ provider: 'SECRET' }, { enabled: 1 }, { version: 2 }, { fetch: { maxConcurrency: 50 } }, { SECRET: 'SECRET' }]) {
    assert.throws(() => parseConfig(value), (e: Error) => e.message.includes('CONFIG_INVALID') && !e.message.includes('SECRET'));
  }
});
test('invalid JSON does not expose config contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-web-config-test-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{"apiKey":"SECRET",}');
    assert.throws(() => loadConfig(join(dir, 'config.json')), (e: Error) => !e.message.includes('SECRET') && /invalid JSON/.test(e.message));
  } finally { rmSync(dir, { recursive: true }); }
});
test('partial fetch override retains defaults and OpenAI keys are rejected', () => {
  assert.equal(parseConfig({ fetch: { channel: 'chrome' } }).fetch.timeoutMs, 30000);
  assert.throws(() => parseConfig({ providers: { openai: { apiKey: 'SECRET' } } }), /unknown field/);
  assert.equal(parseConfig({ providers: { openai: { experimentalCodex: true } } }).providers.openai.experimentalCodex, true);
  assert.equal(parseConfig({ providers: { openai: { captureSources: true } } }).providers.openai.captureSources, true);
  assert.throws(() => parseConfig({ providers: { openai: { captureSources: 'SECRET' } } }), (e: Error) => /captureSources/.test(e.message) && !e.message.includes('SECRET'));
  for (const path of ['', 'relative/SECRET.json']) assert.throws(() => loadConfig(path), (e: Error) => /path must be absolute/.test(e.message) && !e.message.includes('SECRET'));
});
