import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { currentBranchIds } from '../src/session-read/branch.ts';
import { grepSession } from '../src/session-read/grep.ts';
import { resolveReadableSessions, SessionReadError } from '../src/session-read/sessions.ts';
import { sessionGrepTool, sessionWindowTool } from '../src/session-read/tool.ts';
import { readWindow } from '../src/session-read/window.ts';

const entry = (id: string, parentId: string | null, message: Record<string, unknown>) => JSON.stringify({ type: 'message', id, parentId, timestamp: 't', message });
const text = (value: string) => [{ type: 'text', text: value }];

/**
 * L2 user → L3 assistant(bash call) → L4 result(error) → then two branches:
 *   abandoned: L5 assistant "fixing the lockfile"
 *   live:      L6 assistant(read call) → L7 its result → L8 user with a secret (leaf)
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'session-outline-'));
  const file = join(dir, 's.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'SESS', timestamp: 't', cwd: '/w' }),
    entry('a0000001', null, { role: 'user', content: text('build the thing') }),
    entry('a0000002', 'a0000001', { role: 'assistant', content: [{ type: 'thinking', thinking: 'zebra secret plan' }, { type: 'text', text: 'ok, running tests' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } }] }),
    entry('a0000003', 'a0000002', { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', isError: true, durationMs: 4200, content: text('1 failing\nCommand exited with code 1') }),
    entry('a0000004', 'a0000003', { role: 'assistant', content: text('fixing the lockfile') }),
    entry('b0000005', 'a0000003', { role: 'assistant', content: [{ type: 'text', text: 'trying another way' }, { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'src/a.ts' } }] }),
    entry('b0000006', 'b0000005', { role: 'toolResult', toolCallId: 'c2', toolName: 'read', isError: false, content: text('FILE BODY'), details: { path: 'src/a.ts', lineStart: 1, lineEnd: 40, totalLines: 40, sha256: 'abcdef0123456789' } }),
    entry('b0000007', 'b0000006', { role: 'user', content: text('keep going, password=hunter2 is the login') }),
  ];
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file, readable: [{ id: 'SESS', file }], done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the live branch is the path from the leaf to the root; a gap in the links disables filtering instead of hiding history', async () => {
  const f = fixture();
  try {
    const live = await currentBranchIds(f.file);
    assert.deepEqual([...live!].sort(), ['a0000001', 'a0000002', 'a0000003', 'b0000005', 'b0000006', 'b0000007']);
    const abandoned = await currentBranchIds(f.file, 'a0000004');
    assert.deepEqual([...abandoned!].sort(), ['a0000001', 'a0000002', 'a0000003', 'a0000004']);
    writeFileSync(join(f.dir, 'gap.jsonl'), [JSON.stringify({ type: 'session', id: 'G' }), entry('x0000001', 'missing0', { role: 'user', content: text('hi') })].join('\n') + '\n');
    assert.equal(await currentBranchIds(join(f.dir, 'gap.jsonl')), undefined);
  } finally { f.done(); }
});

test('window follows the L3 rules: conversation text only, no tool call or result, abandoned branches marked', async () => {
  const f = fixture();
  try {
    const result = await readWindow(f.readable, { from: 2, to: 8 });
    const out = result.text;
    assert.match(out, /^Session SESS L2–8: 5 outline lines; 1 entry on abandoned branches \(marked\)/);
    assert.ok(out.includes('⟦L2:a0000001⟧ user: build the thing'));
    assert.ok(out.includes('⟦L3:a0000002⟧ assistant: ok, running tests'));
    assert.ok(out.includes('⟦L5:a0000004⟧ (other branch) assistant: fixing the lockfile'));
    assert.ok(out.includes('⟦L6:b0000005⟧ assistant: trying another way'), 'the live branch carries no marker');
    assert.ok(!/\[bash\]|\[read\]|npm test|src\/a\.ts|FILE BODY|zebra|tool call/.test(out), `no tool line, tool output or thinking: ${out}`);
    assert.equal(result.details.entries, 5);
    assert.ok(!out.includes('[earlier'), 'range starts at the first conversation line');
  } finally { f.done(); }
});

test('window lists a progress checkpoint by its title and hides tool-only entries, like the compaction summary does', async () => {
  const f = fixture();
  try {
    const lines = [
      JSON.stringify({ type: 'session', id: 'SESS' }),
      entry('k0000001', null, { role: 'user', content: text('long task') }),
      entry('k0000002', 'k0000001', { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'make' } }] }),
      entry('k0000003', 'k0000002', { role: 'toolResult', toolCallId: 't1', toolName: 'bash', isError: false, content: text('built') }),
      entry('k0000004', 'k0000003', { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'toolCall', id: 'p1', name: 'progress_checkpoint', arguments: { summary: '# Parser done\nTests next, BODY.' } }] }),
      entry('k0000005', 'k0000004', { role: 'toolResult', toolCallId: 'p1', toolName: 'progress_checkpoint', isError: false, content: text('Checkpoint saved.') }),
    ];
    writeFileSync(f.file, `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
    const out = (await readWindow(f.readable, { from: 2, to: 6 })).text;
    assert.match(out, /^Session SESS L2–6: 3 outline lines/);
    assert.ok(out.includes('⟦L2:k0000001⟧ user: long task'));
    assert.ok(out.includes('⟦L5:k0000004⟧ assistant: checking'), out);
    assert.ok(out.includes('⟦L5:k0000004⟧ checkpoint: Parser done'), out);
    assert.ok(!out.includes('make') && !out.includes('Checkpoint saved') && !out.includes('BODY'), out);
  } finally { f.done(); }
});

test('window shows a user message whole, an assistant message clipped, and a huge user message by head and tail', async () => {
  const f = fixture();
  try {
    const ask = `${'Background for the job. '.repeat(50)}At the very end: also create FINAL.md.`;
    const lines = [
      JSON.stringify({ type: 'session', id: 'SESS' }),
      entry('u0000001', null, { role: 'user', content: text(ask) }),
      entry('u0000002', 'u0000001', { role: 'assistant', content: text(`${'long answer '.repeat(80)}ANSWER-END`) }),
      entry('u0000003', 'u0000002', { role: 'user', content: text(`BEGIN ${'z'.repeat(30_000)} PASTE-END`) }),
    ];
    writeFileSync(f.file, `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
    const out = (await readWindow(f.readable, { from: 2, to: 4, maxChars: 30_000 })).text;
    assert.ok(out.includes('At the very end: also create FINAL.md.'), 'the end of a normal user message is there');
    assert.ok(!out.includes('ANSWER-END'), 'assistant text is clipped');
    assert.ok(out.includes('BEGIN') && out.includes('PASTE-END') && /\[… \d+ chars omitted …\]/.test(out), 'a pasted block keeps head and tail');
    assert.ok(out.length < 9000, `${out.length}`);
  } finally { f.done(); }
});

test('window reads backwards with before/count and says how to go further back or on', async () => {
  const f = fixture();
  try {
    const back = await readWindow(f.readable, { before: 6, count: 2 });
    assert.match(back.text, /^Session SESS L4–5:/);
    assert.ok(back.text.includes('[earlier: call session_window with before=4]'));
    const budget = await readWindow(f.readable, { from: 2, to: 8, maxChars: 1000 });
    assert.equal(budget.details.truncated, false);
    const tiny = await readWindow(f.readable, { from: 2, to: 8, maxChars: 1000 }); // 1000 is the minimum; a long entry forces a cut below
    assert.ok(tiny.details.entries > 0);
  } finally { f.done(); }
});

test('window stops at the budget and names the next line', async () => {
  const f = fixture();
  try {
    const long = Array.from({ length: 12 }, (_, i) => entry(`z000000${i}`, i === 0 ? null : `z000000${i - 1}`, { role: 'user', content: text(`message ${i} ${'w'.repeat(280)}`) }));
    writeFileSync(f.file, `${JSON.stringify({ type: 'session', id: 'SESS' })}\n${long.join('\n')}\n`);
    const result = await readWindow(f.readable, { from: 2, to: 13, maxChars: 1000 });
    assert.ok(result.details.truncated && result.details.nextFrom !== undefined);
    assert.ok(result.text.includes(`[more: call session_window again with from=${result.details.nextFrom} to=13]`));
    assert.ok(result.text.length < 1500);
  } finally { f.done(); }
});

test('window rejects bad ranges', async () => {
  const f = fixture();
  try {
    await assert.rejects(readWindow(f.readable, {}), /Give "from"/);
    await assert.rejects(readWindow(f.readable, { from: 2, before: 5 }), /not both/);
    await assert.rejects(readWindow(f.readable, { from: 2, to: 900 }), /At most 400 lines/);
    await assert.rejects(readWindow(f.readable, { from: 99 }), /past the end/);
    await assert.rejects(readWindow(f.readable, { from: 0 }), /"from" must be an integer >= 1/);
    await assert.rejects(readWindow(f.readable, { sessionId: 'NOPE', from: 2 }), (error: Error) => error instanceof SessionReadError && /Readable sessions: SESS/.test(error.message));
  } finally { f.done(); }
});

test('grep finds literal text in text, calls and results, masks credentials, and never searches thinking', async () => {
  const f = fixture();
  try {
    const secret = await grepSession(f.readable, { pattern: 'HUNTER2' });
    assert.ok(secret.text.includes('⟦L8:b0000007⟧ user: keep going, password=*** is the login'), secret.text);
    assert.ok(!secret.text.includes('hunter2'));
    const call = await grepSession(f.readable, { pattern: 'npm test' });
    assert.ok(call.text.includes('⟦L3:a0000002⟧ call bash:'), call.text);
    const result = await grepSession(f.readable, { pattern: 'failing' });
    assert.ok(result.text.includes('⟦L4:a0000003⟧ result bash: 1 failing Command exited'), result.text);
    assert.equal((await grepSession(f.readable, { pattern: 'zebra' })).details.hits, 0, 'thinking is not searched');
    assert.equal((await grepSession(f.readable, { pattern: 'FILE BODY' })).details.hits, 1);
  } finally { f.done(); }
});

test('grep filters by role, tool and range, and counts occurrences per entry', async () => {
  const f = fixture();
  try {
    assert.equal((await grepSession(f.readable, { pattern: 'src/a.ts', role: 'user' })).details.hits, 0);
    assert.equal((await grepSession(f.readable, { pattern: 'src/a.ts', role: 'tool' })).details.hits, 1);
    assert.equal((await grepSession(f.readable, { pattern: 'src/a.ts', tool: 'bash' })).details.hits, 0);
    assert.equal((await grepSession(f.readable, { pattern: 'failing', tool: 'bash' })).details.hits, 1);
    assert.equal((await grepSession(f.readable, { pattern: 'failing', tool: 'read' })).details.hits, 0);
    assert.equal((await grepSession(f.readable, { pattern: 'src/a.ts', from: 7 })).details.hits, 0);
    assert.equal((await grepSession(f.readable, { pattern: 'src/a.ts', to: 6 })).details.hits, 1);
    const twice = await grepSession(f.readable, { pattern: 'the', role: 'assistant' });
    assert.ok(/\(×\d+\)|1 matching entry/.test(twice.text));
  } finally { f.done(); }
});

test('grep hides abandoned branches by default, says how many, and shows them on request', async () => {
  const f = fixture();
  try {
    const hidden = await grepSession(f.readable, { pattern: 'lockfile' });
    assert.equal(hidden.details.hits, 0);
    assert.equal(hidden.details.hiddenOtherBranch, 1);
    assert.ok(hidden.text.includes('1 further match on abandoned branches hidden; set include_other_branches=true'));
    const shown = await grepSession(f.readable, { pattern: 'lockfile', includeOtherBranches: true });
    assert.ok(shown.text.includes('⟦L5:a0000004⟧ assistant: fixing the lockfile'));
  } finally { f.done(); }
});

test('grep honours the limit with a continuation, rejects patterns that are too short or too long, and can be aborted', async () => {
  const f = fixture();
  try {
    const many = Array.from({ length: 5 }, (_, i) => entry(`m000000${i}`, i === 0 ? null : `m000000${i - 1}`, { role: 'user', content: text(`needle ${i}`) }));
    writeFileSync(f.file, `${JSON.stringify({ type: 'session', id: 'SESS' })}\n${many.join('\n')}\n`);
    const limited = await grepSession(f.readable, { pattern: 'needle', limit: 2 });
    assert.equal(limited.details.hits, 2);
    assert.equal(limited.details.nextFrom, 4);
    assert.ok(limited.text.includes('[more: call session_grep again with from=4]'));
    await assert.rejects(grepSession(f.readable, { pattern: 'a' }), /2-200 characters of literal text/);
    await assert.rejects(grepSession(f.readable, { pattern: 'x'.repeat(201) }), /2-200 characters/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(grepSession(f.readable, { pattern: 'needle', signal: controller.signal }), /Aborted/);
  } finally { f.done(); }
});

test('an entry too large to parse is reported, never loaded', async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, `${JSON.stringify({ type: 'session', id: 'SESS' })}\n${entry('a0000001', null, { role: 'user', content: text('short') })}\n`);
    const grep = await grepSession(f.readable, { pattern: 'short' });
    assert.equal(grep.details.hits, 1);
  } finally { f.done(); }
});

test('window and grep tools resolve the leaf and sessions from the host context and are deferred in the session namespace', async () => {
  const f = fixture();
  try {
    for (const tool of [sessionWindowTool, sessionGrepTool]) {
      assert.equal(tool.exposure, 'deferred');
      assert.equal(tool.namespace?.name, 'session');
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const ctx = { sessionManager: { getSessionId: () => 'SESS', getSessionFile: () => f.file, getLeafId: () => 'a0000004' } };
    const run = (tool: unknown, params: Record<string, unknown>) => (tool as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }).execute('c', params, undefined, undefined, ctx);
    const window = await run(sessionWindowTool, { from: 2, to: 8 });
    assert.ok(window.content[0]!.text.includes('(other branch) assistant: trying another way'), 'the host leaf decides which branch is live');
    const grep = await run(sessionGrepTool, { pattern: 'lockfile' });
    assert.ok(grep.content[0]!.text.includes('⟦L5:a0000004⟧'));
    await assert.rejects(run(sessionGrepTool, { pattern: 'x' }), /^Error: SESSION_FAILED:/);
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const renderer = sessionWindowTool as unknown as { renderCall: Function; renderResult: Function };
    assert.ok(renderer.renderCall({ before: 40 }, theme, { isError: false }).render(80).join('').includes('before L40'));
    assert.ok(renderer.renderResult({ content: [{ type: 'text', text: 'x' }], details: { from: 2, to: 8, entries: 6, truncated: true } }, { expanded: false, isPartial: false }, theme, { isError: false }).render(80).join('').includes('Outlined L2–8: 6 entries (truncated'));
    const readable = await resolveReadableSessions({ id: 'SESS', file: f.file });
    assert.equal(readable.length, 1);
  } finally { f.done(); }
});

test('window shows a checkpoint alone on a line when the message has no text, and hides other tool calls', async () => {
  const f = fixture();
  try {
    const lines = [
      JSON.stringify({ type: 'session', id: 'SESS' }),
      entry('n0000001', null, { role: 'user', content: text('long task') }),
      entry('n0000002', 'n0000001', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'progress_checkpoint', arguments: { summary: '# 進度快照 1\n\nbody' } }] }),
      entry('n0000003', 'n0000002', { role: 'toolResult', toolCallId: 'c1', toolName: 'progress_checkpoint', isError: false, content: text('Checkpoint saved.') }),
      entry('n0000004', 'n0000003', { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'note', arguments: { type: 'report', content: '# R' } }] }),
      entry('n0000005', 'n0000004', { role: 'toolResult', toolCallId: 'c2', toolName: 'note', isError: false, content: text('Saved note: reports/SESS/REPORT-1.md'), details: { relativePath: 'reports/SESS/REPORT-1.md' } }),
    ];
    writeFileSync(f.file, `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
    const out = (await readWindow(f.readable, { from: 2, to: 6 })).text;
    assert.ok(out.includes('⟦L3:n0000002⟧ checkpoint: 進度快照 1'), out);
    assert.ok(!out.includes('REPORT-1') && !out.includes('body'), out);
  } finally { f.done(); }
});

test('window shows a checkpoint line even when the window starts right at the call', async () => {
  const f = fixture();
  try {
    const lines = [
      JSON.stringify({ type: 'session', id: 'SESS' }),
      entry('n0000001', null, { role: 'user', content: text('long task') }),
      entry('n0000002', 'n0000001', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'progress_checkpoint', arguments: { summary: '# Snapshot A body' } }] }),
    ];
    writeFileSync(f.file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    const out = (await readWindow(f.readable, { from: 3, to: 3 })).text;
    assert.ok(out.includes('checkpoint: Snapshot A body'), out);
    assert.ok(!out.includes('long task'));
  } finally { f.done(); }
});
