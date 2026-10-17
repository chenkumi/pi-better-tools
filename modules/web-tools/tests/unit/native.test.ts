import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, type Config } from '../../src/config.ts';
import { GEMINI_GUIDANCE, injectGeminiSearch, supportsGeminiNativeSearch } from '../../src/native-google.ts';
import { ANTHROPIC_GUIDANCE, injectAnthropicSearch, supportsAnthropicNativeSearch } from '../../src/native-anthropic.ts';
import { NATIVE_GUIDANCE_BY_ADAPTER, NATIVE_GUIDANCES, injectNative, isNativeProvider, nativeInactiveReason, selectNative } from '../../src/native.ts';
import { NATIVE_GUIDANCE } from '../../src/native-openai.ts';

const config = (provider: Config['provider']) => { const c = defaults(); c.provider = provider; return c; };
const gemini = (id: string, provider = 'google') => ({ api: 'google-generative-ai', provider, id });
const anthropic = (provider = 'anthropic') => ({ api: 'anthropic-messages', provider, id: 'claude-haiku-4-5' });

test('adapter selection keeps the openai scope and adds Gemini only for provider native', () => {
  const openai = { api: 'openai-responses', provider: 'openai' };
  assert.equal(selectNative(config('openai'), openai), 'openai');
  assert.equal(selectNative(config('native'), openai), 'openai');
  assert.equal(selectNative(config('openai'), gemini('gemini-3-pro')), undefined, 'provider openai keeps its original scope');
  for (const id of ['gemini-3-pro', 'gemini-3.8-flash', 'gemini-4-argon']) assert.equal(selectNative(config('native'), gemini(id)), 'google', id);
  assert.equal(selectNative(config('native'), anthropic()), 'anthropic');
  assert.equal(selectNative(config('openai'), anthropic()), undefined, 'provider openai keeps its original scope');
  assert.equal(selectNative(config('native'), anthropic('kimi-coding')), undefined, 'Anthropic-compatible endpoints stay excluded');
  assert.equal(selectNative(config('native'), { api: 'anthropic-messages', provider: 'deepseek', id: 'deepseek-v4-pro' }), undefined);
  for (const model of [gemini('gemini-2.5-pro'), gemini('gemini-2.5-flash'), gemini('gemini-3-pro', 'proxy'), gemini('gemini-3-pro', 'google-vertex'),
    { api: 'google-vertex', provider: 'google-vertex', id: 'gemini-3-pro' }, undefined]) {
    assert.equal(selectNative(config('native'), model), undefined);
  }
  for (const provider of ['brave', 'exa', 'deepseek'] as const) assert.equal(selectNative(config(provider), gemini('gemini-3-pro')), undefined);
  const disabled = config('native'); disabled.enabled = false;
  assert.equal(selectNative(disabled, gemini('gemini-3-pro')), undefined);
  assert.equal(isNativeProvider('openai'), true);
  assert.equal(isNativeProvider('native'), true);
  for (const provider of ['brave', 'exa', 'deepseek'] as const) assert.equal(isNativeProvider(provider), false);
});

