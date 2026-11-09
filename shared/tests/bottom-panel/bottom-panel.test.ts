import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { bottomConfirm, bottomInput, bottomSelect, closeBottomPanel, isBottomPanelOpen, openBottomPanel, renderHiddenEditorPanel, type BottomBody } from '../../src/bottom-panel/index.ts';
import { fakeUi } from './fake-ui.ts';

const KEY = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', esc: '\x1b' };

test('a panel is drawn above the editor with a title rule, and takes the keyboard until done', async () => {
  const f = fakeUi();
  const seen: string[] = [];
  let body: BottomBody | undefined;
  const result = openBottomPanel<string>(f.ui, {
    key: 'k', title: () => 'Demo',
    create: ({ done }) => body = { render: () => ['row'], handleInput: data => { seen.push(data); if (data === 'q') done('bye'); } },
  });
  assert.ok(isBottomPanelOpen());
  assert.ok(f.log.includes('widget:k:set:aboveEditor'));
  const lines = f.render('k', 40);
  assert.match(lines[0]!, /^── Demo ─+$/);
  assert.equal(lines[1], ' row');
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);
  assert.equal(visibleWidth(lines[0]!), 40);
  assert.equal(f.type('a'), true, 'keys are consumed so the editor never sees them');
  assert.equal(f.type('q'), true);
  assert.equal(await result, 'bye');
  assert.deepEqual(seen, ['a', 'q']);
  assert.equal(isBottomPanelOpen(), false);
  assert.equal(f.widgets.size, 0, 'the widget is removed');
  assert.equal(f.listenerCount(), 0, 'the keyboard is released');
  assert.equal(f.type('x'), false);
  assert.ok(body);
});

test('mouse reports and focus events pass through so click regions and wheel scrolling keep working', async () => {
  const f = fakeUi();
  const result = openBottomPanel<void>(f.ui, { key: 'k', title: 't', create: ({ done }) => ({ render: () => [], handleInput: d => { if (d === 'q') done(); } }) });
  assert.equal(f.type('\x1b[<0;10;5M'), false);
  assert.equal(f.type('\x1b[<64;10;5M'), false);
  assert.equal(f.type('\x1b[O'), false);
  f.type('q'); await result;
});

test('only one panel at a time; closeBottomPanel resolves the open one with undefined', async () => {
  const f = fakeUi();
  let disposed = 0;
  const first = openBottomPanel<number>(f.ui, { key: 'a', title: 't', create: () => ({ render: () => [], handleInput() {}, dispose: () => { disposed++; } }) });
  assert.equal(await openBottomPanel<number>(f.ui, { key: 'b', title: 't', create: () => assert.fail('must not be created') }), undefined);
  closeBottomPanel();
  assert.equal(await first, undefined);
  assert.equal(disposed, 1);
  assert.equal(isBottomPanelOpen(), false);
  closeBottomPanel(); // harmless when nothing is open
});

test('a body that throws on input does not break the host or leak the key', async () => {
  const f = fakeUi();
  const result = openBottomPanel<number>(f.ui, { key: 'k', title: 't', create: ({ done }) => ({ render: () => [], handleInput: d => { if (d === 'x') throw new Error('boom'); done(7); } }) });
  assert.equal(f.type('x'), true);
  f.type('y');
  assert.equal(await result, 7);
});

test('a body that finishes while being created leaves nothing behind', async () => {
  const f = fakeUi();
  const result = await openBottomPanel<number>(f.ui, { key: 'k', title: 't', create: ({ done }) => { done(1); return { render: () => [], handleInput() {} }; } });
  assert.equal(result, 1);
  assert.equal(f.widgets.size, 0);
  assert.equal(f.listenerCount(), 0);
  assert.equal(isBottomPanelOpen(), false);
});

test('confirm: default is No, Enter keeps it, arrows toggle, y/n answer, Esc is No', async () => {
  const ctx = (f: ReturnType<typeof fakeUi>) => ({ mode: 'tui', hasUI: true, ui: Object.assign(f.ui, { confirm: async () => assert.fail('no fallback'), select: async () => assert.fail('no fallback') }) }) as never;
  let f = fakeUi();
  let answer = bottomConfirm(ctx(f), 'Allow?', 'Run it\nsecond line');
  const text = f.render('pi-better-tools-ask', 50).join('\n');
  assert.match(text, /Allow\?/); assert.match(text, /second line/); assert.match(text, /\[ Yes \] \[ No \]/);
  f.type(KEY.enter);
  assert.equal(await answer, false);
  f = fakeUi(); answer = bottomConfirm(ctx(f), 't', 'm'); f.type(KEY.right); f.type(KEY.enter);
  assert.equal(await answer, true);
  f = fakeUi(); answer = bottomConfirm(ctx(f), 't', 'm'); f.type('y');
  assert.equal(await answer, true);
  f = fakeUi(); answer = bottomConfirm(ctx(f), 't', 'm'); f.type('n');
  assert.equal(await answer, false);
  f = fakeUi(); answer = bottomConfirm(ctx(f), 't', 'm'); f.type(KEY.right); f.type(KEY.esc);
  assert.equal(await answer, false);
});

