import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createToolRenderer, MAX_EXPANDED_LINES } from '../src/tool-render/renderer.ts';
import { callTitle, formatDuration, resultView, safeText } from '../src/tool-render/summary.ts';

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });
const ctx = (extra: object = {}) => ({ isError: false, isPartial: false, expanded: false, durationMs: 200, ...extra });
const renderers = (name: string, next: () => any = () => 'NEXT') => createToolRenderer()(name, next) as any;
const call = (name: string, args: unknown, width = 80, context = ctx()) => renderers(name).renderCall(args, theme, context).render(width).map(plain) as string[];
const result = (name: string, value: unknown, width = 80, context = ctx()) => renderers(name).renderResult(value, { expanded: context.expanded, isPartial: context.isPartial }, theme, context).render(width).map(plain) as string[];

test('titles: shell tools show the command with the timeout kept, others the most specific argument', () => {
  assert.deepEqual(callTitle('bash', { command: 'ls -la\nsecond', timeoutMs: 20000 }), { label: '$', target: 'ls -la', suffix: ' (timeout 20s)' });
  assert.deepEqual(callTitle('bash', { command: 'x', timeout: 2.5 }).suffix, ' (timeout 2.5s)');
  assert.equal(callTitle('write', { path: 'a/b.txt', content: 'zzz' }).target, 'a/b.txt');
  assert.equal(callTitle('grep', { pattern: 'needle', path: '.' }).target, 'needle');
  assert.equal(callTitle('weird', { n: 1, other: '  value  ' }).target, 'value', 'falls back to the first string argument');
  assert.deepEqual(callTitle('x', undefined), { label: 'x', target: '', suffix: '' });
  assert.equal(callTitle('x', 'not an object').target, '');
});

test('summaries: write/edit/read/shell have their own wording, everything else the first line and a line count', () => {
  assert.equal(resultView('write', { ...text('Successfully wrote 1024 bytes'), details: { bytes: 1024 } }, false).summary, '1024 bytes written');
  assert.equal(resultView('write', { ...text('x'), details: { bytes: 1 } }, false).summary, '1 byte written');
  assert.equal(resultView('edit', { ...text('ok'), details: { changedCount: 2, appliedEdits: 9 } }, false).summary, '2 edits applied');
  assert.equal(resultView('edit', { ...text('ok'), details: { appliedEdits: 1 } }, false).summary, '1 edit applied');
  assert.equal(resultView('read', text('a\nb\nc\n'), false).summary, '3 lines');
  assert.equal(resultView('read', { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }, false).summary, '1 image');
  assert.equal(resultView('bash', text('one\ntwo'), false).summary, '2 lines of output');
  assert.equal(resultView('bash', text(''), false).summary, 'no output');
  assert.equal(resultView('grep', text('src/a.ts\n  12: needle'), false).summary, 'src/a.ts (+1 line)');
  assert.equal(resultView('anything', { content: [] }, false).summary, 'done');
  assert.equal(resultView('bash', text('boom: exit 2\nmore'), true).summary, 'boom: exit 2', 'an error shows its first line');
  assert.equal(resultView('x', null, true).summary, 'failed');
  assert.equal(formatDuration(200), '0.2s'); assert.equal(formatDuration(125000), '2m 5s'); assert.equal(formatDuration(undefined), ''); assert.equal(formatDuration(-1), '');
});

test('expanded write and edit show what the details say, not the machine marker the model sees', () => {
  const write = resultView('write', { ...text('[FILE_WRITE_SUCCESS] {"bytes":11}'), details: { bytes: 11, path: 'out.txt', created: true } }, false);
  assert.deepEqual(write.lines, ['Created out.txt', '11 bytes']);
  assert.deepEqual(resultView('write', { ...text('x'), details: { bytes: 5, path: 'a' } }, false).lines, ['Updated a', '5 bytes']);
  const edit = resultView('edit', { ...text('Applied 1 edit'), details: { changedCount: 1, diff: '-old\n+new\n' } }, false);
  assert.deepEqual(edit.lines, ['-old', '+new']);
  assert.deepEqual(resultView('edit', { ...text('Applied 1 edit'), details: { changedCount: 1 } }, false).lines, ['Applied 1 edit']);
  assert.deepEqual(resultView('write', { ...text('disk full'), details: { bytes: 5 } }, true).lines, ['disk full'], 'an error always shows its own text');
});

test('untrusted output cannot move the cursor, change rows or reorder text', () => {
  assert.equal(safeText('a\x1b[2Jb\nc\x07d\re\u202ef\x00'), 'ab\ncd\nef');
  const rows = result('bash', text('ok\x1b[31m red \x1b[0m\x1b]0;title\x07\u202eevil'), 80, ctx({ expanded: true }));
  for (const row of rows) assert.doesNotMatch(row, /[\x00-\x08\x0b-\x1f\x7f\u202e]/);
});

