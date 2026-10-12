import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import { BackgroundPanel, BACKGROUND_WIDGET_KEY, acquireBackgroundPanel, type PanelKind } from '../src/background-panel.js';
import { JobsOverlay, panelUsage, renderJobs, usageLabel, type PanelJob } from '../src/job-view.js';
import { ShellJobsWidget } from '../src/live-widget.js';
import { SubagentJobsWidget } from '../../subagents/extensions/subagent/live-widget.ts';
const theme: any = { fg: (_: string, s: string) => `\x1b[32m${s}\x1b[0m`, getBgAnsi: () => '\x1b[48;5;58m', bg: (_: string, s: string) => '\x1b[48;5;58m' + s + '\x1b[49m' };
function view() {
  let owner = 'owner', renders = 0, customCalls = 0, overlay: any, draft = '保留輸入中的文字', rows = 40;
  const widgets = new Map<string, any>(), statuses = new Map<string, string>(), calls: any[] = [];
  const tui = { terminal: { get rows() { return rows; } }, requestRender: () => renders++ };
  const ctx: any = { cwd: '/cwd', mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => owner }, ui: {
    setStatus(key: string, value: string | undefined) { if (value) statuses.set(key, value); else statuses.delete(key); },
    setWidget(key: string, value: any, options: any) { calls.push({ key, value, options }); if (value) widgets.set(key, value); else widgets.delete(key); }, notify() {},
    getEditorText: () => draft, setEditorText: (s: string) => { draft = s; },
    custom(factory: any, options: any) { customCalls++; assert.equal(options.overlay, true); return new Promise<void>(resolve => {
      const done = () => { overlay?.dispose?.(); overlay = undefined; resolve(); };
      overlay = factory(tui, theme, {}, done);
    }); },
  } };
  return { ctx, widgets, statuses, calls, owner: (id: string) => owner = id, rows: (n: number) => rows = n,
    factory: () => widgets.get(BACKGROUND_WIDGET_KEY), component: () => widgets.get(BACKGROUND_WIDGET_KEY)(tui, theme),
    renders: () => renders, overlay: () => overlay, customCalls: () => customCalls, draft: () => draft };
}
const job = (id: string, kind: PanelKind = 'shell', state = 'running', active = true): PanelJob => ({ jobId: id, kind, label: kind === 'shell' ? 'bash' : 'scout', title: `${kind} work ${id}`, state, active, activity: state === 'finalizing' ? 'Finalizing · finishing cleanup' : state, usageState: kind === 'shell' ? 'na' : 'pending', startedAt: Number(id.replace(/\D/g, '')) || 0, details: [`Detail ${id}`] });
const snapshot = (jobs: PanelJob[]) => ({ jobs, signature: JSON.stringify(jobs) });
function mouse(component: any, x: number, y: number, width = 80, options: any = {}) { return component.handleMouse({ type: 'click', button: 'left', x, y, screenX: x, screenY: y, width, height: 12, shift: false, alt: false, ctrl: false, clickCount: 1, ...options }); }
function setup() { const ui = view(), panel = new BackgroundPanel(), shell = panel.attach('shell', ui.ctx)!, sub = panel.attach('subagents', ui.ctx)!; panel.update('shell', shell, snapshot([job('1'), job('2')])); panel.update('subagents', sub, snapshot([job('3', 'subagents'), job('4', 'subagents'), job('5', 'subagents'), job('6', 'subagents')])); return { ui, panel, shell, sub }; }
function hostPair() {
  const handlers = new Map<string, Set<Function>>(), commands = new Map<string, any>(), registrations: string[] = [];
  const create = () => ({ events: { emit(channel: string, data: unknown) { for (const handler of handlers.get(channel) ?? []) handler(data); }, on(channel: string, handler: Function) { if (!handlers.has(channel)) handlers.set(channel, new Set()); handlers.get(channel)!.add(handler); return () => handlers.get(channel)!.delete(handler); } }, registerCommand(name: string, definition: any) { registrations.push(name); commands.set(name, definition); } });
  return { create, commands, registrations, clear: () => handlers.clear() };
}
test('automatic above-editor panel: five JOBS total, two rows each, no duplicate footer; unrelated widgets/statuses preserved', () => {
  const { ui, panel, shell, sub } = setup(); ui.widgets.set('schedule', ['preserved']); ui.statuses.set('gpt-speed', 'Fast');
  const text = plain(ui.component().render(100).join('\n'));
  assert.match(text, /6 active · Subagents 4 \/ Shell 2/); assert.match(text, /More… \(\+1 active\)/);
  assert.equal(text.split('\n').length, 12); assert.equal((text.match(/[●◷◐] (?:SA|SH)/g) ?? []).length, 5);
  assert.equal(ui.calls.at(-1).options.placement, 'aboveEditor'); assert.equal(ui.statuses.has(BACKGROUND_WIDGET_KEY), false);
  panel.toggle('collapse', ui.ctx); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  panel.toggle('all', ui.ctx); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), true);
  panel.update('shell', shell, snapshot([])); assert.match(plain(ui.component().render(100).join('\n')), /4 active/);
  panel.detach('subagents', sub); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  assert.equal(ui.statuses.get('gpt-speed'), 'Fast'); assert.deepEqual(ui.widgets.get('schedule'), ['preserved']);
});
test('SDK Container routes fullscreen More click; passive updates never claim editor focus or alter text', async () => {
  const { ui } = setup(), container = new Container(); container.addChild(ui.component()); const lines = container.render(80);
  assert.equal(ui.customCalls(), 0); const result = mouse(container, 2, lines.length - 1); assert.equal(result?.handled, true); assert.notEqual(result?.focus, true);
  const overlay = ui.overlay(); overlay.render(72); assert.match(plain(overlay.render(72).join('\n')), /Jobs/);
  overlay.handleInput('\x1b'); await Promise.resolve(); assert.equal(ui.overlay(), undefined); assert.equal(ui.draft(), '保留輸入中的文字');
});
test('More ignores clipped label, row contents, modifiers, drag/press/wheel, double click and stale resize/dispose', () => {
  const { ui } = setup(); const c = ui.component(), lines = c.render(80); const y = lines.length - 1;
  for (const options of [{ y: 1 }, { button: 'right' }, { shift: true }, { alt: true }, { ctrl: true }, { type: 'wheel' }, { type: 'drag' }, { type: 'press' }, { clickCount: 2 }]) assert.equal(mouse(c, 2, y, 80, options), undefined);
  assert.equal(mouse(c, 25, y), undefined); assert.equal(mouse(c, 2, y, 24), undefined);
  c.invalidate(); assert.equal(mouse(c, 2, y), undefined); c.render(7); assert.equal(mouse(c, 2, y, 7), undefined);
  c.dispose(); assert.equal(mouse(c, 2, y), undefined); assert.equal(ui.customCalls(), 0);
});
test('replacement owner/leases fence old widgets and overlays; detach preserves other producer', async () => {
  const { ui, panel, shell, sub } = setup(); const stale = ui.component(); const lines = stale.render(80);
  const opened = panel.openMore(ui.ctx); ui.overlay().render(70); ui.owner('next'); const fresh = panel.attach('shell', ui.ctx)!; panel.update('shell', fresh, snapshot([job('9')])); await opened;
  const count = ui.calls.length; panel.update('subagents', sub, snapshot([job('8', 'subagents')])); panel.detach('shell', shell); assert.equal(ui.calls.length, count);
  assert.equal(mouse(stale, 2, lines.length - 1), undefined); assert.deepEqual(stale.render(80), []); assert.equal(ui.overlay(), undefined);
  assert.match(plain(ui.component().render(100).join('\n')), /Shell 1/);
  ui.owner('replaced'); assert.equal(panel.toggle('all'), false); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
});
test('finalizing stays visible as a job, not a running child; completion leaves only retained More history', async () => {
  const { ui, panel, shell, sub } = setup(); panel.update('shell', shell, snapshot([])); panel.update('subagents', sub, snapshot([job('3', 'subagents', 'finalizing')]));
  assert.match(plain(ui.component().render(100).join('\n')), /Finalizing/);
  const finished = job('3', 'subagents', 'completed', false); panel.update('subagents', sub, snapshot([finished])); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  const opening = panel.openMore(ui.ctx); const overlay = ui.overlay(); assert.match(plain(overlay.render(72).join('\n')), /subagents work 3/); overlay.handleInput('\r');
  assert.match(plain(overlay.render(72).join('\n')), /State: completed/); overlay.handleInput('\x1b'); overlay.render(72); overlay.handleInput('\x1b'); await opening;
  panel.update('subagents', sub, snapshot([job('4', 'subagents')])); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), true, 'new jobs show without re-expansion');
});
test('distinct wrappers rendezvous once, either load order, aliases/filter/More and fresh reload state', async () => {
  for (const order of [['shell', 'subagents'], ['subagents', 'shell']] as PanelKind[][]) {
    const hosts = hostPair(), first = acquireBackgroundPanel(hosts.create()), second = acquireBackgroundPanel(hosts.create()); assert.equal(first, second); assert.deepEqual(hosts.registrations, ['background-jobs']);
    const ui = view(); for (const kind of order) { const token = first.attach(kind, ui.ctx)!; first.update(kind, token, snapshot([job(kind, kind)])); }
    const command = hosts.commands.get('background-jobs').handler;
    const opened = command('shell', ui.ctx); assert.doesNotMatch(plain(ui.overlay().render(80).join('\n')), /SA scout/); ui.overlay().handleInput('\x1b'); await opened;
    for (const alias of ['', 'more', 'all', 'subagents']) { const p = command(alias, ui.ctx); ui.overlay().render(80); ui.overlay().handleInput('\x1b'); await p; }
    await command('collapse', ui.ctx); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
    const count = ui.calls.length; await command('wrong', ui.ctx); assert.equal(ui.calls.length, count);
    hosts.clear(); assert.notEqual(acquireBackgroundPanel(hosts.create()), first); assert.equal(hosts.registrations.length, 2);
  }
});
test('non-TUI/foreign owners never open, modify or bind; empty registry never opens', async () => {
  const { ui, panel } = setup(); const calls = ui.calls.length;
  for (const mode of ['rpc', 'json', 'print']) { const ctx = { ...ui.ctx, mode }; assert.equal(panel.attach('subagents', ctx), undefined); assert.equal(await panel.openMore(ctx), false); assert.equal(panel.toggle('collapse', ctx), false); }
  assert.equal(await panel.openMore({ ...ui.ctx, sessionManager: { getSessionId: () => 'other' } }), false);
  assert.equal(ui.calls.length, calls); assert.equal(ui.customCalls(), 0); const empty = new BackgroundPanel(); assert.equal(await empty.openMore(ui.ctx), false);
});
test('both real adapters use one key, aggregate batch tasks into one job; all disposal releases only owned key', () => {
  const hosts = hostPair(), ui = view(), shell = new ShellJobsWidget(hosts.create()), sub = new SubagentJobsWidget(hosts.create());
  shell.bind(ui.ctx, () => [{ jobId: 'shell', tool: 'powershell', status: 'running', command: 'test command' }]);
  sub.bind(ui.ctx, () => [{ jobId: 'batch', taskId: 'one', agent: 'worker', status: 'running', title: 'Build component', cancelRequested: false }, { jobId: 'batch', taskId: 'two', agent: 'reviewer', status: 'queued', cancelRequested: false }]);
  const text = plain(ui.component().render(120).join('\n')); assert.match(text, /2 active/); assert.match(text, /test command/); assert.match(text, /1 running \/ 1 queued/);
  shell.clear(); assert.match(plain(ui.component().render(80).join('\n')), /Build component/); sub.clear(); assert.equal(ui.widgets.size, 0);
});
test('width/height/Unicode/control caps and theme background continuity; resize invalidates hitbox', () => {
  const { ui, panel, shell, sub } = setup(); const malicious = job('1'); malicious.title = '\x1b]0;x\x07\x1b[2J\u202e界😀\n\t' + 'long'.repeat(500);
  panel.update('shell', shell, snapshot([malicious])); panel.update('subagents', sub, snapshot([])); const c = ui.component();
  for (const width of [0, 1, 2, 3, 6, 12, 24, 80]) for (const line of c.render(width)) { assert.equal(visibleWidth(line), width); assert.doesNotMatch(plain(line), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/); }
  ui.rows(12); assert.equal(c.render(80).length, 4); ui.rows(10); assert.equal(c.render(80).length, 2); assert.match(plain(c.render(80).at(-1)!), /\+1 active/);
  let ansi = theme.getBgAnsi(); const dynamic = { ...theme, getBgAnsi: () => ansi, bg: (_: string, s: string) => ansi + s + '\x1b[49m' };
  const changing = ui.factory()({ terminal: { rows: 40 }, requestRender() {} }, dynamic); changing.render(80); ansi = '\x1b[48;5;22m'; changing.invalidate(); assert.ok(changing.render(80).every((s: string) => s.startsWith(ansi)));
});
test('disposed getter/throwing UI isolated; transient removals retried and healthy updates recover', () => {
  for (const method of ['setStatus', 'setWidget'] as const) {
    const { ui, panel, shell, sub } = setup(); ui.statuses.set('gpt-speed', 'Fast'); ui.widgets.set('schedule', ['keep']);
    const stale = ui.component(); stale.render(80); const setter = ui.ctx.ui[method];
    ui.ctx.ui[method] = () => { throw new Error('transient UI fault'); };
    assert.doesNotThrow(() => { panel.update('shell', shell, snapshot([])); panel.update('subagents', sub, snapshot([])); }); assert.deepEqual(stale.render(80), []);
    ui.ctx.ui[method] = setter; panel.update('subagents', sub, snapshot([])); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
    assert.equal(ui.statuses.get('gpt-speed'), 'Fast'); assert.deepEqual(ui.widgets.get('schedule'), ['keep']);
    panel.update('shell', shell, snapshot([job('9')])); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), true);
    ui.ctx.sessionManager.getSessionId = () => { throw new Error('disposed'); }; assert.doesNotThrow(() => panel.update('shell', shell, snapshot([]))); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  }
});
test('overlay remains bounded for many records, scrolls to details, updates by events without reopening/focus loss', async () => {
  const { ui, panel, shell, sub } = setup(); panel.update('subagents', sub, snapshot([])); panel.update('shell', shell, snapshot(Array.from({ length: 25 }, (_, i) => job(String(i)))));
  const opened = panel.openMore(ui.ctx); assert.equal(await panel.openMore(ui.ctx), false); const c = ui.overlay();
  for (const width of [0, 1, 2, 3, 12, 72]) { const lines = c.render(width); assert.ok(lines.length <= 20); for (const line of lines) assert.ok(visibleWidth(line) <= width); }
  for (let i = 0; i < 15; i++) c.handleInput('\x1b[B'); c.render(72); c.handleInput('\r'); assert.match(plain(c.render(72).join('\n')), /Detail 15/);
  const before = ui.renders(); const updated = job('15'); updated.details = Array.from({ length: 40 }, (_, i) => `Row ${i}`); panel.update('shell', shell, snapshot([updated])); assert.ok(ui.renders() > before); assert.equal(ui.customCalls(), 1);
  c.handleInput('\x1b[6~'); assert.match(plain(c.render(72).join('\n')), /Row/);
  panel.update('shell', shell, snapshot([])); assert.match(plain(c.render(72).join('\n')), /no longer retained/); c.handleInput('\x03'); await opened; assert.equal(ui.draft(), '保留輸入中的文字');
});
test('history tab excludes active jobs and no answer/log is read; detach closes More', async () => {
  const { ui, panel, shell } = setup(); panel.update('shell', shell, snapshot([job('1'), job('2', 'shell', 'completed', false)]));
  const opened = panel.openMore(ui.ctx); const c = ui.overlay(); c.render(72); c.handleInput('\t'); const text = plain(c.render(72).join('\n')); assert.match(text, /Recent finished/); assert.match(text, /work 2/); assert.doesNotMatch(text, /work 1/);
  panel.detach('shell', shell); await opened; assert.equal(ui.overlay(), undefined);
});
test('usage is reported or pending/unknown, Shell N/A; finite zero is valid, malformed values rejected', () => {
  const valid = panelUsage({ totalTokens: 0, input: 0, output: 0, cost: { total: 0 } }); assert.equal(valid?.totalTokens, 0);
  for (const value of [{}, { totalTokens: NaN }, { totalTokens: Infinity }, { totalTokens: -1 }]) assert.equal(panelUsage(value), undefined);
  assert.equal(usageLabel({ usageState: 'unknown', active: false }), 'usage unknown'); assert.equal(usageLabel({ usageState: 'pending', active: true }), 'usage pending');
  assert.equal(usageLabel({ usageState: 'na', active: true }), 'tokens N/A'); assert.match(usageLabel({ usageState: 'reported', usage: valid, active: true }), /reported 0 tok\*/);
  const rows = Array.from({ length: 7 }, (_, i) => job(String(i))); const before = JSON.stringify(rows); renderJobs(rows, theme, 100); assert.equal(JSON.stringify(rows), before);
});
test('R1: owner getter becoming disposed during overlay render closes only its lease and never escapes into host rendering', async () => {
  const { ui, panel } = setup(); const opened = panel.openMore(ui.ctx); const c = ui.overlay(); c.render(72);
  const getter = ui.ctx.sessionManager.getSessionId;
  try {
    ui.ctx.sessionManager.getSessionId = () => { throw new Error('disposed owner'); };
    assert.doesNotThrow(() => assert.deepEqual(c.render(72), []));
    await opened; assert.equal(ui.overlay(), undefined); assert.equal(ui.draft(), '保留輸入中的文字');
    assert.deepEqual(c.render(72), []);
  } finally { ui.ctx.sessionManager.getSessionId = getter; c.handleInput('\x03'); await opened; }
});
test('W1: long detail height budgets preserve footer on resize including tiny terminals and narrow wrapping', () => {
  let rows = 40; const item = job('1'); item.details = Array.from({ length: 500 }, (_, i) => `Detail ${i} ` + '界'.repeat(100));
  const c = new JobsOverlay(() => [item], theme, () => {}, () => {}, () => rows); c.render(80); c.handleInput('\r');
  for (const height of [40, 24, 12, 6, 4, 3]) for (const width of [80, 12, 3, 1]) {
    rows = height; const lines = c.render(width);
    assert.ok(lines.length <= Math.max(1, Math.min(20, rows - 2)), `${width}x${height} rendered ${lines.length}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    if (width >= 40 && height >= 6) assert.match(plain(lines.at(-2)!), /Esc Back/);
  }
});
