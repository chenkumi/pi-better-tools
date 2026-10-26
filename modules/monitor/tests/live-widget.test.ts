import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as plain } from 'node:util';
import { BACKGROUND_WIDGET_KEY } from '../../shell-tools/src/background-panel.js';
import { MonitorRuntime, type Clock, type MonitorPanelRow, type SourceSink } from '../src/core.ts';
import { PANEL_REFRESH_MS, MonitorJobsWidget, monitorPanelJob, remainingLabel } from '../src/live-widget.ts';
import { validateStart } from '../src/schema.ts';

class FakeClock implements Clock {
  time = 0; id = 0; tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.time) { this.tasks.delete(id); task.fn(); } }
}
const turn = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const owner = { sessionId: 'session-A', cwd: '/canonical/workspace' };

function screen() {
  const widgets = new Map<string, any>();
  const tui = { terminal: { rows: 40 }, requestRender() {}, addInputListener: () => () => {} };
  const theme: any = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, getBgAnsi: () => '' };
  const ctx: any = { mode: 'tui', hasUI: true, cwd: owner.cwd, sessionManager: { getSessionId: () => owner.sessionId }, ui: {
    setStatus() {}, setWidget(key: string, value: unknown) { if (value) widgets.set(key, value); else widgets.delete(key); },
  } };
  return { ctx, shown: () => widgets.has(BACKGROUND_WIDGET_KEY), text: () => plain(widgets.get(BACKGROUND_WIDGET_KEY)(tui, theme).render(100).join('\n')) };
}

function fixture() {
  const clock = new FakeClock(), ui = screen(), sinks: SourceSink[] = [], finishers: Array<() => void> = [];
  const runtime = new MonitorRuntime(() => {}, clock);
  const widget = new MonitorJobsWidget(clock);
  runtime.onChange = () => widget.refresh();
  runtime.bind(owner, () => owner);
  widget.bind(ui.ctx, () => runtime.panelRows());
  const launch = async (sink: SourceSink, signal: AbortSignal) => {
    sinks.push(sink); signal.addEventListener('abort', () => finishers.at(-1)?.());
    sink.started(); await new Promise<void>(resolve => { finishers.push(resolve); });
    sink.closed({ sourceClosed: true, processTreeState: 'unknown' });
  };
  const start = (source: object, extra: object = {}) => runtime.start(validateStart({ source, ...extra }), launch);
  return { clock, ui, runtime, widget, sinks, finishers, start };
}

test('remaining time is shown by the minute and never as zero while running', () => {
  assert.equal(remainingLabel(24 * 60_000 + 3_000), '剩 24m'); assert.equal(remainingLabel(60_000), '剩 1m'); assert.equal(remainingLabel(59_999), '剩 <1m');
  assert.equal(remainingLabel(72 * 60_000), '剩 1h 12m'); assert.equal(remainingLabel(60 * 60_000), '剩 1h'); assert.equal(remainingLabel(0), '剩 0m'); assert.equal(remainingLabel(-5), '剩 0m'); assert.equal(remainingLabel(NaN), '剩 0m');
});

test('a row projects to one panel line: running shows wake | remaining, ended-with-unconfirmed-close says so', () => {
  const base: MonitorPanelRow = { id: 'M1', source: 'command', target: 'tail -f logs/app.log', state: 'running', active: true, wakeAgent: false, createdAt: 0, startedAt: 1, deadline: 24 * 60_000, counts: { adopted: 3, submitted: 2, omitted: 0, rejected: 0 }, buffered: 1,
    notification: { state: 'pending', attempts: 0 }, cleanup: { pending: true, sourceClosed: false } };
  const running = monitorPanelJob(base, 0);
  assert.deepEqual([running.kind, running.label, running.title, running.summary, running.usageState, running.active], ['monitor', 'command', 'tail -f logs/app.log', 'wake off | 剩 24m', 'na', true]);
  assert.equal(monitorPanelJob({ ...base, wakeAgent: true, deadline: 72 * 60_000 }, 0).summary, 'wake on | 剩 1h 12m');
  assert.equal(monitorPanelJob({ ...base, label: 'build watcher' }, 0).title, 'build watcher');
  assert.equal(monitorPanelJob({ ...base, state: 'starting' }, 0).summary, 'starting | wake off');
  assert.equal(monitorPanelJob({ ...base, state: 'stopping' }, 0).summary, 'stopping | wake off');
  assert.equal(monitorPanelJob({ ...base, state: 'completed', active: true }, 0).summary, 'completed | cleanup pending');
  assert.equal(monitorPanelJob({ ...base, state: 'completed', active: false, cleanup: { pending: false, sourceClosed: true } }, 0).summary, 'completed | wake off');
  const text = monitorPanelJob(base, 0).details.join('\n');
  assert.match(text, /Monitor ID: M1/); assert.match(text, /Command: tail -f logs\/app\.log/); assert.match(text, /Wake agent: no/); assert.match(text, /adopted 3 · submitted 2/); assert.match(text, /readonly/); assert.match(text, /process tree state unknown/);
});

