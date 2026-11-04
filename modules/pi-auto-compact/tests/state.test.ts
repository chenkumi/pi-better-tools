import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalMonitorCwd, publishActiveMonitorBriefs, publishCapability } from '../../shell-tools/src/monitor-capability.ts';
import { autoCompact } from '../src/compact/hook.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { backgroundJobsSection, renderBackgroundJobs } from '../src/state/jobs.ts';
import { activeMonitorsSection, renderActiveMonitors } from '../src/state/monitors.ts';
import { parsePorcelain, tagFromPorcelain, workingTreeLines } from '../src/state/worktree.ts';

const job = (kind: string, jobId: string, status = 'running') => ({ kind, jobId, status }) as never;
const mon = (over: Record<string, unknown> = {}) => ({ monitorId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', source: 'file', state: 'running', target: 'src/app.ts', remainingMs: 240000, ...over }) as never;

test('background jobs: nothing live renders nothing; ids only, with the staleness warning', () => {
  assert.equal(renderBackgroundJobs([], false), '');
  const text = renderBackgroundJobs([job('shell_job', 'SH1'), job('subagent_job', 'SA1', 'queued'), job('fork_job', 'FK1', 'blocked')], false);
  assert.match(text.split('\n')[0]!, /^\[Background Jobs — live at compaction time/);
  for (const line of ['- Shell Job: SH1 (running)', '- Subagent Job: SA1 (queued)', '- Fork Job: FK1 (blocked)']) assert.ok(text.includes(line), line);
  assert.match(text, /do not assume .*still running/i);
});

test('background jobs: PTY hint only when a PTY row is shown; bad ids are dropped and flagged partial', () => {
  const withPty = renderBackgroundJobs([job('shell_job', 'SH1'), job('pty_session', 'pty-12-3')], false);
  assert.ok(withPty.includes('- PTY Session: pty-12-3 (running)') && /pty_list or pty_read/.test(withPty));
  const without = renderBackgroundJobs([job('shell_job', 'SH1')], false);
  assert.ok(!/PTY|pty_/.test(without) && without.endsWith('do not restart work that is already in progress.'));
  const bad = renderBackgroundJobs([job('shell_job', 'ok-1'), job('shell_job', 'bad\nid; rm -rf'), job('fork_job', '\u001b[31mred')], false);
  assert.ok(bad.includes('ok-1') && !/rm -rf|\u001b/.test(bad) && /partial/i.test(bad));
});

test('background jobs: the cap is 16 rows and a full shell list does not crowd out other kinds', () => {
  const shells = Array.from({ length: 20 }, (_, i) => job('shell_job', `J${i}`));
  const capped = renderBackgroundJobs(shells, false);
  assert.equal(capped.match(/^- Shell Job:/gm)!.length, 16);
  assert.match(capped, /partial/i);
  const mixed = renderBackgroundJobs([...shells.slice(0, 16), job('subagent_job', 'SA1'), job('fork_job', 'FK1'), job('fork_job', 'FK2')], false);
  for (const line of ['- Subagent Job: SA1', '- Fork Job: FK1', '- Fork Job: FK2']) assert.ok(mixed.includes(line), line);
});

test('active monitors: lists source, target, state, remaining time, id and label', () => {
  assert.equal(renderActiveMonitors([], false), '');
  const text = renderActiveMonitors([
    mon({ label: 'watch schema' }),
    mon({ monitorId: '01HYYYYYYYYYYYYYYYYYYYYYYY', source: 'command', target: '[command withheld]', remainingMs: 45000 }),
    mon({ monitorId: '01HXXXXXXXXXXXXXXXXXXXXXXX', source: 'websocket', target: 'wss://example.org/[path withheld]', state: 'starting', remainingMs: 1500000 }),
  ], false);
  assert.match(text.split('\n')[0]!, /^\[Active Monitors — live at compaction time/);
  assert.ok(text.includes('- File: src/app.ts (running, 4m left) — id 01HZZZZZZZZZZZZZZZZZZZZZZZ — label: watch schema'));
  assert.ok(text.includes('- Command: [command withheld] (running, 45s left)'));
  assert.ok(text.includes('- WebSocket: wss://example.org/[path withheld] (starting, 25m left)'));
  assert.match(text, /monitor_status/);
});

test('active monitors: control characters never break the block, bad rows are dropped, unreadable input is partial', () => {
  const text = renderActiveMonitors([mon({ target: 'src/a\nb\u001b[31m.ts', label: 'x‮y' })], false);
  assert.ok(!/[\u001b‮]/.test(text));
  assert.equal(text.split('\n').filter(line => line.startsWith('- File:')).length, 1);
  const dropped = renderActiveMonitors([mon({ source: 'socket' }), mon({ monitorId: 'bad\nid' }), mon({ state: 'Running' }), mon()], false);
  assert.equal(dropped.match(/^- File:/gm)!.length, 1);
  assert.match(dropped, /partial/i);
  assert.equal(renderActiveMonitors(Array.from({ length: 20 }, (_, i) => mon({ monitorId: `01H${String(i).padStart(23, '0')}` })), false).match(/^- File:/gm)!.length, 16);
  assert.match(renderActiveMonitors([], true), /partial/i);
});

test('live sections read the published briefs of this session only, and a throwing provider gives nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'auto-compact-live-')), canonical = canonicalMonitorCwd(cwd);
  const revokes = [
    publishCapability('shell_job', { sessionId: 'S-1', cwd: canonical }, 1, () => ({}), () => true, undefined, () => [job('shell_job', 'SH-LIVE')]),
    publishCapability('fork_job', { sessionId: 'S-other', cwd: canonical }, 1, () => ({}), () => true, undefined, () => [job('fork_job', 'FOREIGN')]),
    publishActiveMonitorBriefs({ sessionId: 'S-1', cwd: canonical }, () => [mon({ label: 'mine' })]),
  ];
  try {
    const jobs = backgroundJobsSection('S-1', cwd);
    assert.ok(jobs.includes('- Shell Job: SH-LIVE (running)') && !jobs.includes('FOREIGN'));
    assert.ok(activeMonitorsSection('S-1', cwd).includes('label: mine'));
    assert.equal(backgroundJobsSection('S-nobody', cwd), '');
    const boom = publishCapability('subagent_job', { sessionId: 'S-2', cwd: canonical }, 1, () => ({}), () => true, undefined, () => { throw new Error('boom'); });
    try { assert.doesNotThrow(() => backgroundJobsSection('S-2', cwd)); } finally { boom(); }
  } finally { revokes.forEach(revoke => revoke()); rmSync(cwd, { recursive: true, force: true }); }
});

test('porcelain parsing tags files, skips a rename source, and ignores ignored files', () => {
  assert.equal(tagFromPorcelain('??'), 'new');
  assert.equal(tagFromPorcelain('UU'), 'conflicted');
  assert.equal(tagFromPorcelain('MM'), 'staged,unstaged');
  assert.equal(tagFromPorcelain('!!'), undefined);
  assert.deepEqual(parsePorcelain(' M a.ts\0R  new.ts\0old.ts\0?? b.ts\0!! junk\0 D gone.ts\0'), [['a.ts', 'unstaged'], ['new.ts', 'renamed'], ['b.ts', 'new'], ['gone.ts', 'deleted']]);
  assert.deepEqual(parsePorcelain('?? we\nird‮.ts\0'), [['we ird .ts', 'new']]);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'one\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('working tree: HEAD, branch, and changed paths with tags, never content', async () => {
  const r = repo();
  try {
    const head = r.git('rev-parse', '--short=7', 'HEAD').toString().trim();
    assert.deepEqual(await workingTreeLines(r.dir), [`Working tree at compaction: HEAD ${head} on main; clean`]);
    writeFileSync(join(r.dir, 'a.ts'), 'SECRET CONTENT\n');
    writeFileSync(join(r.dir, 'b.ts'), 'x\n');
    const lines = await workingTreeLines(r.dir);
    assert.equal(lines[0], `Working tree at compaction: HEAD ${head} on main; 2 changed`);
    assert.deepEqual(lines.slice(1).sort(), ['- a.ts (unstaged)', '- b.ts (new)']);
    assert.ok(!lines.join('\n').includes('SECRET'));
  } finally { r.done(); }
});

test('working tree: caps the file list, and gives nothing outside a repository, for a missing directory or an aborted call', async () => {
  const r = repo();
  try {
    for (let i = 0; i < 25; i++) writeFileSync(join(r.dir, `f${String(i).padStart(2, '0')}.ts`), 'x');
    const lines = await workingTreeLines(r.dir);
    assert.equal(lines.length, 1 + 20 + 1);
    assert.equal(lines.at(-1), '- … +5 more');
    const aborted = new AbortController(); aborted.abort();
    assert.deepEqual(await workingTreeLines(r.dir, aborted.signal), []);
  } finally { r.done(); }
  const plain = mkdtempSync(join(tmpdir(), 'auto-compact-nogit-'));
  try {
    // A temp directory sits outside any repository, so there is no HEAD to report.
    assert.deepEqual(await workingTreeLines(plain), []);
    assert.deepEqual(await workingTreeLines(join(plain, 'missing')), []);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test('the hook puts jobs, monitors and the working tree last, after the state block, and still works when they are empty', async () => {
  const r = repo();
  const canonical = canonicalMonitorCwd(r.dir);
  const revokes = [
    publishCapability('shell_job', { sessionId: 'SESS', cwd: canonical }, 1, () => ({}), () => true, undefined, () => [job('shell_job', 'SH-LIVE')]),
    publishActiveMonitorBriefs({ sessionId: 'SESS', cwd: canonical }, () => [mon({ label: 'mine' })]),
  ];
  const text = (value: string) => [{ type: 'text', text: value }];
  const entries = [
    { type: 'message', id: 'e0000001', parentId: null, message: { role: 'user', content: text('go') } },
    { type: 'message', id: 'e0000002', parentId: 'e0000001', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'w', name: 'write', arguments: { path: 'a.ts' } }] } },
    { type: 'message', id: 'e0000003', parentId: 'e0000002', message: { role: 'toolResult', toolCallId: 'w', toolName: 'write', isError: false, content: text('ok'), details: { path: 'a.ts' } } },
    { type: 'message', id: 'e0000004', parentId: 'e0000003', message: { role: 'user', content: text('tail') } },
  ];
  const event = { preparation: { firstKeptEntryId: 'e0000004', tokensBefore: 10 }, branchEntries: entries } as never;
  const ctx = (cwd: string | undefined) => ({ cwd, model: { contextWindow: 200_000 }, sessionManager: { getSessionFile: () => undefined, getSessionId: () => 'SESS' } }) as never;
  try {
    writeFileSync(join(r.dir, 'b.ts'), 'x');
    const summary = (await autoCompact(event, ctx(r.dir), DEFAULT_CONFIG))!.compaction!.summary;
    const at = (needle: string) => summary.indexOf(needle);
    assert.ok(at('## State at compaction') > 0);
    assert.ok(at('[Background Jobs') > at('## State at compaction'));
    assert.ok(at('[Active Monitors') > at('[Background Jobs'));
    assert.ok(at('Working tree at compaction: HEAD') > at('[Active Monitors'));
    assert.ok(summary.includes('- b.ts (new)') && summary.includes('- Shell Job: SH-LIVE (running)'));
    const bare = (await autoCompact(event, ctx(undefined), DEFAULT_CONFIG))!.compaction!.summary;
    assert.ok(!bare.includes('[Background Jobs') && !bare.includes('Working tree at compaction'));
  } finally { revokes.forEach(revoke => revoke()); r.done(); }
});
