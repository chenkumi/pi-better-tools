import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShellJobs, MAX_RETAINED_JOBS } from '../src/background-jobs.ts';

const boundary = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await boundary(); await boundary(); await boundary(); };
const success = output => ({ content: [{ type: 'text', text: output }], details: undefined, structuredContent: { output, exit_code: 0 } });
function fixture(onSend = () => {}) {
  let idle = false, queued = false, owner = 'owner', sendFailure = false;
  const messages = [];
  const ctx = { sessionManager: { getSessionId: () => owner }, isIdle: () => idle, hasPendingMessages: () => queued };
  const jobs = new ShellJobs({ sendMessage(message, options) { if (sendFailure) throw new Error('send rejected'); messages.push({ message, options }); onSend(); } });
  jobs.start(ctx); jobs.setAgentActive(ctx, true);
  return { jobs, ctx, messages, idle: value => { idle = value; jobs.setAgentActive(ctx, !idle || queued); }, queued: value => { queued = value; jobs.setAgentActive(ctx, !idle || queued); }, owner: value => { owner = value; }, fail: value => { sendFailure = value; } };
}

test('non-agent compaction and inactive retained queues do not strand a completion without a settle event', async () => {
  for (const queued of [false, true]) {
    const messages = [];
    const ctx = { sessionManager: { getSessionId: () => 'manual-owner' }, isIdle: () => false, hasPendingMessages: () => queued };
    const jobs = new ShellJobs({ sendMessage: (...args) => messages.push(args) }); jobs.start(ctx);
    try {
      jobs.submit(ctx, 'bash', 'manual', undefined, async () => success('manual'));
      await flush();
      assert.equal(messages.length, 1, 'only the active agent run defers batching, not every SDK busy state');
    } finally { await jobs.shutdown(); }
  }
});

test('separate completion events stay local while busy and one idle opportunity sends all outcomes', async () => {
  const f = fixture();
  const receipts = [];
  try {
    for (let index = 0; index < 5; index++) {
      receipts.push(f.jobs.submit(f.ctx, 'bash', `busy-${index}`, undefined, async () => index === 2
        ? { ...success('failure output'), isError: true, structuredContent: { output: 'failure output', exit_code: 7 } }
        : success(`result-${index}`)));
      await flush();
      assert.equal(f.messages.length, 0, 'busy completions must not prequeue individual followUps');
    }
    assert.deepEqual(receipts.map(r => f.jobs.status(f.ctx, r.jobId).status), ['completed', 'completed', 'failed', 'completed', 'completed']);
    f.idle(true);
    f.jobs.flushWhenIdle(f.ctx);
    f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1);
    const { message, options } = f.messages[0];
    assert.deepEqual(message.details.jobs.map(j => j.jobId), receipts.map(r => r.jobId));
    assert.deepEqual(message.details.jobs.map(j => j.exitCode), [0, 0, 7, 0, 0]);
    assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
    const modelJobs = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
    assert.equal(modelJobs.length, 5);
    assert.equal(modelJobs[2].status, 'failed');
    f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1, 'the same batch is not sent twice');
  } finally { await f.jobs.shutdown(); }
});

test('settlement sends the busy batch once even if sendMessage synchronously reenters a lifecycle hook', async () => {
  let reentered = false;
  const f = fixture(() => { if (!reentered) { reentered = true; f.jobs.flushWhenIdle(f.ctx); } });
  try {
    f.jobs.submit(f.ctx, 'bash', 'one', undefined, async () => success('one'));
    await flush();
    assert.equal(f.messages.length, 0);
    f.idle(true); f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message.details.jobs.length, 1);
    await flush();
    assert.equal(f.messages.length, 1);
  } finally { await f.jobs.shutdown(); }
});

test('completion added during send remains pending for the next settled batch', async () => {
  let late;
  const f = fixture(() => {
    if (!late) {
      f.idle(false); // The delivered batch starts a fresh run.
      late = f.jobs.submit(f.ctx, 'bash', 'late', undefined, async () => success('late'));
      f.jobs.flushWhenIdle(f.ctx);
    }
  });
  try {
    const first = f.jobs.submit(f.ctx, 'bash', 'first', undefined, async () => success('first'));
    await flush();
    f.idle(true); f.jobs.flushWhenIdle(f.ctx);
    await flush(); await flush();
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.messages[0].message.details.jobs.map(j => j.jobId), [first.jobId]);
    assert.equal(f.jobs.status(f.ctx, late.jobId).status, 'completed');
    f.idle(true); f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 2);
    assert.deepEqual(f.messages[1].message.details.jobs.map(j => j.jobId), [late.jobId]);
  } finally { await f.jobs.shutdown(); }
});

