import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi: any) {
  globalThis.fetch = async () => { throw new Error('Network forbidden in review probe'); };
  const spec = JSON.parse(readFileSync(process.env.REVIEW_JSON_SPEC!, 'utf8'));
  const log = (value: unknown) => appendFileSync(join(process.cwd(), 'observations.jsonl'), JSON.stringify(value) + '\n');
  let calls = 0;
  pi.on('tool_execution_start', (e: any) => { log({ phase: 'execute-start', toolName: e.toolName, args: e.args }); });
  pi.on('tool_result', (e: any) => { log({ phase: 'tool-result', toolName: e.toolName, input: e.input, isError: e.isError }); });
  pi.on('session_shutdown', () => { log({ phase: 'shutdown' }); });
  pi.registerProvider('review-json', {
    api: 'openai-responses', apiKey: 'offline-non-secret', baseUrl: 'http://unused.invalid',
    models: [{ id: 'fixture', name: 'Review offline fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setImmediate(async () => {
        try {
          const nth = ++calls;
          await options?.onPayload?.({ review: true }, model);
          log({ phase: 'provider', nth, mode: spec.mode, rawData: spec.data });
          console.error(`Progress: offline response ${nth} for ${spec.id}`);
          if (options?.signal?.aborted) throw new Error('Probe cancelled');
          if (nth > 2) throw new Error('Unexpected extra request');
          const block = spec.mode === 'tool' && nth === 1 ? { type: 'toolCall', id: 'review-result', name: 'json_output', arguments: spec.data } : { type: 'text', text: JSON.stringify(spec.data) };
          message.content = [block]; message.stopReason = block.type === 'toolCall' ? 'toolUse' : 'stop';
          stream.push({ type: 'start', partial: message });
          if (block.type === 'toolCall') {
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message });
          } else {
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        } catch (error) {
          message.stopReason = 'error'; message.errorMessage = String(error);
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
        }
      });
      return stream;
    }
  });
}
