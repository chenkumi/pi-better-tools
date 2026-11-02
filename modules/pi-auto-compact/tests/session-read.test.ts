import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanLines } from '../src/session-read/lines.ts';
import { readSessionLines, SessionReadError } from '../src/session-read/read.ts';
import { renderEntry } from '../src/session-read/render.ts';
import { readHeader, resolveReadableSessions } from '../src/session-read/sessions.ts';
import { sessionReadTool } from '../src/session-read/tool.ts';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'session-read-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const header = (id: string, parentSession?: string) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-02T00:00:00.000Z', cwd: '/w', ...(parentSession ? { parentSession } : {}) });
const toolResult = (id: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'message', id, parentId: null, timestamp: 't', message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text }], ...extra } });
const write = (file: string, lines: string[]) => writeFileSync(file, `${lines.join('\n')}\n`);

test('scanLines numbers lines from 1, honours the range, and counts a last line without a newline', async () => {
  const { dir, done } = workspace();
  try {
    const file = join(dir, 'f.jsonl');
    writeFileSync(file, 'one\ntwo\r\n\nfour');
    const all: Array<[number, string | undefined]> = [];
    for await (const item of scanLines(file)) all.push([item.line, item.text]);
    assert.deepEqual(all, [[1, 'one'], [2, 'two'], [3, ''], [4, 'four']]);
    const range: number[] = [];
    for await (const item of scanLines(file, 2, 3)) range.push(item.line);
    assert.deepEqual(range, [2, 3]);
  } finally { done(); }
});

test('rendering decodes JSON, replaces images, thinking and base64 with placeholders, and strips control characters', () => {
  const blob = 'A'.repeat(5000);
  const raw = JSON.stringify({ type: 'message', id: 'a1b2c3d4', timestamp: 't', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'secret reasoning' },
    { type: 'text', text: 'line1\nline2\u001b[31m' },
    { type: 'image', mimeType: 'image/png', data: blob },
    { type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'a.ts', data: blob } },
  ] } });
  const { head, body } = renderEntry(12, raw);
  assert.match(head, /^L12:a1b2c3d4 message assistant/);
  assert.ok(body.includes('line1\nline2'));
  assert.ok(body.includes('[image: image/png, 4.9KB base64 omitted]'));
  assert.ok(body.includes('[thinking: 16 chars omitted]') && !body.includes('secret reasoning'));
  assert.ok(body.includes('[base64 5000 chars omitted]'));
  assert.ok(!body.includes('AAAAAAAAAA') && !body.includes('\u001b'));
  assert.ok(renderEntry(3, 'not json{').head.includes('not valid JSON'));
});

test('the readable sessions are the current one and its ancestors, and only real session files are followed', async () => {
  const { dir, done } = workspace();
  try {
    const grand = join(dir, 'grand.jsonl'), parent = join(dir, 'parent.jsonl'), child = join(dir, 'child.jsonl'), sibling = join(dir, 'sibling.jsonl'), stray = join(dir, 'stray.jsonl');
    write(grand, [header('G'), toolResult('g1', 'x')]);
    write(parent, [header('P', grand), toolResult('p1', 'x')]);
    write(sibling, [header('S', grand), toolResult('s1', 'x')]);
    write(child, [header('C', parent), toolResult('c1', 'x')]);
    assert.deepEqual((await resolveReadableSessions({ id: 'C', file: child })).map(item => item.id), ['C', 'P', 'G']);
    assert.deepEqual(await resolveReadableSessions({ id: 'X', file: undefined }), []);
    // A header that points at a file which is not a session ends the walk instead of reading it.
    writeFileSync(stray, 'just some text\nnot a session\n');
    write(child, [header('C', stray), toolResult('c1', 'x')]);
    assert.deepEqual((await resolveReadableSessions({ id: 'C', file: child })).map(item => item.id), ['C']);
    assert.equal(await readHeader(stray), undefined);
    // Cycles terminate.
    write(grand, [header('G', child)]);
    write(child, [header('C', parent)]);
    write(parent, [header('P', grand)]);
    assert.deepEqual((await resolveReadableSessions({ id: 'C', file: child })).map(item => item.id), ['C', 'P', 'G']);
    // A non-.jsonl target is never followed.
    write(child, [header('C', join(dir, 'secret.txt'))]);
    writeFileSync(join(dir, 'secret.txt'), `${header('Z')}\n`);
    assert.deepEqual((await resolveReadableSessions({ id: 'C', file: child })).map(item => item.id), ['C']);
  } finally { done(); }
});

test('readSessionLines reads the cited line, verifies the id, and refuses sessions outside the chain', async () => {
  const { dir, done } = workspace();
  try {
    const parent = join(dir, 'parent.jsonl'), child = join(dir, 'child.jsonl');
    write(parent, [header('P'), toolResult('aaaa1111', 'parent output')]);
    write(child, [header('C', parent), toolResult('bbbb2222', 'child output'), toolResult('cccc3333', 'later')]);
    const readable = await resolveReadableSessions({ id: 'C', file: child });
    const own = await readSessionLines(readable, { line: 2, id: 'bbbb' });
    assert.match(own.text, /^L2:bbbb2222 message toolResult bash/);
    assert.ok(own.text.includes('child output'));
    assert.deepEqual(own.details, { sessionId: 'C', line: 2, toLine: 2, chars: own.text.length, truncated: false });
    assert.ok((await readSessionLines(readable, { sessionId: 'P', line: 2 })).text.includes('parent output'));
    const range = await readSessionLines(readable, { line: 2, toLine: 3 });
    assert.ok(range.text.includes('child output') && range.text.includes('later') && range.text.includes('\n---\n'));
    await assert.rejects(readSessionLines(readable, { sessionId: 'OTHER', line: 1 }), (error: Error) => error instanceof SessionReadError && /Readable sessions: C, P/.test(error.message));
    await assert.rejects(readSessionLines(readable, { line: 2, id: 'cccc' }), /holds "bbbb2222".*That entry is at line 3/);
    await assert.rejects(readSessionLines(readable, { line: 2, id: 'zzzz' }), /No entry with that id was found/);
    await assert.rejects(readSessionLines(readable, { line: 99 }), /past the end of the session file \(3 lines\)/);
    await assert.rejects(readSessionLines(readable, { line: 1, toLine: 40 }), /At most 20 lines/);
    await assert.rejects(readSessionLines(readable, { line: 0 }), /"line" must be an integer >= 1/);
    await assert.rejects(readSessionLines([], { line: 1 }), /not persisted/);
  } finally { done(); }
});