test('sender shutdown and awaited rebind cannot duplicate an old batch or suppress the new owner', async () => {
  let closing, firstSend = true;
  const f = fixture(() => { if (firstSend) { firstSend = false; closing = f.jobs.shutdown('reload'); } });
  try {
    const old = f.jobs.submit(f.ctx, 'bash', 'old', undefined, async () => success('old'));
    await flush();
    f.idle(true); f.jobs.flushWhenIdle(f.ctx);
    await flush(); await closing;
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.messages[0].message.details.jobs.map(j => j.jobId), [old.jobId]);
    f.owner('replacement'); f.jobs.start(f.ctx);
    f.jobs.flushWhenIdle({ ...f.ctx, sessionManager: { getSessionId: () => 'owner' } });
    const fresh = f.jobs.submit(f.ctx, 'bash', 'new', undefined, async () => success('new'));
    await flush();
    assert.equal(f.messages.length, 2);
    assert.deepEqual(f.messages[1].message.details.jobs.map(j => j.jobId), [fresh.jobId]);
    assert.throws(() => f.jobs.status(f.ctx, old.jobId), /No retained job record/);
  } finally { await f.jobs.shutdown(); }
});

test('idle callback rechecks new work and queued continuation instead of sending a stale batch', async () => {
  const f = fixture();
  try {
    f.jobs.submit(f.ctx, 'bash', 'one', undefined, async () => success('one'));
    await flush();
    assert.equal(f.messages.length, 0);
    f.idle(true); f.jobs.flushWhenIdle(f.ctx); f.idle(false);
    await flush();
    assert.equal(f.messages.length, 0);
    f.idle(true); f.queued(true); f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 0);
    f.queued(false); f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1);
  } finally { await f.jobs.shutdown(); }
});

test('a pending result is protected from retention eviction until a successful batch submission', async () => {
  const f = fixture();
  try {
    const receipts = [];
    for (let i = 0; i < MAX_RETAINED_JOBS; i++) {
      receipts.push(f.jobs.submit(f.ctx, 'bash', `retained-${i}`, undefined, async () => success('done')));
      await flush();
    }
    assert.equal(f.messages.length, 0);
    assert.throws(() => f.jobs.submit(f.ctx, 'bash', 'overflow', undefined, async () => success('not started')), /retention limit/);
    f.idle(true); f.fail(true); f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 0);
    assert.throws(() => f.jobs.submit(f.ctx, 'bash', 'still-pending', undefined, async () => success('not started')), /retention limit/);
    assert.equal(f.jobs.status(f.ctx, receipts[0].jobId).status, 'completed');
    f.fail(false); f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message.details.jobs.length, MAX_RETAINED_JOBS);
    assert.doesNotThrow(() => f.jobs.submit(f.ctx, 'bash', 'after-send', undefined, async () => success('new')));
    await flush();
    assert.equal(f.messages.length, 2, 'idle completions still wake the owner promptly');
  } finally { await f.jobs.shutdown(); }
});

test('shutdown and foreign idle events cannot flush an old owner batch into a replacement', async () => {
  const f = fixture();
  try {
    f.jobs.submit(f.ctx, 'bash', 'old', undefined, async () => success('old'));
    await flush();
    assert.equal(f.messages.length, 0);
    f.idle(true);
    f.jobs.flushWhenIdle({ ...f.ctx, sessionManager: { getSessionId: () => 'foreign' } });
    f.jobs.flushWhenIdle({ ...f.ctx, sessionManager: { getSessionId: () => { throw new Error('disposed foreign event'); } } });
    assert.equal(f.jobs.status(f.ctx, f.jobs.list(f.ctx)[0].jobId).status, 'completed', 'a bad foreign callback cannot shut down the real owner');
    await flush();
    assert.equal(f.messages.length, 0);
    f.jobs.flushWhenIdle(f.ctx);
    await f.jobs.shutdown('reload');
    f.owner('replacement'); f.jobs.start(f.ctx);
    f.jobs.flushWhenIdle(f.ctx);
    await flush();
    assert.equal(f.messages.length, 0);
  } finally { await f.jobs.shutdown(); }
});
