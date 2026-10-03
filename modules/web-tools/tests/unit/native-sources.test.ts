import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureNativeSources, readSourceRecord, MAX_SOURCE_BYTES, MAX_SOURCE_ENTRIES, type ParsedProviderEvent } from '../../src/native-sources.ts';

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
