import { existsSync, writeFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
const contentText = (m: any) => typeof m.content === 'string' ? m.content : m.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') ?? '';
export default function offlineProvider(pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error('External service calls forbidden in Monitor offline fixture'); };
  pi.on('before_provider_request', () => {
    if ((globalThis as any).__piSubagentsGuardExpected?.shellMode === 'foreground-v1') {
      const names = pi.getAllTools().map(t => t.name);
      if (names.some(n => n.startsWith('monitor_'))) throw new Error('Managed child registered Monitor');
      writeFileSync(join(process.cwd(), 'monitor-child-tools.json'), JSON.stringify(names));
    }
  });
  pi.registerTool({ name: 'barrier', label: 'Barrier', description: 'Offline event barrier', parameters: Type.Object({}), async execute(_id, _args, signal, _update, ctx) {
    const release = join(ctx.cwd, 'release-child');
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => { if (done) return; done = true; observer.close(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(new Error('barrier canceled'));
      const observer = watch(ctx.cwd, () => { if (existsSync(release)) finish(); });
      signal?.addEventListener('abort', abort, { once: true }); writeFileSync(join(ctx.cwd, 'child-ready'), 'ready');
      if (existsSync(release)) finish(); else if (signal?.aborted) abort();
    });
    return { content: [{ type: 'text', text: 'barrier released' }], details: {} };
  } });
  pi.registerProvider('monitor-fixture', { api: 'monitor-fixture-api', baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-not-secret',
    models: [{ id: 'fixture', name: 'Offline Monitor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const hold = context.messages.some(m => m.role === 'user' && contentText(m).includes('hold-child')) && !context.messages.some(m => m.role === 'toolResult' && m.toolName === 'barrier');
        const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: hold ? [{ type: 'toolCall', id: 'monitor-barrier', name: 'barrier', arguments: {} }] : [{ type: 'text', text: 'offline complete' }], stopReason: hold ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          await options?.onPayload?.({ model: model.id, tools: [], stream: true }, model);
          stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) { stream.push({ type: 'error', reason: 'error', error: { ...message, content: [], stopReason: 'error', errorMessage: String(error) } }); }
        finally { stream.end(); }
      }); return stream;
    },
  });
}
