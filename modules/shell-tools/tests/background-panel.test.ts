import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import { BackgroundPanel, BACKGROUND_WIDGET_KEY, acquireBackgroundPanel, type PanelKind } from '../src/background-panel.js';
import { ShellJobsWidget } from '../src/live-widget.js';
import { SubagentJobsWidget } from '../../subagents/extensions/subagent/live-widget.ts';
const theme: any = { fg: (_: string, s: string) => `\x1b[32m${s}\x1b[0m`, getBgAnsi: () => '\x1b[48;5;58m', bg: (_: string, s: string) => '\x1b[48;5;58m' + s + '\x1b[49m' };
function view() {
  let owner = 'owner', renders = 0; const widgets = new Map<string, any>(), statuses = new Map<string, string>(), calls: any[] = [];
  const ctx: any = { cwd: '/cwd', mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => owner }, ui: { setStatus(key: string, value: string | undefined) { if (value) statuses.set(key, value); else statuses.delete(key); }, setWidget(key: string, value: any, options: any) { calls.push({ key, value, options }); if (value) widgets.set(key, value); else widgets.delete(key); }, notify() {} } };
  return { ctx, widgets, statuses, calls, status: () => statuses.get(BACKGROUND_WIDGET_KEY) ?? '', owner: (id: string) => owner = id, factory: () => widgets.get(BACKGROUND_WIDGET_KEY), component: () => widgets.get(BACKGROUND_WIDGET_KEY)({ requestRender: () => renders++ }, theme), renders: () => renders };
}
const snapshot = (count: number, text: string, active = count > 0) => ({ count, active, signature: `${count}:${text}:${active}`, details: () => [text] });
function mouse(component: any, x: number, width = 80, options: any = {}) { return component.handleMouse({ type: 'click', button: 'left', x, y: 0, screenX: x, screenY: 0, width, height: 1, shift: false, alt: false, ctrl: false, clickCount: 1, ...options }); }
function setup(expand = true) { const ui = view(), panel = new BackgroundPanel(), shell = panel.attach('shell', ui.ctx)!, sub = panel.attach('subagents', ui.ctx)!; panel.update('shell', shell, snapshot(2, 'SHELL SECRET')); panel.update('subagents', sub, snapshot(3, 'SUB SECRET')); if (expand) panel.toggle('shell'); return { ui, panel, shell, sub }; }
function hostPair() {
  const handlers = new Map<string, Set<Function>>(), commands = new Map<string, any>(), registrations: string[] = [];
  const create = () => ({ events: { emit(channel: string, data: unknown) { for (const handler of handlers.get(channel) ?? []) handler(data); }, on(channel: string, handler: Function) { if (!handlers.has(channel)) handlers.set(channel, new Set()); handlers.get(channel)!.add(handler); return () => handlers.get(channel)!.delete(handler); } }, registerCommand(name: string, definition: any) { registrations.push(name); commands.set(name, definition); } });
  return { create, commands, registrations, clear: () => handlers.clear() };
}
test('native footer summary only while collapsed; command expands details without replacing footer or other statuses', () => {
  const { ui, panel } = setup(false); ui.widgets.set('schedule', ['preserved']); ui.statuses.set('gpt-speed', 'Fast');
  assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.match(ui.status(), /▸ Subagents：3 ｜ ▸ Shell：2/); assert.doesNotMatch(ui.status(), /SECRET|\x1b/);
  panel.toggle('subagents'); const expanded = ui.component(); assert.deepEqual(expanded.render(80).slice(1), ['SUB SECRET']);
  assert.equal(ui.calls.at(-1).options.placement, 'belowEditor');
  const first = mouse(expanded, 25); assert.equal(first?.handled, true); assert.notEqual(first?.focus, true);
  const both = ui.component(); assert.deepEqual(both.render(80).slice(1), ['SUB SECRET', 'SHELL SECRET']);
  assert.equal(mouse(expanded, 3), undefined, 'superseded component cannot toggle current work');
  panel.toggle('collapse'); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.match(ui.status(), /▸ Subagents：3/);
  assert.equal(ui.statuses.get('gpt-speed'), 'Fast'); assert.deepEqual(ui.widgets.get('schedule'), ['preserved']);
});
test('public SDK Container routes mouse to the shared widget without claiming keyboard focus', () => {
  const { ui, panel } = setup(false), container = new Container(); panel.toggle('subagents'); container.addChild(ui.component()); container.render(80);
  const result = mouse(container, 25); assert.equal(result?.handled, true); assert.notEqual(result?.focus, true); assert.deepEqual(ui.component().render(80).slice(1), ['SUB SECRET', 'SHELL SECRET']);
});
test('mouse ignores details, separators, right click, modifiers, wheel/drag, multiple clicks and stale resize', () => {
  const { ui } = setup(); const c = ui.component(); c.render(80); const before = ui.calls.length;
  for (const options of [{ y: 1 }, { button: 'right' }, { shift: true }, { alt: true }, { ctrl: true }, { type: 'wheel' }, { type: 'drag' }, { clickCount: 2 }]) assert.equal(mouse(c, 3, 80, options), undefined);
  assert.equal(mouse(c, 16), undefined, 'separator is not a hit target'); assert.equal(mouse(c, 3, 24), undefined);
  c.invalidate(); assert.equal(mouse(c, 3), undefined); assert.equal(ui.calls.length, before);
  c.render(80); assert.equal(mouse(c, 3, 80, { type: 'press' }), undefined, 'do not mark the gesture handled before a potential drag-selection'); assert.equal(mouse(c, 3, 80, { type: 'drag' }), undefined); assert.equal(ui.calls.length, before);
  c.dispose(); assert.equal(mouse(c, 3), undefined);
});
test('expansion survives data changes, resets when empty; detach never drops the other producer', () => {
  const { ui, panel, shell, sub } = setup(false); panel.toggle('shell'); panel.update('shell', shell, snapshot(1, 'NEXT'));
  assert.deepEqual(ui.component().render(80).slice(1), ['NEXT']); panel.update('shell', shell, snapshot(0, 'EMPTY'));
  assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); panel.update('shell', shell, snapshot(1, 'NEW')); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  panel.detach('shell', shell); assert.match(ui.status(), /Subagents：3.*Shell：0/);
  panel.detach('subagents', sub); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.equal(ui.status(), '');
});
test('source replacement/owner changes fence old leases and old pointer components', () => {
  const { ui, panel, shell, sub } = setup(); const old = ui.component(); old.render(80);
  ui.owner('next'); const fresh = panel.attach('shell', ui.ctx)!; panel.update('shell', fresh, snapshot(1, 'FRESH'));
  const count = ui.calls.length; panel.update('subagents', sub, snapshot(9, 'OLD')); panel.detach('shell', shell); assert.equal(ui.calls.length, count);
  assert.equal(mouse(old, 3), undefined); assert.match(ui.status(), /Subagents：0.*Shell：1/); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  ui.owner('replaced'); assert.equal(panel.toggle('shell'), false); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.equal(ui.status(), '');
});
test('finalizing is expandable but not counted as a running subagent', () => {
  const { ui, panel, sub, shell } = setup(); panel.update('shell', shell, snapshot(0, '')); panel.update('subagents', sub, snapshot(0, 'FINALIZING', true));
  assert.match(ui.status(), /Subagents：0.*Shell：0/); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); panel.toggle('subagents'); assert.deepEqual(ui.component().render(80).slice(1), ['FINALIZING']);
  panel.update('subagents', sub, snapshot(0, '')); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
});
test('distinct API event wrappers rendezvous once in either order; reload receives fresh presentation state', async () => {
  for (const order of [['shell', 'subagents'], ['subagents', 'shell']] as PanelKind[][]) {
    const hosts = hostPair(), a = hosts.create(), b = hosts.create(), first = acquireBackgroundPanel(a), second = acquireBackgroundPanel(b); assert.equal(first, second); assert.notEqual(a.events, b.events); assert.deepEqual(hosts.registrations, ['background-jobs']);
    const ui = view(); for (const kind of order) { const token = first.attach(kind, ui.ctx)!; first.update(kind, token, snapshot(1, kind)); }
    assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
    await hosts.commands.get('background-jobs').handler('shell', ui.ctx); assert.deepEqual(ui.component().render(80).slice(1), ['shell']);
    await hosts.commands.get('background-jobs').handler('', ui.ctx); assert.deepEqual(ui.component().render(80).slice(1), ['subagents', 'shell']);
    await hosts.commands.get('background-jobs').handler('collapse', ui.ctx); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.match(ui.status(), /▸ Shell：1/);
    const count = ui.calls.length; await hosts.commands.get('background-jobs').handler('wrong', ui.ctx); assert.equal(ui.calls.length, count);
    hosts.clear(); const fresh = acquireBackgroundPanel(hosts.create()); assert.notEqual(first, fresh); assert.equal(hosts.registrations.length, 2);
  }
});
test('commands cannot mutate other owners or non-TUI clients; no inactive bindings or mouse claims', async () => {
  const hosts = hostPair(), panel = acquireBackgroundPanel(hosts.create()), ui = view(), token = panel.attach('shell', ui.ctx)!; panel.update('shell', token, snapshot(1, 'work'));
  const command = hosts.commands.get('background-jobs').handler;
  for (const mode of ['rpc', 'json', 'print']) { const foreign = { ...ui.ctx, mode }; assert.equal(panel.attach('subagents', foreign), undefined); await command('all', foreign); }
  await command('all', { ...ui.ctx, sessionManager: { getSessionId: () => 'other' } });
  assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.equal(panel.toggle('subagents'), false, 'zero subagents cannot expand');
});
test('both actual adapters share a single row; title/command stay hidden until expansion, all disposal releases key', () => {
  const hosts = hostPair(), api = hosts.create(), ui = view(), shell = new ShellJobsWidget(api), sub = new SubagentJobsWidget(hosts.create());
  shell.bind(ui.ctx, () => [{ jobId: 'abc', tool: 'powershell', status: 'running', command: 'secret command' }]);
  sub.bind(ui.ctx, () => [{ jobId: 'job', taskId: 'task', agent: 'worker', status: 'running', title: 'secret title', cancelRequested: false }]);
  assert.equal(ui.widgets.size, 0); assert.doesNotMatch(ui.status(), /secret/);
  acquireBackgroundPanel(api).toggle('all'); const text = plain(ui.component().render(80).join('\n')); assert.match(text, /secret command/); assert.match(text, /secret title/);
  shell.clear(); assert.match(plain(ui.component().render(80).join('\n')), /secret title/); sub.clear(); assert.equal(ui.widgets.size, 0); assert.equal(ui.status(), '');
});
test('narrow/full width fill and hitboxes use visible cells, no wrapping; palette/resize invalidates correctly', () => {
  const { ui } = setup(); const c = ui.component();
  for (const width of [0, 1, 2, 3, 6, 12, 24, 80]) { const lines = c.render(width); assert.equal(lines.length, 2); assert.equal(visibleWidth(lines[0]), width); }
  c.render(24); assert.equal(mouse(c, 3, 24)?.handled, true, 'short label maps to subagents');
  const { ui: other } = setup(); let ansi = theme.getBgAnsi(); const dynamic = { ...theme, getBgAnsi: () => ansi, bg: (_: string, s: string) => ansi + s + '\x1b[49m' };
  const changing = other.factory()({ requestRender() {} }, dynamic); changing.render(80); ansi = '\x1b[48;5;22m'; changing.invalidate(); assert.equal(mouse(changing, 3), undefined); assert.ok(changing.render(80)[0].startsWith(ansi));
});
test('compact and clipped headers never claim partially displayed labels', () => {
  const { ui } = setup(); const c = ui.component(); assert.ok(plain(c.render(12)[0]).includes('S:3|Sh:2'));
  c.render(7); assert.equal(mouse(c, 2, 7), undefined, 'ellipsis clips the first label at this width');
  c.render(8); assert.equal(mouse(c, 2, 8)?.handled, true, 'first compact label is fully visible before ellipsis');
});
test('disposed owner getter and throwing UI do not escape observers; a later healthy update can recover', () => {
  const ui = view(), panel = new BackgroundPanel(), token = panel.attach('shell', ui.ctx)!; const original = ui.ctx.ui.setWidget;
  ui.ctx.ui.setWidget = () => { throw new Error('UI failed'); }; assert.doesNotThrow(() => panel.update('shell', token, snapshot(1, 'x')));
  ui.ctx.ui.setWidget = original; panel.update('shell', token, snapshot(1, 'x')); assert.equal(ui.widgets.size, 0); assert.match(ui.status(), /Shell：1/); panel.toggle('shell'); assert.equal(ui.widgets.size, 1);
  ui.ctx.sessionManager.getSessionId = () => { throw new Error('disposed'); }; assert.doesNotThrow(() => panel.update('shell', token, snapshot(1, 'x'))); assert.equal(ui.widgets.size, 0); assert.equal(ui.status(), '');
});
test('footer setter failure still clears widget, isolates other keys, and permits later recovery', () => {
  const { ui, panel, shell, sub } = setup(); ui.statuses.set('gpt-speed', 'Fast');
  const setStatus = ui.ctx.ui.setStatus;
  ui.ctx.ui.setStatus = () => { throw new Error('footer disposed'); };
  assert.doesNotThrow(() => panel.update('shell', shell, snapshot(1, 'changed')));
  assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false);
  ui.ctx.ui.setStatus = setStatus; panel.update('shell', shell, snapshot(1, 'changed'));
  assert.match(ui.status(), /Shell：1/); assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), true);
  panel.detach('shell', shell); panel.detach('subagents', sub);
  assert.deepEqual([...ui.statuses], [['gpt-speed', 'Fast']]);
});
test('transient removal failures are retried on empty updates without reviving stale components', () => {
  for (const method of ['setStatus', 'setWidget'] as const) {
    const { ui, panel, shell, sub } = setup(); ui.statuses.set('gpt-speed', 'Fast'); ui.widgets.set('schedule', ['keep']);
    const stale = ui.component(); stale.render(80); const setter = ui.ctx.ui[method];
    ui.ctx.ui[method] = (key: string, value: any, options: any) => { if (value === undefined) throw new Error('transient removal fault'); setter(key, value, options); };
    panel.update('shell', shell, snapshot(0, '')); panel.update('subagents', sub, snapshot(0, ''));
    assert.equal(mouse(stale, 3), undefined); assert.deepEqual(stale.render(80), []);
    assert.equal(method === 'setStatus' ? ui.statuses.has(BACKGROUND_WIDGET_KEY) : ui.widgets.has(BACKGROUND_WIDGET_KEY), true, 'the simulated failed deletion really left stale UI');
    ui.ctx.ui[method] = setter; panel.update('subagents', sub, snapshot(0, ''));
    assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false); assert.equal(ui.status(), '');
    assert.equal(ui.statuses.get('gpt-speed'), 'Fast'); assert.deepEqual(ui.widgets.get('schedule'), ['keep']);
    panel.update('shell', shell, snapshot(1, 'new work')); assert.match(ui.status(), /Shell：1/);
    assert.equal(ui.widgets.has(BACKGROUND_WIDGET_KEY), false, 'completed work resets expansion before subsequent work');
  }
});