test('confirm and select fall back to the host dialogs outside the TUI', async () => {
  const calls: string[] = [];
  const base = { confirm: async (t: string) => { calls.push(`confirm:${t}`); return true; }, select: async (t: string) => { calls.push(`select:${t}`); return 'b'; } };
  const rpc = { mode: 'rpc', hasUI: true, ui: { ...base, ...fakeUi().ui } } as never;
  assert.equal(await bottomConfirm(rpc, 'T1', 'm'), true);
  assert.equal(await bottomSelect(rpc, 'T2', ['a', 'b']), 'b');
  assert.deepEqual(calls, ['confirm:T1', 'select:T2']);
});

test('select: arrows move, Enter picks, Esc cancels, long lists scroll within the screen', async () => {
  const options = Array.from({ length: 30 }, (_, i) => `option ${i}`);
  const ctx = (f: ReturnType<typeof fakeUi>) => ({ mode: 'tui', hasUI: true, ui: Object.assign(f.ui, { confirm: async () => assert.fail(), select: async () => assert.fail() }) }) as never;
  let f = fakeUi({ rows: 24 });
  let picked = bottomSelect(ctx(f), 'Pick', options);
  f.type(KEY.down); f.type(KEY.down);
  const lines = f.render('pi-better-tools-ask', 40);
  assert.ok(lines.length <= 24 - 4, `fits the screen: ${lines.length}`);
  assert.ok(lines.some(l => l.includes('▸ option 2')));
  f.type(KEY.enter);
  assert.equal(await picked, 'option 2');
  f = fakeUi(); picked = bottomSelect(ctx(f), 'Pick', options); f.type(KEY.up); f.type(KEY.enter);
  assert.equal(await picked, 'option 29', 'wraps around');
  f = fakeUi(); picked = bottomSelect(ctx(f), 'Pick', options); f.type(KEY.esc);
  assert.equal(await picked, undefined);
});

test('confirm: a message taller than the room scrolls so nothing is approved unseen, and the hint says how far', async () => {
  const f = fakeUi({ rows: 24 });
  const message = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const answer = bottomConfirm({ mode: 'tui', hasUI: true, ui: Object.assign(f.ui, { confirm: async () => assert.fail(), select: async () => assert.fail() }) } as never, 'SQL', message);
  let text = f.render('pi-better-tools-ask', 60).join('\n');
  assert.match(text, /line 0/); assert.doesNotMatch(text, /line 39/);
  assert.match(text, /↑\/↓ PgUp\/PgDn scroll\s+lines 1-\d+ of 40/);
  for (let i = 0; i < 60; i++) f.type('\x1b[B');
  text = f.render('pi-better-tools-ask', 60).join('\n');
  assert.match(text, /line 39/); assert.doesNotMatch(text, /line 0\b/);
  f.type('y');
  assert.equal(await answer, true);
});

