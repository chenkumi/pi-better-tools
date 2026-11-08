// Spike: stream a running Fork's live conversation into a right-hand column of the fullscreen TUI.
// Data comes from what the parent already holds: the BackgroundPanel singleton's PanelJob.transcripts (LiveTranscript, fed by the
// child's RPC events). No new channel. The column is rendered with the host's own message components via TranscriptView.
import { appendFileSync } from 'node:fs';
import { HStack, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { acquireBackgroundPanel } from '../../shared/src/background/background-panel.ts';
import { TranscriptView } from '../../shared/src/background/live-transcript.ts';

import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
// Diagnostic: tee the event types every spawned child writes to stdout, with timestamps (types only, no content).
if (process.env.SPIKE_TEE) {
  const realSpawn = cp.spawn.bind(cp); const t0 = Date.now();
  (cp as any).spawn = (...args: any[]) => {
    const child = (realSpawn as any)(...args);
    let buf = '';
    const NL = String.fromCharCode(10);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf(NL); i >= 0; i = buf.indexOf(NL)) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /"type":"([a-z_]+)"/.exec(line); const sub = /"assistantMessageEvent":\{"type":"([a-z_]+)"/.exec(line);
        appendFileSync(process.env.SPIKE_LOG!, `${String(Date.now() - t0).padStart(6)}ms child-stdout ${m?.[1]}${sub ? '/' + sub[1] : ''} len=${line.length}${NL}`);
      }
    });
    return child;
  };
  syncBuiltinESMExports(); // named ESM imports of the built-in (Fork's `import { spawn }`) only see the patch after this
}
const PANEL_WIDTH = Number(process.env.SPIKE_PANEL_WIDTH ?? 44);
const CHUNKS = Number(process.env.SPIKE_CHILD_CHUNKS ?? 30), CHUNK_MS = Number(process.env.SPIKE_CHILD_CHUNK_MS ?? 250);
const log = (message: string) => { if (process.env.SPIKE_LOG) appendFileSync(process.env.SPIKE_LOG, `${message}\n`); };
const textOf = (m: any) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((b: any) => b.text ?? '').join('');
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/**
 * Pi 1.5.0 RPC `message_update` carries only `assistantMessageEvent` (+ usage), no `message`, but LiveTranscript.ingest needs
 * `event.message` and so drops every streaming delta. Instance-level wrapper for this spike: fold text deltas into the streaming item.
 */
function applyDeltaFix(transcript: any) {
  const original = transcript.ingest.bind(transcript);
  transcript.ingest = (event: any) => {
    const delta = event?.type === 'message_update' && !event.message ? event.assistantMessageEvent : undefined;
    if (!delta) return original(event);
    const items = transcript.snapshot().items;
    const last: any = items[items.length - 1];
    if (last?.kind !== 'assistant' || !last.streaming) return;
    if (!Array.isArray(last.message.content)) last.message.content = [];
    const content = last.message.content, i = delta.contentIndex ?? 0;
    if (delta.type === 'text_start') content[i] = { type: 'text', text: '' };
    else if (delta.type === 'text_delta') { content[i] ??= { type: 'text', text: '' }; content[i].text += delta.delta ?? ''; }
    else if (delta.type === 'text_end') content[i] = { type: 'text', text: delta.content ?? content[i]?.text ?? '' };
    else return;
    transcript.version++; transcript.observers.notify();
  };
}

