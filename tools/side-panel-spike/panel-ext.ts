// Spike: can an extension carve a right-hand column out of Pi's fullscreen TUI? Wrap the layout root in an HStack.
// Offline echo provider so the conversation can be driven without a real model.
import { appendFileSync } from 'node:fs';
import { HStack } from '@earendil-works/pi-tui';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PANEL_WIDTH = Number(process.env.SPIKE_PANEL_WIDTH ?? 30);
const log = (message: string) => { if (process.env.SPIKE_LOG) appendFileSync(process.env.SPIKE_LOG, `${message}\n`); };
const textOf = (m: any) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((b: any) => b.text ?? '').join('');
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export default function (pi: ExtensionAPI) {
  pi.registerProvider('spike', { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'dummy', api: 'spike-api',
    models: [{ id: 'fixture', name: 'Spike', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const asked = textOf([...context.messages].reverse().find((m: any) => m.role === 'user'));
      const content = `echo: ${asked} — a long answer line meant to wrap when the conversation column is narrow, so wrapping can be observed`;
      const message: any = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [{ type: 'text', text: content }], stopReason: 'stop', usage: usage(), timestamp: Date.now() };
      setImmediate(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content, partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    } });

  let installed = false;
  const install = (tui: any, theme: any) => {
    if (installed || process.env.SPIKE_NOPANEL) return; installed = true;
    const original = tui.layoutRoot; // private field: the only handle to the root Pi built
    log(`install: viewportTUI=${typeof tui.setLayoutRoot} mode=${tui.mode} originalRoot=${original?.constructor?.name} rows=${tui.terminal?.rows} cols=${tui.terminal?.columns}`);
    if (typeof tui.setLayoutRoot !== 'function' || !original) { log('install: no layout root to wrap'); return; }
    let ticks = 0;
    const panel = {
      invalidate() {},
      render(width: number): string[] {
        const rows = Math.max(1, tui.terminal?.rows ?? 24);
        const body = ['PANEL', `width=${width}`, `rows=${rows}`, `renders=${++ticks}`, '', 'jobs: (none)'];
        return Array.from({ length: rows }, (_, i) => theme.fg?.('dim', `│ ${(body[i] ?? '').padEnd(Math.max(0, width - 2)).slice(0, Math.max(0, width - 2))}`) ?? `│ ${body[i] ?? ''}`);
      },
    };
    tui.setLayoutRoot(new HStack([{ component: original, grow: 1, shrink: 1 }, { component: panel, basis: PANEL_WIDTH, grow: 0, shrink: 0 }], { gap: 0 }));
    log('install: layout root replaced');
  };
  pi.on('session_start', (_e, ctx) => {
    if (ctx.mode !== 'tui') return;
    // Factories receive the live TUI instance; use one only as a way to get hold of it.
    ctx.ui.setHeader((tui, theme) => { queueMicrotask(() => { try { install(tui, theme); } catch (e) { log(`install failed: ${String(e)}`); } }); return { render: () => [], invalidate() {} }; });
  });
}
