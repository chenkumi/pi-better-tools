// Test-only synthetic provider. No credentials, paid models or network allowed.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error('Network forbidden in JSON Schema fixture'); };
  const scenario = process.env.JSON_SCHEMA_SCENARIO ?? 'tool';
  let calls = 0;
  if (scenario === 'signal') pi.on('agent_settled', () => { process.emit('SIGTERM'); });
  if (scenario.startsWith('virtual')) pi.registerVirtualModel({ provider: 'json-router', id: 'auto', name: 'Offline router',
    route(_request, ctx) { return { model: ctx.modelRegistry.find('json-offline', 'fixture')!, thinkingLevel: 'off' }; } });
  pi.on('session_shutdown', () => { appendFileSync(join(process.cwd(), 'cleaned.txt'), 'cleaned\n'); console.log('FIXTURE_CLEANUP_LOG'); });
  pi.registerProvider('json-offline', {
    api: 'openai-responses', apiKey: 'offline-non-secret', baseUrl: 'http://unused.invalid',
    models: [{ id: 'fixture', name: 'JSON offline fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 100000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setImmediate(async () => {
        try {
          const nth = ++calls;
          const payload: any = await options?.onPayload?.({ fixture: true, tools: getCurrentTools(context.messages) }, model) ?? {};
          appendFileSync(join(process.cwd(), 'requests.jsonl'), JSON.stringify({ nth, tools: getCurrentTools(context.messages).map(t => t.name), payload, scenario }) + '\n');
          console.log('FIXTURE_PROGRESS_LOG');
          if (nth > 2) throw new Error('Unexpected extra model call');
          const data = { name: scenario === 'large' ? '中文😀'.repeat(100000) : 'Acme', count: 5 };
          const call = (args: unknown, id = 'result', name = 'json_output') => ({ type: 'toolCall', name, id, arguments: args });
          if (scenario === 'error' || scenario === 'aborted') { message.stopReason = scenario; message.errorMessage = 'Synthetic upstream failure'; stream.push({ type: 'error', reason: scenario, error: message }); stream.end(); return; }
          if (['tool', 'large', 'invalid-tool', 'duplicate', 'conflict', 'mixed'].includes(scenario) || nth === 2 && !['fallback-fail', 'fallback-text', 'fallback-wrong'].includes(scenario)) {
            message.content = [call(scenario === 'invalid-tool' ? { name: 'Acme' } : data)];
            if (scenario === 'duplicate') message.content.push(call(data, 'second'));
            if (scenario === 'conflict') message.content.push(call({ name: 'Other', count: 6 }, 'second'));
            if (scenario === 'mixed') message.content.unshift({ type: 'text', text: 'Here is the result; this prose must not pollute stdout.' });
            message.stopReason = 'toolUse';
          } else if (scenario === 'fallback-wrong' && nth === 2) { message.content = [call(data, 'wrong', 'other_tool')]; message.stopReason = 'toolUse'; }
          else message.content = scenario === 'empty' ? [] : [{ type: 'text', text:
            ['text', 'inactive', 'signal'].includes(scenario) ? JSON.stringify(data) : scenario === 'fenced' ? `Result:\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` :
            scenario === 'overflow' ? '{"name":"Acme","count":1e400}' : scenario === 'invalid-text' ? '{"name":"Acme"}' : scenario === 'null' ? 'null' : scenario === 'fallback-text' && nth === 2 ? JSON.stringify(data) : 'Acme count is five.' }];
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