test('PgUp/PgDn page the confirm message and the select list', async () => {
  const ui = (f: ReturnType<typeof fakeUi>) => ({ mode: 'tui', hasUI: true, ui: Object.assign(f.ui, { confirm: async () => assert.fail(), select: async () => assert.fail() }) }) as never;
  let f = fakeUi({ rows: 24 });
  const answer = bottomConfirm(ui(f), 'SQL', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
  f.render('pi-better-tools-ask', 60);
  f.type('\x1b[6~');
  let text = f.render('pi-better-tools-ask', 60).join('\n');
  assert.doesNotMatch(text, /line 0\b/); assert.match(text, /lines (?!1-)\d+-/);
  f.type('\x1b[5~');
  assert.match(f.render('pi-better-tools-ask', 60).join('\n'), /lines 1-/);
  f.type('n'); assert.equal(await answer, false);
  f = fakeUi({ rows: 24 });
  const options = Array.from({ length: 30 }, (_, i) => `option ${i}`);
  const picked = bottomSelect(ui(f), 'Pick', options);
  f.render('pi-better-tools-ask', 40);
  f.type('\x1b[6~');
  text = f.render('pi-better-tools-ask', 40).join('\n');
  assert.doesNotMatch(text, /▸ option 0\b/); assert.match(text, /▸ option \d+/);
  f.type('\x1b[5~'); f.type('\r');
  assert.equal(await picked, 'option 0');
});

test('confirm and select close as No / cancelled when the signal aborts, even if it was already aborted', async () => {
  const ctxFor = (f: ReturnType<typeof fakeUi>) => ({ mode: 'tui', hasUI: true, ui: Object.assign(f.ui, { confirm: async () => assert.fail(), select: async () => assert.fail() }) }) as never;
  let f = fakeUi();
  const controller = new AbortController();
  const answer = bottomConfirm(ctxFor(f), 't', 'm', { signal: controller.signal });
  controller.abort();
  assert.equal(await answer, false);
  assert.equal(f.widgets.size, 0); assert.equal(isBottomPanelOpen(), false);
  f = fakeUi();
  const done = AbortSignal.abort();
  assert.equal(await bottomSelect(ctxFor(f), 't', ['a', 'b'], { signal: done }), undefined);
  assert.equal(isBottomPanelOpen(), false);
});

test('select with one or two options shows every option (the visible window never exceeds the list)', async () => {
  const ctx = (f: ReturnType<typeof fakeUi>) => ({ mode: 'tui', hasUI: true, ui: Object.assign(f.ui, { confirm: async () => assert.fail(), select: async () => assert.fail() }) }) as never;
  for (const options of [['only'], ['first', 'second']]) {
    const f = fakeUi();
    const picked = bottomSelect(ctx(f), 'Pick', options);
    const text = f.render('pi-better-tools-ask', 40).join('\n');
    for (const option of options) assert.ok(text.includes(option), `${option} is visible`);
    f.type(KEY.enter);
    assert.equal(await picked, options[0]);
  }
});

test('a question raised while another panel is open waits for it instead of falling back to a host dialog that could not get keys', async () => {
  const f = fakeUi();
  const host = { confirm: async () => assert.fail('no host dialog'), select: async () => assert.fail('no host dialog') };
  const ctx = { mode: 'tui', hasUI: true, ui: Object.assign(f.ui, host) } as never;
  const first = openBottomPanel<void>(f.ui, { key: 'jobs', title: 'Jobs', create: ({ done }) => ({ render: () => ['x'], handleInput: d => { if (d === 'q') done(); } }) });
  const answer = bottomConfirm(ctx, 'SQL', 'update?');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.render('pi-better-tools-ask').length, 0, 'not shown yet');
  f.type('q'); await first;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.render('pi-better-tools-ask').length > 0, 'shown once the first panel closed');
  f.type('y');
  assert.equal(await answer, true);
  // and an abort while waiting ends the wait with No
  const f2 = fakeUi();
  const blocker = openBottomPanel<void>(f2.ui, { key: 'jobs', title: 'Jobs', create: ({ done }) => ({ render: () => ['x'], handleInput: () => done() }) });
  const controller = new AbortController();
  const waiting = bottomConfirm({ mode: 'tui', hasUI: true, ui: Object.assign(f2.ui, host) } as never, 'SQL', 'm', { signal: controller.signal });
  controller.abort();
  assert.equal(await waiting, false);
  f2.type('x'); await blocker;
});

test('input: typing, paste, backspace and Ctrl+U edit one line; Enter submits, Esc cancels, required refuses empty text', async () => {
  const ctx = (f: ReturnType<typeof fakeUi>) => ({ mode: 'tui', hasUI: true, ui: f.ui }) as never;
  let f = fakeUi();
  let answer = bottomInput(ctx(f), 'Name', 'Job name?', { initial: 'x' });
  for (const key of ['a', 'b', 'c']) f.type(key);
  f.type('\x7f');
  f.type('\x1b[200~ d\ne\x1b[201~');
  assert.match(f.render('pi-better-tools-ask', 40).join('\n'), /❯ xab d e_/);
  f.type(KEY.enter);
  assert.equal(await answer, 'xab d e');
  f = fakeUi(); answer = bottomInput(ctx(f), 'Name', 'Job name?'); f.type('z'); f.type('\x15'); f.type(KEY.enter);
  assert.equal(await answer, '', 'an empty line is a valid answer');
  f = fakeUi(); answer = bottomInput(ctx(f), 'Name', 'Job name?', { required: true }); f.type(KEY.enter); f.type('k'); f.type(KEY.enter);
  assert.equal(await answer, 'k', 'Enter on empty required text does nothing');
  f = fakeUi(); answer = bottomInput(ctx(f), 'Name', 'Job name?'); f.type('q'); f.type(KEY.esc);
  assert.equal(await answer, undefined);
  assert.equal(await bottomInput({ mode: 'rpc', hasUI: true, ui: fakeUi().ui } as never, 'T', 'p'), undefined, 'no host fallback outside the TUI');
});

test('hideEditor only takes effect once an editor that can draw the panel exists; otherwise the panel is a normal widget', async () => {
  const body = { render: () => ['row'], handleInput(_data: string) {} };
  const first = fakeUi();
  const shown = openBottomPanel<string>(first.ui, { key: 'k', title: 'T', hideEditor: true, create: () => body });
  assert.equal(renderHiddenEditorPanel(20), undefined, 'no hidden panel while nothing has asked as an editor');
  assert.ok(first.render('k', 20).length > 0, 'the widget draws it, so the prompt is never invisible');
  closeBottomPanel(); await shown;
  const second = fakeUi();
  const hidden = openBottomPanel<string>(second.ui, { key: 'k', title: 'T', hideEditor: true, create: () => body });
  assert.equal(renderHiddenEditorPanel(20)?.length, 3, 'with an editor present the editor slot draws it');
  assert.equal(second.render('k', 20).length, 0);
  closeBottomPanel(); await hidden;
});
