import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { BackgroundJobs, slimReceipt } from '../extensions/subagent/background.ts';
import { SUBAGENT_WIDGET_KEY, SubagentJobsWidget, renderSubagentWidget } from '../extensions/subagent/live-widget.ts';
const theme: any = { fg: (_: string, s: string) => `\x1b[32m${s}\x1b[0m`, getBgAnsi: () => '\x1b[48;5;58m', bg: (_: string, s: string) => '\x1b[48;5;58m' + s + '\x1b[49m' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function view(mode = 'tui') {
  let owner = 'owner'; const widgets = new Map<string, any>(), statuses = new Map<string, string>(), calls: any[] = []; let command: any;
  const ctx: any = { mode, hasUI: true, sessionManager: { getSessionId: () => owner }, ui: { setStatus(key: string, text: string | undefined) { if (text) statuses.set(key, text); else statuses.delete(key); }, setWidget(key: string, value: any) { calls.push({ key, value }); if (value) widgets.set(key, value); else widgets.delete(key); } } };
  return { ctx, calls, widgets, api: { registerCommand(_name: string, definition: any) { command = definition; } }, owner: (id: string) => owner = id, expand() { void command.handler('subagents', ctx); }, text: () => plain(widgets.get(SUBAGENT_WIDGET_KEY)?.({}, theme).render(140).join('\n') ?? statuses.get(SUBAGENT_WIDGET_KEY) ?? '') };
}
test('registry events show queue, admitted tasks, cancellation and finalizing, then hide; titles are UI-only', async () => {
  const ui = view(), widget = new SubagentJobsWidget(ui.api), entered = deferred(), first = deferred(), last = deferred(), done = deferred();
  const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); }, undefined, () => widget.refresh());
  widget.bind(ui.ctx, () => jobs.activePanel('owner', '/cwd'));
  try {
    const receipt = jobs.submit('owner', '/cwd', jobs.epoch, ['worker', 'reviewer'], async (_signal, _ids, live, finish) => {
      live(0, 'session', '/live.partial'); entered.resolve(); await first.promise;
      finish(0, { output: 'SENSITIVE OUTPUT' }, 'completed'); finish(1, {}, 'skipped'); await last.promise;
    }, ['Build component', 'Review output']);
    const original = JSON.stringify(receipt);
    assert.match(ui.text(), /Subagents：2/); assert.equal(ui.text().split('\n').length, 1); assert.doesNotMatch(ui.text(), /Build component/); ui.expand();
    assert.match(ui.text(), /2 queued/); assert.match(ui.text(), /Build component/); assert.match(ui.text(), /Review output/);
    assert.doesNotMatch(JSON.stringify(receipt), /widgetTitles|Build component|Review output/); assert.doesNotMatch(JSON.stringify(slimReceipt(receipt)), /Build component/);
    assert.deepEqual(jobs.activePanel('other', '/cwd'), []); assert.deepEqual(jobs.activePanel('owner', '/other'), []);
    await entered.promise; assert.match(ui.text(), /1 running.*1 queued/); jobs.cancel(receipt.jobId, 'owner', '/cwd'); assert.match(ui.text(), /cancel requested/);
    first.resolve(); await Promise.resolve(); await Promise.resolve(); assert.match(ui.text(), /finalizing/); assert.doesNotMatch(ui.text(), /SENSITIVE OUTPUT/);
    assert.equal(JSON.stringify(receipt), original, 'returned receipt remains detached');
    last.resolve(); await done.promise; assert.equal(ui.widgets.has(SUBAGENT_WIDGET_KEY), false);
  } finally { first.resolve(); last.resolve(); widget.clear(); await jobs.shutdown(); }
});
test('shutdown/epoch checks suppress old late callbacks while replacement panel remains live', async () => {
  const ui = view(), widget = new SubagentJobsWidget(ui.api), entered = deferred(), release = deferred(), freshRelease = deferred(), freshEntered = deferred();
  const jobs = new BackgroundJobs(() => {}, undefined, () => widget.refresh()); widget.bind(ui.ctx, () => jobs.activePanel('owner', '/cwd'));
  jobs.submit('owner', '/cwd', jobs.epoch, ['worker'], async (_signal, _ids, live, finish) => { entered.resolve(); await release.promise; live(0, 'old', '/old.partial'); finish(0, {}, 'completed'); });
  await entered.promise; const closing = jobs.shutdown(0); assert.equal(ui.widgets.has(SUBAGENT_WIDGET_KEY), false); await closing; jobs.start();
  jobs.submit('owner', '/cwd', jobs.epoch, ['reviewer'], async () => { freshEntered.resolve(); await freshRelease.promise; }); await freshEntered.promise; ui.expand();
  const before = ui.calls.length; release.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.calls.length, before); assert.match(ui.text(), /reviewer/); assert.doesNotMatch(ui.text(), /worker/);
  freshRelease.resolve(); widget.clear(); await jobs.shutdown();
});
test('throwing observer or UI never changes results or completion delivery', async () => {
  const done = deferred(); const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); }, undefined, () => { throw new Error('UI failed'); });
  const receipt = jobs.submit('owner', '/cwd', jobs.epoch, ['worker'], async (_signal, _ids, _live, finish) => { finish(0, { output: 'OK' }, 'completed'); });
  await done.promise; assert.equal(jobs.get(receipt.jobId, 'owner', '/cwd').status, 'completed'); await jobs.shutdown();
  const ui = view(); ui.ctx.ui.setWidget = () => { throw new Error('disposed'); }; const widget = new SubagentJobsWidget(); assert.doesNotThrow(() => { widget.bind(ui.ctx, () => []); widget.refresh(); widget.clear(); });
});
test('projection bounds agent/title metadata without changing receipts', async () => {
  const release = deferred(), done = deferred(), agent = 'agent'.repeat(1000), title = 'title'.repeat(1000);
  const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); });
  const receipt = jobs.submit('owner', '/cwd', jobs.epoch, [agent], async () => release.promise, [title]);
  const rows = jobs.activePanel('owner', '/cwd'); assert.equal(rows[0].agent!.length, 256); assert.equal(rows[0].title!.length, 256); assert.equal(receipt.tasks[0].agent, agent);
  assert.doesNotMatch(JSON.stringify(receipt), /widgetTitles/); release.resolve(); await done.promise; await jobs.shutdown();
});
test('TUI-only binding, no idle redraw and combined key preserves unrelated widgets', () => {
  for (const mode of ['rpc', 'json', 'print']) { const ui = view(mode), widget = new SubagentJobsWidget(); widget.bind(ui.ctx, () => []); widget.refresh(); widget.clear(); assert.equal(ui.calls.length, 0); }
  const ui = view(), widget = new SubagentJobsWidget(); ui.widgets.set('pi-better-tools-shell-jobs', () => ({})); ui.widgets.set('schedule-widget', () => ({}));
  widget.bind(ui.ctx, () => [{ jobId: 'j', taskId: 't', agent: 'worker', status: 'running', cancelRequested: false }]);
  const count = ui.calls.length; widget.refresh(); widget.refresh(); assert.equal(ui.calls.length, count);
  ui.owner('different'); widget.refresh(); assert.equal(ui.widgets.has(SUBAGENT_WIDGET_KEY), false); assert.equal(ui.widgets.size, 2);
});
test('running tasks have display priority; bounded, safe, full-width layout never mutates metadata', () => {
  const rows: any[] = Array.from({ length: 32 }, (_, i) => ({ jobId: 'same-prefix-' + i, taskId: 'task-' + i, agent: i < 24 ? 'queued-agent' : 'active-agent', title: '\x1b]0;x\x07\u202e界😀\n\t' + 'long'.repeat(1000), status: i < 24 ? 'queued' : 'running', cancelRequested: false }));
  const before = JSON.stringify(rows), component = renderSubagentWidget(rows, theme);
  for (const width of [0, 1, 2, 3, 6, 24, 80]) for (const line of component.render(width)) {
    assert.equal(visibleWidth(line), width); assert.doesNotMatch(plain(line), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    for (const reset of line.matchAll(/\x1b\[(?:0)?m/g)) assert.ok(line.startsWith(theme.getBgAnsi(), reset.index! + reset[0].length));
  }
  const text = plain(component.render(80).join('\n')); assert.match(text, /8 running.*24 queued/); assert.match(text, /24 more/); assert.match(text, /active-agent/); assert.doesNotMatch(text, /queued-agent/);
  assert.ok(component.render(80).length <= 10); assert.equal(JSON.stringify(rows), before);
});
