// Deterministic offline provider shared by a root Pi and its Fork / Subagent children (each a real Pi process). No network.
// Root: DO_FORK / DO_SUBAGENT start a child, anything else ends with PARENT_DONE. Child: probe with `read` until done; when it
// receives the automatic compaction notice it answers through the progress_checkpoint tool. Usage grows 7k tokens per assistant
// message in context, so the notice zone (75k to 95k of a 100k window with a 5k reserve) is reached after about ten probes.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const text = (m: any) => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''));
const PROBES = 11;

export default function (pi: ExtensionAPI) {
  pi.registerProvider('children-offline', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-dummy', api: 'children-offline-api',
    models: [{ id: 'm', name: 'Children offline', reasoning: false, input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const messages = context.messages as any[];
      const users = messages.filter(m => m.role === 'user').map(text);
      const last = messages.at(-1);
      const lastUser = last?.role === 'user' ? text(last) : '';
      const assistants = messages.filter(m => m.role === 'assistant').length;
      const isForkChild = users.some(t => t.startsWith('You are the background Fork.'));
      const isSubagentChild = !isForkChild && users.some(t => t.includes('SUBAGENT_CHECKPOINT_TASK'));
      const isChild = isForkChild || isSubagentChild;
      const probes = messages.filter(m => m.role === 'toolResult' && m.toolName === 'read').length;
            const call = (id: string, name: string, args: Record<string, unknown>) => [{ type: 'toolCall', id, name, arguments: args }];
      let content: any[], stopReason = 'stop';
      if (!isChild && lastUser.includes('DO_FORK')) { content = call('fork-1', 'fork', { task: 'FORK_CHECKPOINT_TASK probe repeatedly', title: 'checkpoint fork' }); stopReason = 'toolUse'; }
      else if (!isChild && lastUser.includes('DO_SUBAGENT')) { content = call('subagent-1', 'subagent', { agent: 'scout', task: 'SUBAGENT_CHECKPOINT_TASK probe repeatedly' }); stopReason = 'toolUse'; }
      else if (!isChild) content = [{ type: 'text', text: 'PARENT_DONE' }];
      else if (lastUser.includes('compaction will happen soon')) { content = call(`checkpoint-${assistants}`, 'progress_checkpoint', { summary: 'Probed several times; more probing next.' }); stopReason = 'toolUse'; }
      else if (probes < PROBES) { content = call(`probe-${assistants}`, 'read', { path: 'probe.txt' }); stopReason = 'toolUse'; }
      else content = [{ type: 'text', text: 'CHILD_DONE' }];
      const tokens = 7_000 * (assistants + 1);
      const message: any = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: tokens, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason as 'stop', message }); stream.end(); });
      return stream;
    },
  });
}
