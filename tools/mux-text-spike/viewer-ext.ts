// Spike: interactive Pi child with stripped TUI + a side data channel. Offline provider, no network.
import { connect } from 'node:net';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const empty = { render: () => [] as string[], invalidate() {} };
class NullEditor {
  text = ''; onSubmit?: (t: string) => void; onChange?: (t: string) => void;
  render() { return [] as string[]; } invalidate() {}
  getText() { return this.text; } setText(t: string) { this.text = t; } handleInput() {}
}
// Fixed usage per request so the totals are predictable.
const usage = () => ({ input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
const textOf = (m: any) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((b: any) => b.text ?? '').join('');

export default function (pi: ExtensionAPI) {
  pi.registerProvider('spike', { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'dummy', api: 'spike-api',
    models: [{ id: 'fixture', name: 'Spike', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter((m: any) => m.role === 'user').map(textOf);
      const asked = users.at(-1) ?? '';
      const message: any = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [], stopReason: 'stop', usage: usage(), timestamp: Date.now() };
      const finish = (reason: 'stop' | 'aborted') => {
        message.stopReason = reason;
        if (reason === 'aborted') stream.push({ type: 'error', reason: 'aborted', error: message });
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      };
      setImmediate(() => {
        stream.push({ type: 'start', partial: message });
        const lastMessage: any = context.messages.at(-1);
        if (asked.startsWith('tools') && lastMessage?.role === 'user') { // three tool calls in one assistant turn
          message.content = [1, 2, 3].map(i => ({ type: 'toolCall', id: `nap${i}`, name: 'nap', arguments: { label: `n${i}` } }));
          message.stopReason = 'toolUse';
          message.content.forEach((c: any, i: number) => { stream.push({ type: 'toolcall_start', contentIndex: i, partial: message }); stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: c, partial: message }); });
          stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); return;
        }
        message.content = [{ type: 'text', text: '' }];
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        const slow = asked.startsWith('slow'); const chunks = slow ? 25 : 1; let n = 0;
        const timer = setInterval(() => {
          if (options?.signal?.aborted) { clearInterval(timer); return finish('aborted'); }
          const piece = slow ? `chunk${n} ` : `echo(${users.length} user msgs): ${asked}`;
          message.content[0].text += piece;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: piece, partial: message });
          if (++n >= chunks) {
            clearInterval(timer);
            stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
            finish('stop');
          }
        }, slow ? 120 : 0);
      });
      return stream;
    } });

  pi.registerTool({ name: 'nap', label: 'Nap', executionMode: 'sequential', description: 'Sleep 700ms (spike).', parameters: Type.Object({ label: Type.String() }),
    async execute(_id, args: any) { await new Promise(r => setTimeout(r, 700)); return { content: [{ type: 'text', text: `napped ${args.label}` }], details: {} }; } });

  let socket: ReturnType<typeof connect> | undefined;
  const send = (o: unknown) => { try { socket?.write(JSON.stringify(o) + '\n'); } catch {} };

  pi.on('session_start', async (_e, ctx) => {
    if (ctx.mode === 'tui') {
      ctx.ui.setHeader(() => empty); ctx.ui.setFooter(() => empty);
      if (!process.env.SPIKE_DEFAULTEDITOR) ctx.ui.setEditorComponent(() => new NullEditor() as any);
      ctx.ui.setWorkingVisible(false);
      if (!process.env.SPIKE_NOCONSUME) ctx.ui.onTerminalInput(() => ({ consume: true }) as any);
    }
    // Same arithmetic as AgentSession.getSessionStats(), computed from the read-only session view.
    const stats = () => {
      let userMessages = 0, assistantMessages = 0, toolResults = 0, toolCalls = 0;
      const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const add = (u: any) => { if (!u) return; t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.cost += u.cost?.total ?? 0; };
      for (const e of ctx.sessionManager.getEntries() as any[]) {
        if (e.type === 'usage') add(e.usage); else if ((e.type === 'branch_summary' || e.type === 'compaction') && e.usage) add(e.usage);
        if (e.type !== 'message') continue;
        const m = e.message;
        if (m.role === 'user') userMessages++;
        else if (m.role === 'toolResult') { toolResults++; add(m.usage); }
        else if (m.role === 'assistant') { assistantMessages++; toolCalls += (m.content ?? []).filter((c: any) => c.type === 'toolCall').length; add(m.usage); }
      }
      return { userMessages, assistantMessages, toolResults, toolCalls, tokens: { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite }, contextUsage: ctx.getContextUsage() };
    };
    const port = Number(process.env.SPIKE_PORT);
    if (!port) return;
    socket = connect(port, '127.0.0.1');
    let buf = '';
    socket.on('data', d => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === 'prompt') pi.sendUserMessage(m.text);
          else if (m.type === 'steer') pi.sendUserMessage(m.text, { deliverAs: 'steer' });
          else if (m.type === 'followup') pi.sendUserMessage(m.text, { deliverAs: 'followUp' });
          else if (m.type === 'abort') { send({ type: 'abort_called', idle: ctx.isIdle() }); ctx.abort(); }
          else if (m.type === 'stats') send({ type: 'stats', ...stats() });
        } catch (e) { send({ type: 'error', message: String(e) }); }
      }
    });
    socket.on('error', () => {});
    socket.on('connect', () => send({ type: 'hello', mode: ctx.mode, hasUI: ctx.hasUI }));
  });
  for (const ev of ['agent_start', 'message_end', 'agent_settled'] as const)
    pi.on(ev as any, (e: any) => send({ type: ev, role: e?.message?.role, stop: e?.message?.stopReason, text: textOf(e?.message).slice(0, 80) }));
  pi.on('tool_execution_end' as any, (e: any) => send({ type: 'tool_end', id: e?.toolCallId, error: e?.isError, text: JSON.stringify(e?.result?.content ?? '').slice(0, 80) }));
  pi.on('session_shutdown', () => { try { socket?.end(); } catch {} });
}