test('collapsed: call is a blank row and the title row, result is one summary row with the hint on the right', () => {
  assert.deepEqual(call('write', { path: 'a.txt' }), ['', '● write a.txt']);
  const rows = result('write', { ...text('x'), details: { bytes: 1024 } });
  assert.equal(rows.length, 1);
  assert.match(rows[0]!, /^ {3}1024 bytes written · Took 0\.2s +\[Click to expand\]$/);
  assert.equal(visibleWidth(rows[0]!), 80, 'the hint is right-aligned to the full width');
});

test('collapsed: a long command is shortened but the timeout suffix survives; narrow widths never overflow', () => {
  const rows = call('bash', { command: 'cd /c/GitHub/pi-better-tools && grep -rn "visibleWidth" node_modules/@earendil-works/pi-tui/dist/*.js | head -5', timeoutMs: 20000 }, 60);
  assert.equal(rows[0], '');
  assert.ok(rows[1]!.startsWith('● $ cd /c/GitHub'), rows[1]);
  assert.ok(rows[1]!.endsWith('… (timeout 20s)'), rows[1]);
  for (const width of [1, 5, 12, 30]) {
    for (const row of [...call('bash', { command: 'x'.repeat(100), timeoutMs: 1000 }, width), ...result('grep', text('y'.repeat(100)), width)]) assert.ok(visibleWidth(row) <= Math.max(width, 3), `${width}: ${row}`);
  }
});

test('expanded: the call wraps in full, the body gets a bar per row, and the footer row carries the duration and the collapse hint', () => {
  const longCommand = 'echo ' + 'word '.repeat(30);
  const callRows = call('bash', { command: longCommand, timeoutMs: 20000 }, 50, ctx({ expanded: true }));
  assert.ok(callRows.length > 3, 'wrapped over several rows');
  assert.ok(callRows.join(' ').includes('(timeout 20s)'));
  const rows = result('bash', text('first\nsecond\n' + 'z'.repeat(120)), 40, ctx({ expanded: true }));
  assert.equal(rows[0], '');
  assert.deepEqual(rows.slice(1, 3), ['   ▌ first', '   ▌ second']);
  assert.ok(rows.slice(3, -2).every(row => row.startsWith('   ▌ ')), 'a wrapped long line keeps the bar on every row');
  assert.ok(rows.every(row => visibleWidth(row) <= 40));
  assert.match(rows.at(-1)!, /^ {3}Took 0\.2s +\[Click to Collapse\]$/);
});

test('expanded: long output stops at the cap with a count of what is left', () => {
  const rows = result('read', text(Array.from({ length: MAX_EXPANDED_LINES + 25 }, (_, i) => `line ${i}`).join('\n')), 80, ctx({ expanded: true }));
  assert.equal(rows.filter(row => row.startsWith('   ▌')).length, MAX_EXPANDED_LINES);
  assert.ok(rows.includes('   … 25 more lines'));
});

test('partial and error states', () => {
  assert.deepEqual(result('bash', text(''), 80, ctx({ isPartial: true })), ['   running…']);
  const failing = result('bash', text('command failed\ndetails'), 80, ctx({ isError: true }));
  assert.match(failing[0]!, /^ {3}command failed/);
  const colours: string[] = [];
  const spy: any = { fg: (color: string, value: string) => { colours.push(`${color}:${value}`); return value; }, bold: (value: string) => value };
  renderers('bash').renderCall({ command: 'x' }, spy, ctx({ isError: true })).render(40);
  renderers('bash').renderCall({ command: 'x' }, spy, ctx({ isPartial: true })).render(40);
  renderers('bash').renderCall({ command: 'x' }, spy, ctx()).render(40);
  assert.deepEqual(colours.filter(entry => entry.endsWith(':●')), ['error:●', 'warning:●', 'success:●']);
});

test('resolver: common look without a background box for every tool, but live-conversation tools keep their own renderer', () => {
  const common = renderers('grep');
  assert.equal(common.renderShell, 'self');
  assert.equal(typeof common.renderCall, 'function'); assert.equal(typeof common.renderResult, 'function');
  for (const own of ['subagent', 'subagent_message', 'fork']) assert.equal(renderers(own), 'NEXT', own);
  assert.notEqual(renderers('fork_status'), 'NEXT');
  assert.equal(renderers('not_registered_yet').renderShell, 'self', 'tools that are not registered yet are drawn too');
});
