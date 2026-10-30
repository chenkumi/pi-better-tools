import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SettingsPanel, applyPatches, readRaw, writeJsonAtomic, type Field, type PanelOptions } from '../src/settings-panel/index.js';

const style = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', enter: '\r', esc: '\x1b', save: '\x13' };

test('applyPatches keeps unknown keys, deletes on undefined and prunes emptied parents', () => {
  const raw = { extra: 'hand-edited', providers: { brave: { apiKey: 'K' }, exa: { apiKeyEnv: 'E' } } };
  const next = applyPatches(raw, [
    { path: ['providers', 'brave', 'apiKey'], value: undefined },
    { path: ['fetch', 'timeoutMs'], value: 5000 },
    { path: ['providers', 'deepseek', 'apiKey'], value: undefined }, // nothing to delete, no object created
  ]);
  assert.deepEqual(next, { extra: 'hand-edited', providers: { exa: { apiKeyEnv: 'E' } }, fetch: { timeoutMs: 5000 } });
  assert.equal(raw.providers.brave.apiKey, 'K', 'input is not mutated');
});

test('readRaw distinguishes missing, ok and invalid without echoing contents; writes are atomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-settings-panel-'));
  try {
    const file = join(dir, 'nested', 'c.json');
    assert.equal(readRaw(file).state, 'missing');
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(readRaw(file), { state: 'ok', raw: { a: 1 } });
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['c.json'], 'no temp file left behind');
    writeFileSync(file, '{"apiKey":"SECRET",}');
    const bad = readRaw(file);
    assert.equal(bad.state, 'invalid');
    assert.ok(!JSON.stringify(bad).includes('SECRET'));
    writeFileSync(file, '[]');
    assert.equal(readRaw(file).state, 'invalid');
    assert.throws(() => writeJsonAtomic('relative.json', {}), /absolute/);
    assert.equal(readFileSync(file, 'utf8'), '[]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const fields: Field[] = [
  { key: 'mode', type: 'enum', group: 'G', label: 'Mode', options: ['a', 'b'] },
  { key: 'on', type: 'boolean', group: 'G', label: 'On' },
  { key: 'n', type: 'int', group: 'G', label: 'N', min: 1, max: 5 },
  { key: 'token', type: 'secret', group: 'B', tab: 'G', label: 'Token', visibleWhen: v => v.mode === 'b', configured: () => false },
];
function make(over: Partial<PanelOptions> = {}) {
  const calls: { values: Record<string, unknown>; dirty: string[] }[] = [];
  const closed: boolean[] = [];
  const panel = new SettingsPanel({
    title: 'T', fields, values: { mode: 'a', on: false, n: 3 }, style, rows: () => 30, requestRender() {},
    async onSave(values, dirty) { calls.push({ values: { ...values }, dirty: [...dirty] }); return undefined; },
    onClose: saved => closed.push(saved), ...over,
  });
  return { panel, calls, closed };
}
const type = (panel: SettingsPanel, text: string) => { for (const ch of text) panel.handleInput(ch); };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('panel: provider-dependent fields appear and disappear with the live value', () => {
  const { panel } = make();
  assert.ok(!panel.render(60).join('\n').includes('Token'));
  panel.handleInput(KEY.right); // mode -> b
  assert.ok(panel.render(60).join('\n').includes('Token'));
  panel.handleInput(KEY.right); // mode -> a
  assert.ok(!panel.render(60).join('\n').includes('Token'));
});

test('panel: int validation keeps the editor open; valid edits save only the changed keys', async () => {
  const { panel, calls, closed } = make();
  panel.handleInput(KEY.down); panel.handleInput(KEY.down); // n
  panel.handleInput(KEY.enter); type(panel, '99'); // out of range after the existing "3"
  panel.handleInput(KEY.enter);
  assert.match(panel.render(60).join('\n'), /integer from 1 to 5/);
  panel.handleInput('\x15'); type(panel, '4'); panel.handleInput(KEY.enter);
  panel.handleInput(KEY.save); await settle();
  assert.deepEqual(calls, [{ values: { mode: 'a', on: false, n: 4 }, dirty: ['n'] }]);
  assert.deepEqual(closed, [true]);
});