test('panel rows cover command / websocket / file only, with origin-only endpoints and no event or stderr text', async () => {
  const f = fixture();
  f.start({ kind: 'command', tool: 'bash', command: 'tail -f logs/app.log' });
  f.start({ kind: 'websocket', url: 'wss://api.example.com/stream?token=SECRET_TOKEN' });
  f.start({ kind: 'shell_job', jobId: 'SHELL1' }); f.start({ kind: 'subagent_job', jobId: 'SUB1' });
  await turn();
  for (const sink of f.sinks) { sink.data('SECRET_EVENT_TEXT'); sink.stderr(Buffer.from('SECRET_STDERR')); }
  const rows = f.runtime.panelRows();
  assert.deepEqual(rows.map(row => row.source), ['command', 'websocket'], 'job sources already have their own panel rows');
  assert.equal(rows[1]!.target, 'wss://api.example.com');
  const dump = JSON.stringify(rows) + JSON.stringify(rows.map(row => monitorPanelJob(row, 0))) + f.ui.text();
  assert.doesNotMatch(dump, /SECRET_TOKEN|SECRET_EVENT_TEXT|SECRET_STDERR|\/stream/);
  assert.match(f.ui.text(), /Jobs · 2 active · Subagents 0 \/ Shell 0 \/ Monitor 2/);
  assert.match(f.ui.text(), /● MN command · tail -f logs\/app\.log +wake on \| 剩 5m/); assert.match(f.ui.text(), /● MN websocket · wss:\/\/api\.example\.com +wake on \| 剩 5m/);
  assert.equal(rows[0]!.counts.adopted, 1);
});

test('the panel follows the runtime: countdown by timer, stop, close, and no timer once nothing is active', async () => {
  const f = fixture();
  const receipt = f.start({ kind: 'command', tool: 'bash', command: 'tail -f logs/app.log' }, { wakeAgent: false });
  assert.match(f.ui.text(), /starting \| wake off/, 'visible immediately after acceptance');
  await turn(); assert.match(f.ui.text(), /wake off \| 剩 5m/);
  for (let i = 0; i < 4; i++) f.clock.advance(PANEL_REFRESH_MS);
  assert.match(f.ui.text(), /wake off \| 剩 3m/, 'the 30 s refresh timer keeps the countdown current');
  f.runtime.stop(receipt.monitorId); assert.match(f.ui.text(), /stopping \| wake off/);
  f.finishers.at(-1)!(); await f.runtime.settled(receipt.monitorId); await turn();
  assert.equal(f.ui.shown(), false, 'ended monitors leave the resident panel');
  const before = f.clock.tasks.size; f.widget.clear(); assert.equal(f.clock.tasks.size, before, 'no panel timer left behind once nothing is active');
});

test('clear() stops the refresh timer while a monitor is still active; later runtime changes cannot redraw', async () => {
  const f = fixture();
  f.start({ kind: 'file', path: 'notes.txt' }); await turn();
  const armed = f.clock.tasks.size; f.widget.clear(); assert.equal(f.clock.tasks.size, armed - 1, 'exactly the panel timer was cancelled');
  assert.equal(f.ui.shown(), false);
  f.sinks[0]!.data(undefined, false, { change: 'modified' }); f.clock.advance(PANEL_REFRESH_MS * 2); assert.equal(f.ui.shown(), false);
  assert.equal(f.runtime.panelRows().length, 1, 'the monitor itself is untouched by the display');
});

test('a throwing display never affects the runtime', async () => {
  const f = fixture(); f.runtime.onChange = () => { throw new Error('UI disposed'); };
  const receipt = f.start({ kind: 'command', tool: 'bash', command: 'x' }); await turn();
  f.sinks[0]!.data('one'); assert.equal(f.runtime.status(receipt.monitorId).counts.adopted, 1);
  f.runtime.stop(receipt.monitorId); f.finishers.at(-1)!(); await f.runtime.settled(receipt.monitorId);
  assert.equal(f.runtime.status(receipt.monitorId).state, 'stopped');
});
