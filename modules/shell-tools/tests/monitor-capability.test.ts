import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellJobs } from '../src/background-jobs.js';
import { canonicalMonitorCwd, publishCapability, acquireCapability, publishAutoMonitor, requestAutoMonitor, publishJobBriefs, activeJobBriefs } from '../src/monitor-capability.js';
import { createShellMonitorPublisher } from '../src/monitor-publisher.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('readonly capability is generation revocable and cannot adopt a foreign cwd', () => {
  const scope = { sessionId: 'owner', cwd: canonicalMonitorCwd(process.cwd()) };
  const revoke1 = publishCapability('shell_job', scope, 1, () => ({ status: 'running' }), () => true);
  const lease = acquireCapability('shell_job', scope);
  const revoke2 = publishCapability('shell_job', scope, 2, () => ({ status: 'completed' }), () => true);
  assert.throws(() => lease.snapshot('id')); revoke1(); assert.equal(acquireCapability('shell_job', scope).generation, 2); revoke2();
  assert.throws(() => acquireCapability('shell_job', scope));
});
test('Shell Monitor readonly lookup does not lazy-start or cancel source registry', async () => {
  const jobs = new ShellJobs({ sendMessage() {} } as any);
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'owner' } };
  assert.equal(typeof jobs.monitorSnapshot, 'function');
  assert.throws(() => jobs.monitorSnapshot(ctx, 'unknown', canonicalMonitorCwd(process.cwd()), jobs.monitorEpoch));
  assert.throws(() => jobs.monitorSnapshot({ ...ctx, cwd: '/foreign' }, 'unknown', canonicalMonitorCwd(process.cwd()), jobs.monitorEpoch));
  await jobs.shutdown();
});
test('review adapter W1: valid Shell job fences owner/cwd/epoch, held lease replacement and revoke before deferred cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-shell-lease-')), foreign = mkdtempSync(join(tmpdir(), 'monitor-shell-foreign-'));
  const jobs = new ShellJobs({ sendMessage() {} } as any), publisher = createShellMonitorPublisher(jobs);
  let owner = 'valid-shell-owner', release!: () => void, entered!: () => void;
  const running = new Promise<void>(r => { entered = r; });
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => owner } };
  const scope = { sessionId: owner, cwd: canonicalMonitorCwd(root) };
  jobs.start(ctx);
  try {
    const receipt = jobs.submit(ctx, 'bash', 'readonly-review', undefined, async () => { entered(); await new Promise<void>(r => { release = r; }); return { content: [], details: undefined, structuredContent: { output: 'valid', exit_code: 0 } }; });
    await running; publisher.start(ctx); const epoch = jobs.monitorEpoch, held = acquireCapability('shell_job', scope);
    assert.equal(held.snapshot(receipt.jobId).status, 'running');
    assert.throws(() => jobs.monitorSnapshot({ ...ctx, sessionManager: { getSessionId: () => 'foreign' } }, receipt.jobId, scope.cwd, epoch));
    assert.throws(() => jobs.monitorSnapshot({ ...ctx, cwd: foreign }, receipt.jobId, scope.cwd, epoch));
    assert.throws(() => jobs.monitorSnapshot(ctx, receipt.jobId, canonicalMonitorCwd(foreign), epoch));
    assert.throws(() => jobs.monitorSnapshot(ctx, receipt.jobId, scope.cwd, epoch + 1));
    owner = 'replaced'; assert.throws(() => held.snapshot(receipt.jobId)); owner = scope.sessionId;
    ctx.cwd = foreign; assert.throws(() => held.snapshot(receipt.jobId)); ctx.cwd = root;
    publisher.start(ctx); assert.throws(() => held.snapshot(receipt.jobId)); const current = acquireCapability('shell_job', scope); assert.equal(current.snapshot(receipt.jobId).jobId, receipt.jobId);
    publisher.stop(); let settled = false; const cleanup = jobs.shutdown().then(() => { settled = true; });
    assert.throws(() => current.snapshot(receipt.jobId)); assert.throws(() => acquireCapability('shell_job', scope)); await Promise.resolve(); assert.equal(settled, false, 'runner gate still holds shutdown');
    release(); await cleanup; assert.throws(() => jobs.monitorSnapshot(ctx, receipt.jobId, scope.cwd, epoch));
  } finally { publisher.stop(); release?.(); await jobs.shutdown(); rmSync(root, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
});
test('review adapter W1: capability rechecks validity AFTER a positive snapshot read', () => {
  let valid = true; const scope = { sessionId: 'post-read-fence', cwd: canonicalMonitorCwd(process.cwd()) };
  const revoke = publishCapability('shell_job', scope, 1, () => { valid = false; return { jobId: 'valid-job' }; }, () => valid);
  try { const lease = acquireCapability('shell_job', scope); assert.throws(() => lease.snapshot('valid-job')); } finally { revoke(); }
});
test('auto monitor request is scoped, replaceable, revocable and never throws', () => {
  const scope = { sessionId: 'auto-owner', cwd: canonicalMonitorCwd(process.cwd()) }, seen: string[] = [];
  assert.equal(requestAutoMonitor(scope, 'job-0'), undefined, 'no installed Monitor means no monitor');
  const revoke = publishAutoMonitor(scope, id => { seen.push(id); return 'MON1'; });
  assert.equal(requestAutoMonitor(scope, 'job-1'), 'MON1');
  assert.equal(requestAutoMonitor({ ...scope, sessionId: 'other' }, 'job-2'), undefined, 'a foreign owner is not served');
  const revokeNew = publishAutoMonitor(scope, () => { throw new Error('starter failure'); });
  assert.equal(requestAutoMonitor(scope, 'job-3'), undefined, 'a throwing starter is swallowed');
  revoke(); assert.equal(requestAutoMonitor(scope, 'job-4'), undefined, 'revoking the replaced starter keeps the newer one');
  revokeNew(); assert.deepEqual(seen, ['job-1']);
});
test('activeJobBriefs lists only owner-matching, valid providers as bounded id/status rows', async () => {
  const { activeJobBriefs } = await import('../src/monitor-capability.js');
  const scope = { sessionId: 'brief-owner', cwd: canonicalMonitorCwd(process.cwd()) };
  assert.deepEqual(activeJobBriefs(scope), { briefs: [], partial: false });
  let valid = true;
  const revoke = publishCapability('fork_job', scope, 1, () => ({}), () => valid, undefined, () => [{ kind: 'fork_job', jobId: 'F1', status: 'blocked' }]);
  const revokeShell = publishCapability('shell_job', scope, 1, () => ({}), () => true, undefined, () => { throw new Error('boom'); });
  assert.deepEqual(activeJobBriefs(scope), { briefs: [{ kind: 'fork_job', jobId: 'F1', status: 'blocked' }], partial: true });
  assert.deepEqual(activeJobBriefs({ ...scope, sessionId: 'other' }), { briefs: [], partial: false });
  valid = false;
  assert.deepEqual(activeJobBriefs(scope).briefs, []);
  revoke(); revokeShell();
});
test('activeMonitorBriefs reads only the owner-matching reader and marks malformed rows partial', async () => {
  const { activeMonitorBriefs, publishActiveMonitorBriefs } = await import('../src/monitor-capability.js');
  const scope = { sessionId: 'monitor-brief-owner', cwd: canonicalMonitorCwd(process.cwd()) };
  const brief = { monitorId: 'MON1', source: 'file', state: 'running', target: 'src/app.ts', label: 'schema', remainingMs: 60000 };
  assert.deepEqual(activeMonitorBriefs(scope), { briefs: [], partial: false }, 'no Monitor means no section');
  const revoke = publishActiveMonitorBriefs(scope, () => [brief]);
  assert.deepEqual(activeMonitorBriefs(scope), { briefs: [brief], partial: false });
  assert.deepEqual(activeMonitorBriefs({ ...scope, sessionId: 'other' }), { briefs: [], partial: false }, 'a foreign owner is not served');
  const revokeBad = publishActiveMonitorBriefs(scope, () => [brief, { monitorId: 'MON2', source: 'command' } as any]);
  assert.deepEqual(activeMonitorBriefs(scope), { briefs: [brief], partial: true }, 'a malformed row is dropped, not rendered');
  revokeBad();
  assert.deepEqual(activeMonitorBriefs(scope), { briefs: [], partial: false }, 'revoking the current reader publishes nothing');
  const revokeNew = publishActiveMonitorBriefs(scope, () => [brief]);
  revoke();
  assert.deepEqual(activeMonitorBriefs(scope).briefs, [brief], 'a stale revoke does not delete the newer reader');
  const revokeThrow = publishActiveMonitorBriefs({ ...scope, sessionId: 'monitor-brief-throw' }, () => { throw new Error('boom'); });
  assert.deepEqual(activeMonitorBriefs({ ...scope, sessionId: 'monitor-brief-throw' }), { briefs: [], partial: true });
  const many = Array.from({ length: 20 }, (_, i) => ({ ...brief, monitorId: `MON${i}` }));
  const revokeMany = publishActiveMonitorBriefs({ ...scope, sessionId: 'monitor-brief-many' }, () => many);
  const capped = activeMonitorBriefs({ ...scope, sessionId: 'monitor-brief-many' });
  assert.equal(capped.briefs.length, 16); assert.equal(capped.partial, true);
  revokeNew(); revokeThrow(); revokeMany();
  assert.deepEqual(activeMonitorBriefs(scope), { briefs: [], partial: false }, 'revoked reader publishes nothing');
});
test('active Shell briefs carry only the job id and status, never the command', async () => {
  const { activeJobBriefs } = await import('../src/monitor-capability.js');
  const root = mkdtempSync(join(tmpdir(), 'monitor-shell-brief-'));
  const jobs = new ShellJobs({ sendMessage() {} } as any), publisher = createShellMonitorPublisher(jobs);
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => 'brief-shell-owner' } };
  let release!: () => void, entered!: () => void; const running = new Promise<void>(r => { entered = r; });
  jobs.start(ctx);
  try {
    const receipt = jobs.submit(ctx, 'bash', 'brief-call', undefined, async () => { entered(); await new Promise<void>(r => { release = r; }); return { content: [], details: undefined, structuredContent: { output: 'x', exit_code: 0 } }; }, 'echo SECRET_COMMAND_TEXT');
    await running; publisher.start(ctx);
    const result = activeJobBriefs({ sessionId: 'brief-shell-owner', cwd: canonicalMonitorCwd(root) });
    assert.deepEqual(result, { briefs: [{ kind: 'shell_job', jobId: receipt.jobId, status: 'running' }], partial: false });
    assert.equal(JSON.stringify(result).includes('SECRET_COMMAND_TEXT'), false);
  } finally { publisher.stop(); release?.(); await jobs.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
test('PTY briefs are brief-only: scoped, revocable, bounded, and never a Monitor readonly source', () => {
  const scope = { sessionId: 'pty-owner', cwd: canonicalMonitorCwd(process.cwd()) };
  assert.deepEqual(activeJobBriefs(scope), { briefs: [], partial: false });
  let valid = true;
  const revoke = publishJobBriefs('pty_session', scope, () => [{ jobId: 'pty-1-1', status: 'running' }], () => valid);
  assert.deepEqual(activeJobBriefs(scope), { briefs: [{ kind: 'pty_session', jobId: 'pty-1-1', status: 'running' }], partial: false });
  assert.deepEqual(activeJobBriefs({ ...scope, sessionId: 'other' }).briefs, []);
  assert.throws(() => acquireCapability('shell_job', scope), 'no readonly snapshot exists for PTY');
  valid = false; assert.deepEqual(activeJobBriefs(scope), { briefs: [], partial: false }); valid = true;
  const second = publishJobBriefs('pty_session', scope, () => Array.from({ length: 20 }, (_, i) => ({ jobId: `p${i}`, status: 'running' })), () => true);
  const capped = activeJobBriefs(scope); assert.equal(capped.briefs.length, 16); assert.equal(capped.partial, true);
  revoke(); assert.equal(activeJobBriefs(scope).briefs.length, 16, 'a stale revoke cannot remove the replacement');
  second(); assert.deepEqual(activeJobBriefs(scope), { briefs: [], partial: false });
  const failing = publishJobBriefs('pty_session', scope, () => { throw new Error('boom'); }, () => true);
  assert.deepEqual(activeJobBriefs(scope), { briefs: [], partial: true }); failing();
});
