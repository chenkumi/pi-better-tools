import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundJobs } from '../extensions/subagent/background.ts';
import { subagentMonitorSnapshot, publishSubagentMonitor } from '../extensions/subagent/monitor-capability.ts';
import { acquireCapability, canonicalMonitorCwd } from '../../shell-tools/src/monitor-capability.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('Monitor projection goes through provisional view, never private result/answer/lease completed', async () => {
  const jobs = new BackgroundJobs(() => {}); let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const receipt = jobs.submit('owner', '/cwd', jobs.epoch, ['worker'], async (_signal, _ids, _live, finish, _attach, interaction) => {
    finish(0, { output: 'PRIVATE_WORKER_ANSWER', status: 'completed', cleanupPending: false, cleanupEvidence: { originalLeaseReleased: true } }, 'completed');
    interaction(0, { kind: 'query_result', queryId: 'q', status: 'completed', output: 'PRIVATE_QUERY_ANSWER', cleanupPending: false });
    await pending;
  }, [], undefined, 'q');
  await Promise.resolve();
  const projected = subagentMonitorSnapshot(jobs, receipt.jobId, 'owner', '/cwd');
  const json = JSON.stringify(projected);
  assert.doesNotMatch(json, /PRIVATE_WORKER|PRIVATE_QUERY|originalLeaseReleased":true/);
  assert.equal((projected.tasks as any[])[0].status, 'running'); assert.equal((projected.tasks as any[])[0].cleanupPending, true);
  assert.throws(() => subagentMonitorSnapshot(jobs, receipt.jobId, 'foreign', '/cwd'));
  release(); await jobs.shutdown();
});
test('review adapter W1: positive Subagent job snapshot fences cwd/owner/epoch and held leases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-subagent-lease-')), foreign = mkdtempSync(join(tmpdir(), 'monitor-subagent-foreign-'));
  const cwd = canonicalMonitorCwd(root), jobs = new BackgroundJobs(() => {}); let owner = 'valid-subagent-owner', release!: () => void, entered!: () => void;
  const running = new Promise<void>(r => { entered = r; }); const ctx: any = { cwd: root, sessionManager: { getSessionId: () => owner } };
  const scope = { sessionId: owner, cwd }; let revoke: (() => void) | undefined;
  try {
    const receipt = jobs.submit(owner, cwd, jobs.epoch, ['worker'], async () => { entered(); await new Promise<void>(r => { release = r; }); });
    await running; revoke = publishSubagentMonitor(jobs, ctx); const held = acquireCapability('subagent_job', scope);
    assert.equal(held.snapshot(receipt.jobId).jobId, receipt.jobId);
    assert.throws(() => subagentMonitorSnapshot(jobs, receipt.jobId, 'foreign', cwd));
    assert.throws(() => subagentMonitorSnapshot(jobs, receipt.jobId, owner, canonicalMonitorCwd(foreign)));
    owner = 'replaced'; assert.throws(() => held.snapshot(receipt.jobId)); owner = scope.sessionId;
    ctx.cwd = foreign; assert.throws(() => held.snapshot(receipt.jobId)); ctx.cwd = root;
    const nextRevoke = publishSubagentMonitor(jobs, ctx); assert.throws(() => held.snapshot(receipt.jobId)); revoke(); revoke = nextRevoke;
    const current = acquireCapability('subagent_job', scope); assert.equal(current.snapshot(receipt.jobId).jobId, receipt.jobId);
    revoke(); let settled = false; const cleanup = jobs.shutdown().then(() => { settled = true; });
    assert.throws(() => current.snapshot(receipt.jobId)); assert.throws(() => acquireCapability('subagent_job', scope)); await Promise.resolve(); assert.equal(settled, false);
    release(); await cleanup; jobs.start(); assert.throws(() => subagentMonitorSnapshot(jobs, receipt.jobId, scope.sessionId, cwd), /NOT_FOUND/);
  } finally { revoke?.(); release?.(); await jobs.shutdown(); rmSync(root, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
});
