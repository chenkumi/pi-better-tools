import { appendFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { acquireBackgroundPanel } from '../../src/background-panel.js';
import type { PanelJob } from '../../src/job-view.js';

/** Offline terminal fixture: injected metadata, no subprocess jobs, models or persisted user state. */
export default function (pi: ExtensionAPI) {
  const record = (data: unknown) => appendFileSync(process.env.JOBS_TUI_EVIDENCE!, JSON.stringify(data) + '\n');
  globalThis.fetch = async () => { record({ event: 'forbidden-network' }); throw new Error('Offline UI fixture forbids network'); };
  pi.on('before_provider_request', () => { record({ event: 'forbidden-provider' }); throw new Error('UI fixture must not request a model'); });
  const panel = acquireBackgroundPanel(pi);
  let tui: any, ctx: ExtensionContext, overlayComponent: any, token: object | undefined;
  let jobs: PanelJob[] = [], disposedOwner = false;
  pi.on('session_start', (_event, context) => {
    ctx = context;
    const actualSetWidget = ctx.ui.setWidget.bind(ctx.ui), actualCustom = ctx.ui.custom.bind(ctx.ui);
    const observed = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId() { if (disposedOwner) throw new Error('Injected disposed owner'); return ctx.sessionManager.getSessionId(); } }, ui: { ...ctx.ui,
      setWidget(key: string, value: any, options: any) {
        actualSetWidget(key, typeof value === 'function' ? (runtime: any, theme: any) => {
          tui = runtime;
          const component = value(runtime, theme), render = component.render.bind(component);
          component.render = (width: number) => { const lines = render(width); record({ event: 'widget', key, placement: options?.placement, width, rows: runtime.terminal.rows, lines: lines.map(stripVTControlCharacters) }); return lines; };
          return component;
        } : value, options);
      },
      custom(factory: any, options: any) {
        record({ event: 'opening', draft: ctx.ui.getEditorText() });
        return actualCustom((runtime, theme, keys, done) => {
          const component = factory(runtime, theme, keys, (result: any) => {
            done(result); overlayComponent = undefined;
            record({ event: 'closed', draft: ctx.ui.getEditorText(), overlay: tui.hasOverlay(), focus: tui.getFocusedComponent?.()?.constructor.name });
          });
          overlayComponent = component;
          return component;
        }, options);
      },
    } } as ExtensionContext;
    token = panel.attach('shell', observed);
    jobs = Array.from({ length: 7 }, (_, i) => ({ kind: i % 2 ? 'subagents' : 'shell', jobId: `JOB00000${i}`, label: i % 2 ? 'scout' : 'bash', title: `TUI work ${i}`, state: 'running', active: i !== 6,
      activity: i % 2 ? 'Tool running: read' : 'Running · output received', usageState: i % 2 ? 'reported' : 'na', usage: i % 2 ? { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0 } : undefined, startedAt: i,
      details: [`Task ID: TASK${i}`, `Detail item ${i}`, ...Array.from({ length: 40 }, (_, n) => `Long detail ${n} for ${i}`)] }));
    panel.update('shell', token!, { jobs, signature: JSON.stringify(jobs) });
    ctx.ui.setStatus('jobs-fixture-unrelated', 'Preserved status');
    ctx.ui.onTerminalInput(data => {
      if (data === '\x14') { void panel.openMore(observed); return { consume: true }; }
      if (data === '\x19') {
        tui.renderNow(true);
        record({ event: 'snapshot', mode: tui.mode, columns: tui.terminal.columns, rows: tui.terminal.rows,
          draft: ctx.ui.getEditorText(), overlay: tui.hasOverlay(), focus: tui.getFocusedComponent?.()?.constructor.name,
          screenLines: tui.getScreenLines?.().map(stripVTControlCharacters), lines: tui.render(tui.terminal.columns).map(stripVTControlCharacters), overlayLines: overlayComponent?.render(Math.max(1, Math.floor(tui.terminal.columns * 0.9))).map(stripVTControlCharacters) });
        return { consume: true };
      }
      if (data === '\x02') {
        jobs = jobs.map(j => j.usage ? { ...j, usage: { ...j.usage, totalTokens: 1234 }, activity: 'Generating reply' } : j);
        panel.update('shell', token!, { jobs, signature: JSON.stringify(jobs) });
        record({ event: 'updated', draft: ctx.ui.getEditorText(), overlay: tui.hasOverlay() });
        return { consume: true };
      }
      if (data === '\x07') {
        disposedOwner = true; overlayComponent?.render(tui.terminal.columns);
        record({ event: 'disposed-owner', overlay: tui.hasOverlay(), draft: ctx.ui.getEditorText() });
        return { consume: true };
      }
      if (data === '\x04') { ctx.shutdown(); return { consume: true }; }
    });
    record({ event: 'ready' });
  });
  pi.on('session_shutdown', () => { if (token) panel.detach('shell', token); record({ event: 'shutdown' }); });
}
