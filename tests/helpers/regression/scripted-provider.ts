// Test-only scripted offline provider for defect reproduction. No network, no credentials, no paid models.
// REPRO_SCRIPT: path of a JSON array; step N answers model request N. A step is { content, stopReason? } or { error: "message" }.
// When the script is exhausted a plain text "SCRIPT_EXHAUSTED" answer is returned. Requests are logged to REPRO_LOG (jsonl).
import { appendFileSync, readFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error('Network forbidden in defect-repro fixture'); };
  const script: any[] = JSON.parse(readFileSync(process.env.REPRO_SCRIPT!, 'utf8'));
  const log = process.env.REPRO_LOG!;
  let calls = 0;
  pi.registerProvider('repro-offline', {
    api: 'openai-responses', apiKey: 'offline-non-secret', baseUrl: 'http://unused.invalid',
    models: [{ id: 'fixture', name: 'Repro offline fixture', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 100000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const nth = ++calls;
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setImmediate(() => {
        try {
          appendFileSync(log, JSON.stringify({ nth, messages: context.messages }) + '\n');
          const step = script[nth - 1] ?? { content: [{ type: 'text', text: 'SCRIPT_EXHAUSTED' }] };
          if (step.error) { message.stopReason = 'error'; message.errorMessage = step.error; stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); return; }
          message.content = step.content;
          message.stopReason = step.stopReason ?? (step.content.some((b: any) => b.type === 'toolCall') ? 'toolUse' : 'stop');
          stream.push({ type: 'start', partial: message });
          for (const [i, block] of message.content.entries()) {
            if (block.type === 'toolCall') { stream.push({ type: 'toolcall_start', contentIndex: i, partial: message }); stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: message }); }
            else { stream.push({ type: 'text_start', contentIndex: i, partial: message }); stream.push({ type: 'text_end', contentIndex: i, content: block.text, partial: message }); }
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        } catch (error) { message.stopReason = 'error'; message.errorMessage = String(error); stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); }
      });
      return stream;
    },
  });
}