test('a huge entry is paged by offset and never returned whole; an inline image cannot flood the result', async () => {
  const { dir, done } = workspace();
  try {
    const file = join(dir, 's.jsonl');
    const long = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join('\n');
    const image = JSON.stringify({ type: 'message', id: 'img00001', timestamp: 't', message: { role: 'toolResult', toolName: 'screenshot', content: [{ type: 'image', mimeType: 'image/png', data: 'B'.repeat(3_000_000) }, { type: 'text', text: 'captured' }] } });
    write(file, [header('S'), toolResult('big00001', long), image]);
    const readable = await resolveReadableSessions({ id: 'S', file });
    const first = await readSessionLines(readable, { line: 2, id: 'big0', maxChars: 5000 });
    assert.ok(first.text.length < 5400 && first.details.truncated && first.details.nextOffset);
    assert.match(first.text, /\[more: call session_read again with line=2 offset=\d+\]$/);
    const second = await readSessionLines(readable, { line: 2, offset: first.details.nextOffset, maxChars: 5000 });
    assert.ok(!second.text.includes('row 0\n') && second.text.includes('row '));
    const picture = await readSessionLines(readable, { line: 3 });
    assert.ok(picture.text.length < 600, `image line rendered as ${picture.text.length} chars`);
    assert.ok(picture.text.includes('captured') && picture.text.includes('image/png') && !picture.text.includes('BBBBBBBB'));
  } finally { done(); }
});

test('a range stops at the budget and says exactly where to continue', async () => {
  const { dir, done } = workspace();
  try {
    const file = join(dir, 's.jsonl');
    write(file, [header('S'), toolResult('e0000001', 'x'.repeat(2500)), toolResult('e0000002', 'y'.repeat(2500)), toolResult('e0000003', 'z')]);
    const readable = await resolveReadableSessions({ id: 'S', file });
    const result = await readSessionLines(readable, { line: 2, toLine: 4, maxChars: 3000 });
    assert.ok(result.details.truncated && result.details.nextLine === 3 && result.details.nextOffset);
    assert.match(result.text, /\[truncated: chars 0-\d+ of 2500\]\n\[more: call session_read again with line=3 offset=\d+ to_line=4\]$/);
    const rest = await readSessionLines(readable, { line: 3, toLine: 4, offset: result.details.nextOffset, maxChars: 5000 });
    assert.ok(!rest.details.truncated && rest.text.includes('z') && rest.details.toLine === 4);
  } finally { done(); }
});

test('the tool is read-only, deferred, and resolves the session from the host context', async () => {
  assert.equal(sessionReadTool.name, 'session_read');
  assert.equal(sessionReadTool.exposure, 'deferred');
  assert.equal(sessionReadTool.annotations?.readOnlyHint, true);
  const { dir, done } = workspace();
  try {
    const file = join(dir, 's.jsonl');
    write(file, [header('S'), toolResult('e0000001', 'hello')]);
    const ctx = { sessionManager: { getSessionId: () => 'S', getSessionFile: () => file, getLeafId: () => null } };
    const run = (params: Record<string, unknown>) => (sessionReadTool.execute as unknown as (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }>)('call', params, undefined, undefined, ctx);
    const ok = await run({ line: 2, id: 'e000' });
    assert.ok(ok.content[0]!.text.includes('hello'));
    await assert.rejects(run({ line: 2, id: 'nope' }), /^Error: SESSION_FAILED: Line 2 does not hold entry "nope"/);
    const none = (sessionReadTool.execute as unknown as (...args: unknown[]) => Promise<unknown>)('call', { line: 2 }, undefined, undefined, { sessionManager: { getSessionId: () => 'M', getSessionFile: () => undefined, getLeafId: () => null } });
    await assert.rejects(none, /SESSION_FAILED: This session has no session file/);
  } finally { done(); }
});

test('renderers show where and how much, never mutate the result, and strip terminal controls', () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const tool = sessionReadTool as unknown as { renderCall: Function; renderResult: Function };
  const call = tool.renderCall({ line: 12, to_line: 15, session_id: 'abcdef123456' }, theme, { isError: false });
  assert.ok(call.render(80).join('\n').includes('L12–15 session abcdef12'));
  assert.ok(tool.renderCall({}, theme, { isError: false }).render(12).every((line: string) => line.length <= 12));
  const result = { content: [{ type: 'text', text: 'body\u001b[2J‮' }], details: { line: 12, toLine: 12, chars: 4, truncated: true } };
  const before = JSON.stringify(result);
  const compact = tool.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }).render(80).join('\n');
  assert.match(compact, /Read L12: 4 chars \(truncated, more available\)/);
  assert.ok(!compact.includes('body'));
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false }).render(80).join('\n');
  assert.ok(expanded.includes('body') && !/[\u001b‮]/.test(expanded));
  assert.match(tool.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: true }).render(80).join('\n'), /Session Read failed/);
  assert.equal(JSON.stringify(result), before);
});
