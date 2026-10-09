import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ShellJobs } from '../src/background-jobs.js';
import { SHELL_WIDGET_KEY, ShellJobsWidget, renderShellWidget } from '../src/live-widget.js';
const theme: any = { fg: (_: string, s: string) => `\x1b[32m${s}\x1b[0m`, getBgAnsi: () => '\x1b[48;5;58m', bg: (_: string, s: string) => '\x1b[48;5;58m' + s + '\x1b[49m' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function ui(mode = 'tui') {
  let owner = 'owner'; const widgets = new Map<string, any>(), statuses = new Map<string, string>(), calls: any[] = []; let command: any;
  const ctx: any = { mode, hasUI: true, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => owner }, ui: { setStatus(key: string, text: string | undefined) { if (text) statuses.set(key, text); else statuses.delete(key); }, setWidget(key: string, value: any, options: any) { calls.push({ key, value, options }); if (value) widgets.set(key, value); else widgets.delete(key); } } };
  return { ctx, calls, widgets, api: { registerCommand(_name: string, definition: any) { command = definition; } }, owner: (id: string) => owner = id, expand() { void command.handler('shell', ctx); }, text: () => plain(widgets.get(SHELL_WIDGET_KEY)?.({}, theme).render(100).join('\n') ?? statuses.get(SHELL_WIDGET_KEY) ?? '') };
}
const result = { content: [], details: undefined, structuredContent: { output: 'OK', exit_code: 0 } } as any;
test('real registry events show both shells, retain cancel requests, remove one at a time, then hide', async () => {
  const view = ui(), first = deferred(), second = deferred(), entered = deferred(), endedOne = deferred(), endedTwo = deferred();
  let notices = 0;
  const jobs = new ShellJobs({ ...view.api, sendMessage: () => { (++notices === 1 ? endedOne : endedTwo).resolve(); } } as any);
  jobs.start(view.ctx);
  view.widgets.set('unrelated-widget', () => ({}));
  try {
    const a = jobs.submit(view.ctx, 'bash', 'one', undefined, async signal => { entered.resolve(); await first.promise; if (signal.aborted) throw new Error('cancelled'); return result; }, 'build alpha');
    const b = jobs.submit(view.ctx, 'powershell', 'two', undefined, async () => { await second.promise; return result; }, 'build beta');
    assert.deepEqual(Object.keys(a).sort(), ['jobId', 'liveLogPath', 'status']);
    assert.match(view.text(), /Shell：2/); assert.equal(view.text().split('\n').length, 1); assert.doesNotMatch(view.text(), /build alpha/); view.expand();
    assert.match(view.text(), /2 active/); assert.match(view.text(), /bash.*build alpha/); assert.match(view.text(), /powershell.*build beta/);
    assert.match(view.text(), new RegExp(a.jobId.slice(-6))); assert.match(view.text(), new RegExp(b.jobId.slice(-6)));
    await entered.promise;
    jobs.cancel(view.ctx, a.jobId); assert.match(view.text(), /cancel requested/); assert.match(view.text(), /2 active/);
    first.resolve(); await endedOne.promise; assert.match(view.text(), /1 active/); assert.doesNotMatch(view.text(), /build alpha/); assert.match(view.text(), /build beta/);
    second.resolve(); await endedTwo.promise; assert.equal(view.widgets.has(SHELL_WIDGET_KEY), false); assert.equal(view.widgets.has('unrelated-widget'), true);
  } finally { first.resolve(); second.resolve(); await jobs.shutdown(); }
});
test('shutdown clears immediately; late completion cannot resurrect a widget', async () => {
  const view = ui(), entered = deferred(), release = deferred(); let notices = 0;
  const jobs = new ShellJobs({ ...view.api, sendMessage() { notices++; } } as any); jobs.start(view.ctx);
  jobs.submit(view.ctx, 'powershell', 'one', undefined, async () => { entered.resolve(); await release.promise; return result; }, 'quiet work');
  await entered.promise; const closing = jobs.shutdown(); assert.equal(view.widgets.has(SHELL_WIDGET_KEY), false);
  const count = view.calls.length; release.resolve(); await closing;
  assert.equal(view.calls.length, count); assert.equal(notices, 0);
});
test('throwing UI cannot fail accepted work or suppress its completion', async () => {
  const view = ui(), done = deferred(); view.ctx.ui.setWidget = () => { throw new Error('UI disposed'); };
  const jobs = new ShellJobs({ ...view.api, sendMessage: () => done.resolve() } as any); jobs.start(view.ctx);
  try { const receipt = jobs.submit(view.ctx, 'bash', 'one', undefined, async () => result, 'noop'); await done.promise; assert.equal(jobs.status(view.ctx, receipt.jobId).status, 'completed'); }
  finally { await jobs.shutdown(); }
});
test('UI binder is TUI-only, deduplicates snapshots and drops stale owners', () => {
  for (const mode of ['rpc', 'json', 'print']) { const view = ui(mode), widget = new ShellJobsWidget(); widget.bind(view.ctx, () => []); widget.refresh(); widget.clear(); assert.equal(view.calls.length, 0); }
  const view = ui(), widget = new ShellJobsWidget(view.api); const rows: any[] = [{ jobId: 'abc', tool: 'bash', status: 'running', command: 'x' }];
  widget.bind(view.ctx, () => rows); assert.equal(view.widgets.has(SHELL_WIDGET_KEY), false); assert.match(view.text(), /Shell：1/); view.expand(); assert.equal(view.calls.at(-1).options.placement, 'belowEditor');
  const count = view.calls.length; widget.refresh(); widget.refresh(); assert.equal(view.calls.length, count, 'no polling/redraw on identical state');
  view.owner('new-owner'); widget.refresh(); assert.equal(view.widgets.has(SHELL_WIDGET_KEY), false); widget.clear();
});
test('bounded Unicode layout, controls, background continuity, resize and dynamic theme', () => {
  const rows: any[] = Array.from({ length: 20 }, (_, i) => ({ jobId: `same-prefix-${i}`, tool: 'powershell', status: 'running', command: '\x1b]0;x\x07\x1b[2J\u202e界😀\n\t' + 'long'.repeat(500) }));
  const before = JSON.stringify(rows), component = renderShellWidget(rows, theme);
  for (const width of [0, 1, 2, 3, 6, 24, 80]) for (const line of component.render(width)) {
    assert.equal(visibleWidth(line), width); assert.doesNotMatch(plain(line), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    for (const reset of line.matchAll(/\x1b\[(?:0)?m/g)) assert.ok(line.startsWith(theme.getBgAnsi(), reset.index! + reset[0].length));
  }
  assert.ok(component.render(80).length <= 10); assert.match(plain(component.render(80).join('\n')), /12 more active/); assert.equal(JSON.stringify(rows), before);
  let ansi = '\x1b[48;5;58m'; const dynamic = { ...theme, getBgAnsi: () => ansi, bg: (_: string, s: string) => ansi + s + '\x1b[49m' };
  const changing = renderShellWidget(rows, dynamic); changing.render(80); ansi = '\x1b[48;5;22m'; changing.invalidate(); assert.ok(changing.render(24).every(line => line.startsWith(ansi)));
});
