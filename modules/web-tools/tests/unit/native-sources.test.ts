import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureGroundingSources, captureNativeSources, readSourceRecord, MAX_SOURCE_BYTES, MAX_SOURCE_ENTRIES, type ParsedProviderEvent } from '../../src/native-sources.ts';

export function sourceEvent(id = 'resp_test', sources: unknown[] = [{ url: 'https://source.example/', title: 'Source' }]): ParsedProviderEvent {
  return { provider: 'openai', api: 'openai-responses', model: 'fixture', data: {
    type: 'response.completed', response: { id, status: 'completed', input: 'SECRET_BODY', headers: { authorization: 'SECRET_AUTH' }, output: [
      { type: 'web_search_call', action: { queries: ['SECRET_QUERY'], sources } },
      { type: 'message', content: [{ type: 'output_text', text: 'SECRET_ANSWER', annotations: [
        { type: 'url_citation', url: 'https://citation.example/', title: 'Citation', start_index: 0, end_index: 6, extra: 'SECRET_ANNOTATION' },
      ] }] },
    ] },
  } };
}

test('terminal source capture is immutable, allowlisted, deduplicated, and separates citations', () => {
  const event = sourceEvent('resp_test', [{ url: 'https://source.example/', title: 'First' }, { url: 'https://source.example/', title: 'Second' }]);
  const snapshot = structuredClone(event);
  const result = captureNativeSources(event)!;
  assert.deepEqual(result.sources, [{ url: 'https://source.example/', title: 'First' }]);
  assert.deepEqual(result.citations, [{ url: 'https://citation.example/', title: 'Citation', startIndex: 0, endIndex: 6 }]);
  assert.equal(result.responseId, 'resp_test');
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(event, snapshot);
  assert.deepEqual(readSourceRecord(result), result);
});

test('source capture rejects unsafe URLs and control characters, keeps validated offsets only', () => {
  const event = sourceEvent('resp_test', [null, {}, { url: 'file:///etc/passwd' }, { url: 'https://user:SECRET@example.com/' },
    { url: 'https://example.com/\u001b' }, { url: `https://example.com/${'x'.repeat(2048)}` },
    { url: 'https://clean.example/', title: '\u001bTest\n title' }]);
  const result = captureNativeSources(event)!;
  assert.deepEqual(result.sources, [{ url: 'https://clean.example/', title: 'Test  title' }]);
  const edited = { ...result, citations: [{ url: 'https://citation.example/', startIndex: -1, endIndex: Infinity, raw: 'SECRET' }] };
  assert.deepEqual(readSourceRecord(edited)!.citations, [{ url: 'https://citation.example/' }]);
});

test('source capture is bounded by entry count and serialized bytes, including Unicode', () => {
  for (const sources of [Array.from({ length: 200 }, (_, i) => ({ url: `https://source.example/${i}` })),
    Array.from({ length: 50 }, (_, i) => ({ url: `https://source.example/${i}/${'x'.repeat(1600)}`, title: '中'.repeat(300) }))]) {
    const result = captureNativeSources(sourceEvent('resp_bounded', sources))!;
    assert.ok(result.truncated);
    assert.ok(result.sources.length + result.citations.length <= MAX_SOURCE_ENTRIES);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_SOURCE_BYTES);
    assert.deepEqual(readSourceRecord(result), result);
  }
});

test('capture gates actual provider/API; Azure and Codex allowed without extra opt-in', () => {
  const event = sourceEvent();
  assert.ok(captureNativeSources({ ...event, provider: 'azure-openai-responses', api: 'azure-openai-responses' }));
  assert.equal(captureNativeSources({ ...event, provider: 'router', api: 'pi-virtual' }), undefined);
  assert.equal(captureNativeSources({ ...event, provider: 'custom-proxy' }), undefined);
  const codex = { ...event, provider: 'openai-codex', api: 'openai-codex-responses' };
  assert.ok(captureNativeSources(codex));
  assert.equal(captureNativeSources({ ...codex, provider: 'custom-proxy' }), undefined);
});

test('nonterminal/failed/malformed responses and mismatched terminal status are ignored', () => {
  for (const data of [null, [], {}, { type: 'response.output_item.done', item: {} },
    { type: 'response.failed', response: { id: 'resp', status: 'failed' } },
    { type: 'response.completed', response: { id: 'resp', status: 'incomplete' } },
    { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [] } }]) {
    assert.equal(captureNativeSources({ ...sourceEvent(), data }), undefined);
  }
  assert.equal(readSourceRecord({ version: 999, raw: 'SECRET' }), undefined);
  const result = captureNativeSources(sourceEvent())!;
  assert.equal(readSourceRecord({ ...result, sources: Array(51).fill(result.sources[0]) }), undefined);
});