test('panel: secret text is masked in every render, only reaches onSave, and is dropped on dispose', async () => {
  const { panel, calls } = make();
  panel.handleInput(KEY.right); // mode -> b, reveals Token
  panel.handleInput(KEY.down); panel.handleInput(KEY.down); panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter); type(panel, 'sk-TOPSECRET');
  assert.ok(!panel.render(60).join('\n').includes('TOPSECRET'), 'masked while typing');
  panel.handleInput(KEY.enter);
  assert.ok(!panel.render(60).join('\n').includes('TOPSECRET'), 'masked after commit');
  panel.handleInput(KEY.save); await settle();
  assert.equal(calls[0]!.values.token, 'sk-TOPSECRET');
  assert.deepEqual(calls[0]!.dirty.sort(), ['mode', 'token']);
});

test('panel: hidden fields are not dirty, a failed save keeps the panel open with the message', async () => {
  const { panel, closed } = make({ async onSave() { return 'CONFIG_INVALID: nope'; } });
  panel.handleInput(KEY.right); // mode -> b
  panel.handleInput(KEY.down); panel.handleInput(KEY.down); panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter); type(panel, 'x'); panel.handleInput(KEY.enter);
  panel.handleInput(KEY.up); panel.handleInput(KEY.up); panel.handleInput(KEY.up);
  panel.handleInput(KEY.right); // back to a: token hidden again
  assert.deepEqual([...panel.dirty], []);
  panel.handleInput(KEY.right); // b again, dirty
  panel.handleInput(KEY.save); await settle();
  assert.match(panel.render(60).join('\n'), /CONFIG_INVALID: nope/);
  assert.deepEqual(closed, []);
});

test('panel: Esc asks once before discarding unsaved changes', () => {
  const { panel, closed } = make();
  panel.handleInput(KEY.right);
  panel.handleInput(KEY.esc);
  assert.deepEqual(closed, []);
  panel.handleInput(KEY.esc);
  assert.deepEqual(closed, [false]);
});

test('panel: framed, fixed-height render; one row per line, help always reserved, long help ellipsised', async () => {
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  const long = 'x'.repeat(200);
  const { panel } = make({ fields: [...fields.slice(0, 3).map((f, i) => (i === 0 ? { ...f, help: long } : f)), fields[3]!] });
  const before = panel.render(60);
  assert.match(before[0]!, /^.*╭──.* T .*╮/); assert.match(before.at(-1)!, /╰─+╯/);
  for (const line of before) assert.equal(visibleWidth(line), 60);
  assert.ok(before.some(l => l.includes('…')), 'long help is ellipsised on one row');
  panel.handleInput(KEY.right); // reveals the hidden Token row
  panel.handleInput(KEY.down);
  const after = panel.render(60);
  assert.equal(after.length, before.length, 'height does not change when fields appear or the help line is empty');
  for (const line of after) assert.equal(visibleWidth(line), 60);
});

test('panel: pages — Tab switches, all pages share one height, a single-group page has no heading, hidden pages vanish from the bar', async () => {
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  const paged: Field[] = [
    { key: 'a', type: 'boolean', group: 'One', label: 'A1' },
    { key: 'b', type: 'boolean', group: 'One', label: 'B1' },
    { key: 'c', type: 'boolean', group: 'One', label: 'C1' },
    { key: 'd', type: 'boolean', group: 'Two', label: 'D2' },
    { key: 'x', type: 'boolean', group: 'Three', label: 'X3', visibleWhen: v => v.d === true },
  ];
  const { panel } = make({ fields: paged, values: { a: false, b: false, c: false, d: false, x: false } });
  const one = panel.render(60);
  assert.match(one.join('\n'), /\[ One \].*Two/);
  assert.ok(!one.join('\n').includes('Three'), 'a page with no visible field is not in the bar');
  panel.handleInput('\t');
  const two = panel.render(60);
  assert.match(two.join('\n'), /\[ Two \]/); assert.match(two.join('\n'), /D2/); assert.ok(!two.join('\n').includes('A1'));
  assert.equal(two.length, one.length, 'pages share one height');
  panel.handleInput(' '); // d = true: the third page appears
  assert.match(panel.render(60).join('\n'), /Three/);
  panel.handleInput('\x1b[Z'); // Shift+Tab back to One
  assert.match(panel.render(60).join('\n'), /\[ One \]/);
  for (const line of panel.render(60)) assert.equal(visibleWidth(line), 60);
  assert.equal(panel.render(60).length, one.length, 'a page appearing does not resize the dialog');
});

