import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectNativeSearch, supportsNativeSearch } from '../../src/native-openai.ts';

test('native injection is additive, immutable and idempotent', () => {
  const original = { tools: [{ type: 'function', name: 'web_fetch' }], include: ['reasoning.encrypted_content'], tool_choice: 'auto', stream: true };
  const snapshot = structuredClone(original);
  const result = injectNativeSearch(original) as typeof original;
  assert.deepEqual(original, snapshot);
  assert.deepEqual(result.tools, [...original.tools, { type: 'web_search' }]);
  assert.equal(result.tool_choice, 'auto');
  assert.deepEqual(result.include, ['reasoning.encrypted_content', 'web_search_call.action.sources']);
  assert.deepEqual(injectNativeSearch(result), result);
});
test('respects native preview and existing tool choice', () => {
  const payload = { tools: [{ type: 'web_search_preview', search_context_size: 'low' }], tool_choice: 'none' };
  const result = injectNativeSearch(payload) as typeof payload;
  assert.deepEqual(result.tools, payload.tools);
  assert.equal(result.tool_choice, 'none');
});
test('local search conflicts are never silently removed', () => {
  for (const tool of [{ type: 'function', name: 'web_search' }, { type: 'function', function: { name: 'web_search' } }]) {
    const payload = { tools: [tool] };
    assert.throws(() => injectNativeSearch(payload), /TOOL_CONFLICT/);
    assert.deepEqual(payload.tools, [tool]);
  }
});
test('only known OpenAI Responses providers enabled, Codex explicitly experimental', () => {
  assert.equal(supportsNativeSearch({ api: 'openai-responses', provider: 'openai' }), true);
  assert.equal(supportsNativeSearch({ api: 'azure-openai-responses', provider: 'azure-openai-responses' }), true);
  const codex = { api: 'openai-codex-responses', provider: 'openai-codex' };
  assert.equal(supportsNativeSearch(codex), false);
  assert.equal(supportsNativeSearch(codex, true), true);
  for (const model of [undefined, { api: 'openai-completions', provider: 'openai' }, { api: 'openai-responses', provider: 'local' }, { api: 'anthropic-messages', provider: 'anthropic' }]) assert.equal(supportsNativeSearch(model, true), false);
});