export default function (pi: ExtensionAPI) {
  // Offline provider shared by the parent and the Fork child (the child loads the same -e entries).
  pi.registerProvider('spike', { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'dummy', api: 'spike-api',
    models: [{ id: 'fixture', name: 'Spike', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter((m: any) => m.role === 'user').map(textOf);
      const lastUser = users.at(-1) ?? '';
      const isChild = !!process.env.SPIKE_FORCE_CHILD || users.some(u => u.startsWith('You are the background Fork.'));
      const last: any = context.messages.at(-1);
      const message: any = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [], stopReason: 'stop', usage: usage(), timestamp: Date.now() };
      setImmediate(() => {
        stream.push({ type: 'start', partial: message });
        if (!isChild && last?.role === 'user' && lastUser.includes('DO_FORK')) {
          message.content = [{ type: 'toolCall', id: 'fork-call-1', name: 'fork', arguments: { task: 'FORK_TASK investigate the thing and report', title: 'offline fork' } }];
          message.stopReason = 'toolUse';
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message }); stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
          stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); return;
        }
        message.content = [{ type: 'text', text: '' }];
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        const chunks = isChild ? CHUNKS : 1; let n = 0;
        const timer = setInterval(() => {
          if (options?.signal?.aborted) { clearInterval(timer); message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); return; }
          const piece = isChild ? `child step ${n + 1}/${CHUNKS}: reading files and thinking about the task. ` : 'parent: the fork is running in the background.';
          message.content[0].text += piece; stream.push({ type: 'text_delta', contentIndex: 0, delta: piece, partial: message });
          if (++n >= chunks) { clearInterval(timer); stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }
        }, isChild ? CHUNK_MS : 0);
      });
      return stream;
    } });

  let installed = false;
  const install = (tui: any, theme: any, cwd: string) => {
    if (installed) return; installed = true;
    const original = tui.layoutRoot;
    if (typeof tui.setLayoutRoot !== 'function' || !original) { log('install: no layout root to wrap'); return; }
    const hub: any = acquireBackgroundPanel(pi as any);
    const subscribed = new WeakSet<object>();
    const views = new Map<object, TranscriptView>();
    let renders = 0;
    const panel = {
      invalidate() {},
      render(width: number): string[] {
        const rows = Math.max(4, tui.terminal?.rows ?? 24), inner = Math.max(1, width - 2);
        renders++;
        let jobs: any[] = []; try { jobs = hub.jobs?.() ?? []; } catch { /* panel hub unavailable */ }
        const out: string[] = [theme.fg('accent', `FORKS & SUBAGENTS  (${jobs.filter(j => j.active).length} running)`)];
        let shown: { label: string; transcript: any } | undefined;
        for (const job of jobs) {
          out.push(truncateToWidth(`${job.active ? '▶' : '·'} ${job.kind} ${job.title ?? job.label} — ${job.state}`, inner));
          for (const t of job.transcripts ?? []) {
            if (!subscribed.has(t.transcript)) { subscribed.add(t.transcript);
              if (!process.env.SPIKE_NO_DELTA_FIX) applyDeltaFix(t.transcript); t.transcript.subscribe(() => { const snap = t.transcript.snapshot(); log(`notify v=${t.transcript.version} items=${snap.items.map((i: any) => i.kind + (i.streaming ? '~' : '') + ':' + (i.kind === 'assistant' ? JSON.stringify(i.message?.content ?? '').length : String(i.text).length)).join(',')}`); tui.requestRender(); }); }
            if (!shown && !t.transcript.isReleased) shown = t;
          }
        }
        if (shown) {
          let view = views.get(shown.transcript);
          if (!view) { view = new TranscriptView(shown.transcript, tui, cwd, false); views.set(shown.transcript, view); }
          out.push(theme.fg('dim', `── live: ${shown.label} ──`));
          const body = view.render(inner).filter(line => visibleWidth(line) > 0 || true);
          const room = rows - out.length;
          out.push(...body.slice(Math.max(0, body.length - room)));
        } else if (!jobs.length) out.push(theme.fg('dim', '(no background jobs)'));
        const lines = out.slice(0, rows).map(line => `│ ${truncateToWidth(line, inner)}`);
        while (lines.length < rows) lines.push('│');
        return lines;
      },
    };
    tui.setLayoutRoot(new HStack([{ component: original, grow: 1, shrink: 1 }, { component: panel, basis: PANEL_WIDTH, grow: 0, shrink: 0 }], { gap: 0 }));
    log('install: layout root replaced');
  };
  pi.on('session_start', (_e, ctx) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setHeader((tui, theme) => { queueMicrotask(() => { try { install(tui, theme, ctx.cwd); } catch (e) { log(`install failed: ${String(e)}`); } }); return { render: () => [], invalidate() {} }; });
  });
}