function actionPanel(run: (c: { signal: AbortSignal; progress(t: string): void }) => Promise<string>) {
  let state = 'not installed', runs = 0;
  const fields: Field[] = [{ key: 'go', type: 'action', group: 'G', label: 'Download', confirm: 'Download it?', status: () => state, run: async c => { runs++; const text = await run(c); state = 'installed'; return text; } }];
  const panel = new SettingsPanel({ title: 'T', fields, values: {}, style, rows: () => 30, requestRender() {}, async onSave() { return undefined; }, onClose() {} });
  return { panel, runs: () => runs };
}
const text = (p: SettingsPanel) => p.render(80).join('\n');

test('panel action: needs a second Enter, any other key disarms, status refreshes after the run', async () => {
  const { panel, runs } = actionPanel(async () => 'Done.');
  assert.match(text(panel), /not installed/);
  panel.handleInput(KEY.enter);
  assert.match(text(panel), /Download it\? Enter starts/);
  assert.equal(runs(), 0);
  panel.handleInput(KEY.down); // disarms
  panel.handleInput(KEY.enter); assert.equal(runs(), 0, 'armed again, not started');
  panel.handleInput(KEY.enter); await settle(); await settle();
  assert.equal(runs(), 1);
  assert.match(text(panel), /Done\./); assert.match(text(panel), /installed/);
  assert.deepEqual([...panel.dirty], [], 'an action is never a saved value');
});

test('panel action: progress shows, Esc cancels the run instead of closing, failures stay in the panel', async () => {
  let release!: () => void, seen: AbortSignal | undefined;
  const closed: boolean[] = [];
  const fields: Field[] = [{ key: 'go', type: 'action', group: 'G', label: 'Download', confirm: 'Go?', status: () => 'idle',
    run: ({ signal, progress }) => new Promise((_ok, fail) => { seen = signal; progress('42%'); release = () => fail(new Error('Cancelled by test.')); signal.addEventListener('abort', release); }) }];
  const panel = new SettingsPanel({ title: 'T', fields, values: {}, style, rows: () => 30, requestRender() {}, async onSave() { return undefined; }, onClose: s => closed.push(s) });
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter); await settle();
  assert.match(text(panel), /42%/); assert.match(text(panel), /running/);
  panel.handleInput(KEY.down); panel.handleInput(KEY.save); // ignored while running
  panel.handleInput(KEY.esc);
  assert.equal(seen!.aborted, true); assert.deepEqual(closed, [], 'Esc cancels the action, the panel stays open');
  await settle();
  assert.match(text(panel), /Cancelled by test\./);
});

test('panel action: closing the panel aborts a running action', async () => {
  let seen: AbortSignal | undefined;
  const fields: Field[] = [{ key: 'go', type: 'action', group: 'G', label: 'D', confirm: 'Go?', status: () => 's', run: ({ signal }) => { seen = signal; return new Promise(() => {}); } }];
  const panel = new SettingsPanel({ title: 'T', fields, values: {}, style, rows: () => 30, requestRender() {}, async onSave() { return undefined; }, onClose() {} });
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  panel.dispose();
  assert.equal(seen!.aborted, true);
});
