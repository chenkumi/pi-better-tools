import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAssistantMessageEventStream, type Model, type AssistantMessage } from '@earendil-works/pi-ai';
// Version-pinned compatibility probe: pi internals are never runtime dependencies.
import { processResponsesStream } from '../../../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { captureNativeSources, type NativeSourceRecord } from '../../src/native-sources.ts';

const version = JSON.parse(readFileSync(new URL('../../../../node_modules/@earendil-works/pi-ai/package.json', import.meta.url), 'utf8')).version as string;
test(`pi ${version}: normalized annotation-only URLs are lost; newer stream hook enables allowlisted side-channel`, async () => {
  const model: Model<'openai-responses'> = {
    id: 'fixture', name: 'Fixture', provider: 'openai', api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const explicitUrl = 'https://explicit.example/source', hiddenUrl = 'https://annotation-only.example/source';
  const message = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{
    type: 'output_text', text: `Answer [source](${explicitUrl})`,
    annotations: [{ type: 'url_citation', url: hiddenUrl, title: 'Hidden source', start_index: 0, end_index: 6 }],
  }] };
  const hosted = { type: 'web_search_call', id: 'ws_test', status: 'completed', action: { type: 'search', queries: ['SECRET_QUERY'], sources: [{ type: 'url', url: hiddenUrl }] } };
  async function* events() {
    yield { type: 'response.output_item.added', output_index: 0, item: hosted };
    yield { type: 'response.output_item.done', output_index: 0, item: hosted };
    yield { type: 'response.output_item.done', output_index: 1, item: message };
    yield { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [hosted, message] } };
  }
  const output: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: 'stop', timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const sources: NativeSourceRecord[] = [];
  let callbackEvents = 0;
  const options: NonNullable<Parameters<typeof processResponsesStream>[4]> & { onProviderStreamEvent: (data: unknown) => Promise<void> } = {
    async onProviderStreamEvent(data) {
      callbackEvents++;
      const captured = captureNativeSources({ api: model.api, provider: model.provider, model: model.id, data });
      if (captured) sources.push(captured);
    },
  };
  await processResponsesStream(events() as unknown as Parameters<typeof processResponsesStream>[0], output, createAssistantMessageEventStream(), model, options);
  assert.ok(JSON.stringify(output).includes(explicitUrl));
  assert.ok(!JSON.stringify(output).includes(hiddenUrl), 'If pi starts preserving annotations, update guidance and this probe.');
  if (['0.99.1', '0.99.2', '1.0.0'].includes(version)) {
    assert.equal(callbackEvents, 4);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.responseId, 'resp_test');
    assert.equal(sources[0]!.sources[0]!.url, hiddenUrl);
    assert.equal(sources[0]!.citations[0]!.url, hiddenUrl);
    assert.ok(!JSON.stringify(sources).includes('SECRET_QUERY'));
  } else {
    assert.equal(version, '0.85.1', 'Add an explicit version contract before claiming support.');
    assert.equal(callbackEvents, 0);
    assert.deepEqual(sources, []);
  }
});
