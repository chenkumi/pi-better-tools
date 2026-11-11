import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLogin, resolveApiKey } from '../src/auth.ts';

const ctx = (registry: unknown) => ({ modelRegistry: registry }) as never;
const registry = (options: { oauth?: boolean; key?: string; source?: string; calls?: string[] }) => ({
  getAll: () => [{ provider: 'openai' }, { provider: 'google' }],
  isUsingOAuth: () => options.oauth === true,
  getProviderAuth: async (provider: string) => { options.calls?.push(provider); return options.key ? { auth: { apiKey: options.key }, source: options.source } : undefined; },
});

test('an API key stored in Pi is used; the provider is openai for OpenAI and google for Gemini', async () => {
  const calls: string[] = [];
  assert.equal(await resolveApiKey(ctx(registry({ key: ' sk-live ', calls })), 'openai'), 'sk-live');
  assert.equal(await resolveApiKey(ctx(registry({ key: 'AIza', calls })), 'gemini'), 'AIza');
  assert.deepEqual(calls, ['openai', 'google']);
});

test('an OAuth login is refused before anything is resolved, so it is not refreshed and never sent', async () => {
  const calls: string[] = [];
  await assert.rejects(resolveApiKey(ctx(registry({ oauth: true, key: 'oauth-access-token', calls })), 'openai'), /IMAGE_AUTH_MISSING: .*stored login is OAuth/);
  assert.deepEqual(calls, [], 'getProviderAuth was not called');
  await assert.rejects(resolveApiKey(ctx(registry({ key: 'token', source: 'OAuth' })), 'openai'), /IMAGE_AUTH_MISSING: .*OAuth/);
});

test('no key, an empty key and no registry are all "missing", and the message names the Pi provider', async () => {
  await assert.rejects(resolveApiKey(ctx(registry({})), 'gemini'), /IMAGE_AUTH_MISSING: .*provider "google".*no API key is stored/);
  await assert.rejects(resolveApiKey(ctx(registry({ key: '   ' })), 'openai'), /IMAGE_AUTH_MISSING/);
  await assert.rejects(resolveApiKey(ctx(undefined), 'openai'), /no model registry/);
});

test('a registry without getProviderAuth falls back to getApiKeyForProvider', async () => {
  assert.equal(await resolveApiKey(ctx({ getApiKeyForProvider: async () => 'fallback-key' }), 'openai'), 'fallback-key');
});

test('the login description never contains the key', async () => {
  const text = await describeLogin(ctx(registry({ key: 'sk-SECRET' })), 'openai');
  assert.equal(text, 'API key found in Pi'); assert.ok(!text.includes('SECRET'));
  assert.match(await describeLogin(ctx(registry({ oauth: true })), 'openai'), /OAuth/);
  assert.equal(await describeLogin(ctx(registry({})), 'codex'), 'n/a');
});