const groundingEvent = (overrides: Record<string, unknown> = {}): ParsedProviderEvent => ({ provider: 'google', api: 'google-generative-ai', model: 'gemini-4-argon', data: {
  candidates: [{ content: { parts: [{ text: 'SECRET_ANSWER' }] }, groundingMetadata: {
    webSearchQueries: ['SECRET_QUERY'],
    groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'First Source' } },
      { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'Duplicate' } },
      { web: { uri: 'https://origin.example/page', title: 'Origin' } }, { web: { uri: 'file:///etc/passwd' } }, {}],
    groundingSupports: [{ segment: { startIndex: 4, endIndex: 17 }, groundingChunkIndices: [2] },
      { segment: { startIndex: 0, endIndex: 4 }, groundingChunkIndices: [0] }, { groundingChunkIndices: [0, 99] }],
    searchEntryPoint: { renderedContent: '<style>SECRET_HTML</style>' },
  } }], responseId: 'resp_grounding', usageMetadata: { promptTokenCount: 12 }, ...overrides } });

test('grounding capture keeps only bounded sources and offset citations, never queries or raw events', () => {
  const event = groundingEvent();
  const snapshot = structuredClone(event);
  const result = captureGroundingSources(event)!;
  assert.deepEqual(event, snapshot, 'input is not mutated');
  assert.equal(result.api, 'google-generative-ai');
  assert.equal(result.provider, 'google');
  assert.equal(result.model, 'gemini-4-argon');
  assert.equal(result.responseId, 'resp_grounding');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.sources, [
    { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'First Source' },
    { url: 'https://origin.example/page', title: 'Origin' },
  ]);
  assert.deepEqual(result.citations, [
    { url: 'https://origin.example/page', title: 'Origin', startIndex: 4, endIndex: 17 },
    { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'First Source', startIndex: 0, endIndex: 4 },
    { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'First Source' },
  ]);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'), 'queries, answer text and search-entry HTML are never persisted');
  assert.deepEqual(readSourceRecord(result), result);
});

test('grounding capture gates on the exact api, provider and model family, and needs a response id', () => {
  for (const identity of [
    { provider: 'proxy', api: 'google-generative-ai', model: 'gemini-4-argon' },
    { provider: 'google', api: 'openai-responses', model: 'gemini-4-argon' },
    { provider: 'google-generative-ai', api: 'google-generative-ai', model: 'gemini-4-argon' },
  ]) assert.equal(captureGroundingSources({ ...groundingEvent(), ...identity }), undefined, JSON.stringify(identity));
  assert.equal(captureGroundingSources({ ...groundingEvent(), model: 'gemini-2.5-pro' }), undefined, 'Gemini 2.x is not captured');
  assert.notEqual(captureGroundingSources({ ...groundingEvent(), model: 'gemini-3.8-flash' }), undefined);
  assert.equal(captureGroundingSources(groundingEvent({ responseId: undefined })), undefined);
  assert.equal(captureGroundingSources(groundingEvent({ responseId: 'x'.repeat(300) })), undefined);
  assert.equal(captureGroundingSources({ ...groundingEvent(), data: { candidates: [{ content: { parts: [] } }], responseId: 'resp' } }), undefined);
  assert.equal(captureGroundingSources({ ...groundingEvent(), data: { candidates: [], responseId: 'resp' } }), undefined);
  assert.equal(captureGroundingSources({ ...groundingEvent(), data: { candidates: [{ groundingMetadata: { groundingChunks: [{ web: {} }] } }], responseId: 'resp' } }), undefined);
});

test('grounding capture bounds entry count and byte size, dropping unsafe URLs', () => {
  const many = Array.from({ length: MAX_SOURCE_ENTRIES + 10 }, (_, index) => ({ web: { uri: `https://source.example/${index}`, title: `Source ${index}` } }));
  const result = captureGroundingSources(groundingEvent({ candidates: [{ groundingMetadata: { groundingChunks: many } }] }))!;
  assert.equal(result.sources.length, MAX_SOURCE_ENTRIES);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_SOURCE_BYTES);
  const wide = groundingEvent({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: `https://source.example/${'a'.repeat(2100)}` } }] } }] });
  assert.equal(captureGroundingSources(wide), undefined, 'a URL over the per-source limit is dropped');
});