test('Gemini injection is additive, camelCase, immutable and idempotent', () => {
  const payload = { model: 'gemini-3-pro', contents: [], config: {
    temperature: 0.2, tools: [{ functionDeclarations: [{ name: 'web_fetch' }] }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } };
  const snapshot = structuredClone(payload);
  const result = injectGeminiSearch(payload) as typeof payload;
  assert.deepEqual(payload, snapshot);
  assert.deepEqual(result.config.tools, [{ functionDeclarations: [{ name: 'web_fetch' }] }, { googleSearch: {} }]);
  assert.deepEqual(result.config.toolConfig, { functionCallingConfig: { mode: 'AUTO' }, includeServerSideToolInvocations: true });
  assert.equal(result.config.temperature, 0.2);
  assert.deepEqual(injectGeminiSearch(result), result);
});

test('Gemini injection fails closed on unexpected payloads and never drops a local web_search', () => {
  assert.deepEqual(injectGeminiSearch({ config: {} }), { config: { tools: [{ googleSearch: {} }], toolConfig: { includeServerSideToolInvocations: true } } });
  for (const payload of [{ config: 'invalid' }, { config: { tools: 'invalid' } }, { config: { toolConfig: 'invalid' } }]) {
    assert.throws(() => injectGeminiSearch(payload), /PROVIDER_UNSUPPORTED/);
  }
  const conflict = { config: { tools: [{ functionDeclarations: [{ name: 'web_search' }] }] } };
  assert.throws(() => injectGeminiSearch(conflict), /TOOL_CONFLICT/);
  assert.deepEqual(conflict.config.tools, [{ functionDeclarations: [{ name: 'web_search' }] }]);
  assert.deepEqual((injectNative('openai', { tools: [] }) as { tools: unknown[] }).tools, [{ type: 'web_search' }]);
  assert.equal(supportsGeminiNativeSearch(gemini('gemini-3-pro')), true);
  assert.equal(supportsGeminiNativeSearch(gemini('gemini-3-pro', 'local')), false);
  assert.ok(NATIVE_GUIDANCES.includes(GEMINI_GUIDANCE));
  assert.equal(NATIVE_GUIDANCE_BY_ADAPTER.google, GEMINI_GUIDANCE);
  assert.equal(NATIVE_GUIDANCE_BY_ADAPTER.openai, NATIVE_GUIDANCE);
});

test('Anthropic injection is additive, idempotent and never silently drops a local web_search', () => {
  const payload = { model: 'claude-haiku-4-5', max_tokens: 300, tools: [{ name: 'web_fetch', input_schema: {} }], tool_choice: { type: 'auto' } };
  const snapshot = structuredClone(payload);
  const result = injectAnthropicSearch(payload) as typeof payload;
  assert.deepEqual(payload, snapshot);
  assert.deepEqual(result.tools, [{ name: 'web_fetch', input_schema: {} }, { type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]);
  assert.deepEqual(result.tool_choice, { type: 'auto' });
  assert.deepEqual(injectAnthropicSearch(result), result);
  assert.deepEqual((injectAnthropicSearch({}) as { tools: unknown[] }).tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]);
  assert.deepEqual((injectAnthropicSearch({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] }) as { tools: unknown[] }).tools,
    [{ type: 'web_search_20260209', name: 'web_search' }], 'a caller-supplied native version is kept');
  assert.throws(() => injectAnthropicSearch({ tools: 'invalid' }), /PROVIDER_UNSUPPORTED/);
  const conflict = { tools: [{ name: 'web_search', input_schema: {} }] };
  assert.throws(() => injectAnthropicSearch(conflict), /TOOL_CONFLICT/);
  assert.deepEqual(conflict.tools, [{ name: 'web_search', input_schema: {} }]);
  assert.deepEqual((injectNative('anthropic', { tools: [] }) as { tools: unknown[] }).tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]);
  assert.equal(supportsAnthropicNativeSearch(anthropic()), true);
  assert.equal(supportsAnthropicNativeSearch(anthropic('kimi-coding')), false);
  assert.equal(NATIVE_GUIDANCE_BY_ADAPTER.anthropic, ANTHROPIC_GUIDANCE);
  assert.deepEqual(NATIVE_GUIDANCES, [NATIVE_GUIDANCE, GEMINI_GUIDANCE, ANTHROPIC_GUIDANCE]);
});

test('inactive reasons stay specific for the new modes', () => {
  assert.equal(nativeInactiveReason(config('brave'), gemini('gemini-3-pro')), 'REST search selected');
  assert.match(nativeInactiveReason(config('openai'), gemini('gemini-3-pro')), /set "provider": "native"/);
  assert.match(nativeInactiveReason(config('native'), gemini('gemini-2.5-pro')), /Gemini 2\.x/);
  assert.match(nativeInactiveReason(config('native'), { api: 'google-vertex', provider: 'google-vertex', id: 'gemini-3-pro' }), /Vertex AI/);
  assert.match(nativeInactiveReason(config('native'), anthropic('kimi-coding')), /Anthropic-compatible endpoints are excluded/);
  assert.match(nativeInactiveReason(config('openai'), anthropic()), /set "provider": "native"/);
  assert.match(nativeInactiveReason(config('native'), { api: 'openai-completions', provider: 'deepseek', id: 'deepseek-chat' }), /model\/API is unsupported/);
  assert.match(nativeInactiveReason(config('native'), { api: 'pi-virtual', provider: 'router', id: 'auto' }), /virtual routing/);
});
