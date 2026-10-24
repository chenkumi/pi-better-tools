import assert from 'node:assert/strict';
import test from 'node:test';
import { jobLaunch } from '../src/sources.ts';
import { validateStart } from '../src/schema.ts';
import { publishCapability, acquireCapability } from '../../shell-tools/src/monitor-capability.ts';
import type { Clock } from '../src/core.ts';

/** Manual clock seam: the job source registers exactly one timer at a time, so tests fire it deterministically. */
function manual() {
  const tasks = new Map<number, () => void>(); let next = 0;
  const clock: Clock = { now: () => 0, set: (fn) => { const id = ++next; tasks.set(id, fn); return id; }, clear: (id) => { tasks.delete(id as number); } };
  const fire = () => { const entry = [...tasks][0]; if (!entry) return false; tasks.delete(entry[0]); entry[1](); return true; };
  return { clock, fire, pending: () => tasks.size };
}
function sink() {
  const events: any[] = [];
  return { events, started: () => events.push(['started']), data: (_i: unknown, _partial: boolean, snapshot?: unknown) => events.push(['data', snapshot]), fault: (kind: string) => events.push(['fault', kind]), closed: (evidence: unknown) => events.push(['closed', evidence]) };
}

test('subagent_job closes on aborted without scheduling another sample', async () => {
  const owner = { sessionId: 'subagent-source-aborted', cwd: process.cwd() };
  const statuses = ['running', 'aborted'];
  let reads = 0;
  const revoke = publishCapability('subagent_job', owner, 1, jobId => ({ jobId, status: statuses[reads++] }), () => true);
  const { clock, fire, pending } = manual(); const s = sink();
  const controller = new AbortController();
  try {
    const done = jobLaunch(acquireCapability('subagent_job', owner), 'JOB', 30000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    assert.equal(pending(), 1);
    assert.equal(fire(), true);
    assert.deepEqual(s.events.filter(e => e[0] === 'data').map(e => e[1].status), statuses);
    assert.deepEqual(s.events.at(-1), ['closed', { sourceClosed: true, timerCleared: true, observedJobCanceled: false }]);
    assert.equal(pending(), 0);
    await done;
    controller.abort();
    assert.equal(s.events.filter(e => e[0] === 'closed').length, 1);
    assert.equal(fire(), false);
    assert.equal(reads, 2);
  } finally { controller.abort(); revoke(); }
});

test('fork_job accepts the bounded source shape and refuses an unbounded interval', () => {
  assert.equal(validateStart({ source: { kind: 'fork_job', jobId: 'JOB' } }).source.kind, 'fork_job');
  assert.equal((validateStart({ source: { kind: 'fork_job', jobId: 'JOB', intervalMs: 30000 } }).source as any).intervalMs, 30000);
  assert.throws(() => validateStart({ source: { kind: 'fork_job' } }), /fork_job source "jobId" must be a non-empty string/);
  assert.throws(() => validateStart({ source: { kind: 'fork_job', jobId: 'JOB', intervalMs: 1000 } }), /integer 30000/);
  assert.throws(() => validateStart({ source: { kind: 'fork_job', jobId: '' } }));
  assert.throws(() => validateStart({ source: { kind: 'fork_job', jobId: 'JOB', cancel: true } }), /Unknown Monitor parameter/);
});

test('fork_job keeps sampling the non-terminal Fork statuses and stops only at a terminal Fork', async () => {
  const owner = { sessionId: 'fork-source-fixture', cwd: process.cwd() };
  const statuses = ['awaiting_snapshot', 'running', 'blocked', 'cancelling', 'cancelled'];
  let reads = 0, readsAtClose = 0;
  const revoke = publishCapability('fork_job', owner, 1, jobId => { reads++; return { jobId, status: statuses[Math.min(reads - 1, statuses.length - 1)], cancelRequested: statuses[Math.min(reads - 1, statuses.length - 1)] === 'cancelling', delivery: 'pending' }; }, () => true);
  const { clock, fire, pending } = manual(); const s = sink();
  try {
    const controller = new AbortController();
    const done = jobLaunch(acquireCapability('fork_job', owner), 'JOB', 30000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(s.events[0], ['started']);
    assert.equal(s.events[1][1].status, 'awaiting_snapshot');
    assert.equal(pending(), 1);
    for (let i = 0; i < 4; i++) fire();
    readsAtClose = reads;
    await done;
    assert.deepEqual(s.events.filter(e => e[0] === 'data').map(e => e[1].status), statuses);
    assert.deepEqual(s.events.filter(e => e[0] === 'data').at(-1)[1], { jobId: 'JOB', status: 'cancelled', cancelRequested: false, delivery: 'pending' });
    assert.deepEqual(s.events.at(-1), ['closed', { sourceClosed: true, timerCleared: true, observedJobCanceled: false }]);
    assert.equal(readsAtClose, statuses.length);
    assert.equal(pending(), 0, 'a terminal Fork must leave no sampling timer behind');
    assert.equal(s.events.some(e => e[0] === 'fault'), false);
  } finally { revoke(); }
});

test('fork_job abort closes the source without a snapshot and never cancels the Fork', async () => {
  const owner = { sessionId: 'fork-source-abort', cwd: process.cwd() };
  let reads = 0, revoke: (() => void) | undefined;
  revoke = publishCapability('fork_job', owner, 1, jobId => { reads++; return { jobId, status: 'running', cancelRequested: false, delivery: 'pending' }; }, () => true);
  const { clock, pending } = manual(); const s = sink();
  try {
    const controller = new AbortController();
    const done = jobLaunch(acquireCapability('fork_job', owner), 'JOB', 30000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    controller.abort();
    await done;
    assert.deepEqual(s.events.at(-1), ['closed', { sourceClosed: true, timerCleared: true, observedJobCanceled: false }]);
    assert.equal(reads, 1);
    assert.equal(pending(), 0);
  } finally { revoke?.(); }
});

test('fork_job without a published or still-valid capability faults instead of inventing a state', async () => {
  const owner = { sessionId: 'fork-source-missing', cwd: process.cwd() };
  assert.throws(() => acquireCapability('fork_job', owner), /Monitor readonly adapter unavailable/);
  const { clock } = manual(); const s = sink();
  const lease = (() => { const revoke = publishCapability('fork_job', owner, 1, id => ({ jobId: id, status: 'running' }), () => true); const acquired = acquireCapability('fork_job', owner); revoke(); return acquired; })();
  await jobLaunch(lease, 'JOB', 30000, clock)(s as any, new AbortController().signal, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(s.events.map(e => e[0]), ['started', 'fault', 'closed']);
  assert.deepEqual(s.events[1], ['fault', 'source_error']);
});
