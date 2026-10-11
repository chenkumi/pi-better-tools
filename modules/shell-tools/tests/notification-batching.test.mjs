import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShellJobs, MAX_RETAINED_JOBS } from '../src/background-jobs.ts';

const boundary = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await boundary(); await boundary(); await boundary(); };
const success = output => ({ content: [{ type: 'text', text: output }], details: undefined, structuredContent: { output, exit_code: 0 } });
function fixture(onSend = () => {}) {
  let idle = false, queued = false, owner = 'owner', sendFailure = false, attempts = 0;
  const messages = [];
  const ctx = { sessionManager: { getSessionId: () => owner }, isIdle: () => idle, hasPendingMessages: () => queued };
  const jobs = new ShellJobs({ sendMessage(message, options) { attempts++; if (sendFailure) throw new Error('send rejected'); messages.push({ message, options }); onSend(); } });
  jobs.start(ctx);
  return { jobs, ctx, messages, attempts: () => attempts, idle: value => { idle = value; }, queued: value => { queued = value; }, owner: value => { owner = value; }, fail: value => { sendFailure = value; } };
}

const steering = { triggerTurn: true, deliverAs: 'steer' };

test('non-agent compaction and inactive retained queues do not strand a completion without a settle event', async () => {
  for (const queued of [false, true]) {
    const messages = [];
    const ctx = { sessionManager: { getSessionId: () => 'manual-owner' }, isIdle: () => false, hasPendingMessages: () => queued };
    const jobs = new ShellJobs({ sendMessage: (...args) => messages.push(args) }); jobs.start(ctx);
    try {
      jobs.submit(ctx, 'bash', 'manual', undefined, async () => success('manual'));
      await flush();
      assert.equal(messages.length, 1, 'submission does not require a host idle/settle event');
      assert.deepEqual(messages[0][1], steering);
    } finally { await jobs.shutdown(); }
  }
});

test('same-loop busy completions coalesce all outcomes without waiting for parent settlement', async () => {
  const f = fixture();
  try {
    const receipts = Array.from({ length: 5 }, (_, index) => f.jobs.submit(f.ctx, 'bash', `busy-${index}`, undefined, async () => index === 2
      ? { ...success('failure output'), isError: true, structuredContent: { output: 'failure output', exit_code: 7 } }
      : success(`result-${index}`)));
    assert.equal(f.messages.length, 0, 'receipt precedes notification');
    await flush();
    assert.equal(f.ctx.isIdle(), false);
    assert.deepEqual(receipts.map(r => f.jobs.status(f.ctx, r.jobId).status), ['completed', 'completed', 'failed', 'completed', 'completed']);
    assert.equal(f.messages.length, 1);
    const { message, options } = f.messages[0];
    assert.deepEqual(message.details.jobs.map(j => j.jobId), receipts.map(r => r.jobId));
    assert.deepEqual(message.details.jobs.map(j => j.exitCode), [0, 0, 7, 0, 0]);
    assert.deepEqual(options, steering);
    const modelJobs = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
    assert.equal(modelJobs.length, 5);
    assert.equal(modelJobs[2].status, 'failed');
    f.idle(true); f.jobs.flushPending(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1, 'settlement does not resend an already submitted batch');
  } finally { await f.jobs.shutdown(); }
});

test('separate event-loop completions submit promptly while the parent remains busy', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 5; index++) {
      const receipt = f.jobs.submit(f.ctx, 'bash', `separate-${index}`, undefined, async () => success(`result-${index}`));
      await flush();
      assert.equal(f.messages.length, index + 1);
      assert.deepEqual(f.messages[index].options, steering);
      assert.deepEqual(f.messages[index].message.details.jobs.map(j => j.jobId), [receipt.jobId]);
    }
    assert.equal(f.ctx.isIdle(), false);
  } finally { await f.jobs.shutdown(); }
});

test('busy submission occurs once even if sendMessage synchronously reenters a lifecycle hook', async () => {
  let reentered = false;
  const f = fixture(() => { if (!reentered) { reentered = true; f.jobs.flushPending(f.ctx); } });
  try {
    f.jobs.submit(f.ctx, 'bash', 'one', undefined, async () => success('one'));
    await flush();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message.details.jobs.length, 1);
    await flush();
    assert.equal(f.messages.length, 1);
  } finally { await f.jobs.shutdown(); }
});

test('completion added during send is submitted as the next batch without settlement', async () => {
  let late;
  const f = fixture(() => {
    if (!late) {
      late = f.jobs.submit(f.ctx, 'bash', 'late', undefined, async () => success('late'));
      f.jobs.flushPending(f.ctx);
    }
  });
  try {
    const first = f.jobs.submit(f.ctx, 'bash', 'first', undefined, async () => success('first'));
    await flush(); await flush();
    assert.equal(f.messages.length, 2);
    assert.deepEqual(f.messages[0].message.details.jobs.map(j => j.jobId), [first.jobId]);
    assert.equal(f.jobs.status(f.ctx, late.jobId).status, 'completed');
    assert.deepEqual(f.messages[1].message.details.jobs.map(j => j.jobId), [late.jobId]);
    f.idle(true); f.jobs.flushPending(f.ctx);
    await flush();
    assert.equal(f.messages.length, 2);
  } finally { await f.jobs.shutdown(); }
});

test('sender shutdown and awaited rebind cannot duplicate an old batch or suppress the new owner', async () => {
  let closing, firstSend = true;
  const f = fixture(() => { if (firstSend) { firstSend = false; closing = f.jobs.shutdown('reload'); } });
  try {
    const old = f.jobs.submit(f.ctx, 'bash', 'old', undefined, async () => success('old'));
    await flush(); await closing;
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.messages[0].message.details.jobs.map(j => j.jobId), [old.jobId]);
    f.owner('replacement'); f.jobs.start(f.ctx);
    f.jobs.flushPending({ ...f.ctx, sessionManager: { getSessionId: () => 'owner' } });
    const fresh = f.jobs.submit(f.ctx, 'bash', 'new', undefined, async () => success('new'));
    await flush();
    assert.equal(f.messages.length, 2);
    assert.deepEqual(f.messages[1].message.details.jobs.map(j => j.jobId), [fresh.jobId]);
    assert.throws(() => f.jobs.status(f.ctx, old.jobId), /No retained job record/);
  } finally { await f.jobs.shutdown(); }
});

test('a fresh busy run and queued user work do not delay an already completed result', async () => {
  const f = fixture();
  try {
    f.fail(true);
    f.jobs.submit(f.ctx, 'bash', 'one', undefined, async () => success('one'));
    await flush();
    assert.equal(f.messages.length, 0);
    f.fail(false); f.idle(true); f.jobs.flushPending(f.ctx); f.idle(false); f.queued(true);
    await flush();
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.messages[0].options, steering);
    f.queued(false); f.jobs.flushPending(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1);
  } finally { await f.jobs.shutdown(); }
});

test('a pending result is protected from retention eviction until a successful batch submission', async () => {
  const f = fixture();
  try {
    f.fail(true);
    const receipts = [];
    for (let i = 0; i < MAX_RETAINED_JOBS; i++) {
      receipts.push(f.jobs.submit(f.ctx, 'bash', `retained-${i}`, undefined, async () => success('done')));
      await flush();
    }
    assert.equal(f.messages.length, 0);
    assert.throws(() => f.jobs.submit(f.ctx, 'bash', 'overflow', undefined, async () => success('not started')), /retention limit/);
    const attempts = f.attempts();
    await flush();
    assert.equal(f.attempts(), attempts, 'synchronous send failure does not create a retry loop');
    f.jobs.flushPending(f.ctx);
    await flush();
    assert.equal(f.messages.length, 0);
    assert.throws(() => f.jobs.submit(f.ctx, 'bash', 'still-pending', undefined, async () => success('not started')), /retention limit/);
    assert.equal(f.jobs.status(f.ctx, receipts[0].jobId).status, 'completed');
    f.fail(false); f.jobs.flushPending(f.ctx);
    await flush();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message.details.jobs.length, MAX_RETAINED_JOBS);
    assert.doesNotThrow(() => f.jobs.submit(f.ctx, 'bash', 'after-send', undefined, async () => success('new')));
    await flush();
    assert.equal(f.messages.length, 2, 'busy completions still submit promptly');
  } finally { await f.jobs.shutdown(); }
});

test('shutdown and foreign lifecycle events cannot flush a pending old-owner batch into a replacement', async () => {
  const f = fixture();
  try {
    f.fail(true);
    f.jobs.submit(f.ctx, 'bash', 'old', undefined, async () => success('old'));
    await flush();
    assert.equal(f.messages.length, 0);
    f.fail(false);
    f.jobs.flushPending({ ...f.ctx, sessionManager: { getSessionId: () => 'foreign' } });
    f.jobs.flushPending({ ...f.ctx, sessionManager: { getSessionId: () => { throw new Error('disposed foreign event'); } } });
    assert.equal(f.jobs.status(f.ctx, f.jobs.list(f.ctx)[0].jobId).status, 'completed', 'a bad foreign callback cannot shut down the real owner');
    await flush();
    assert.equal(f.messages.length, 0);
    f.jobs.flushPending(f.ctx);
    await f.jobs.shutdown('reload');
    f.owner('replacement'); f.jobs.start(f.ctx);
    f.jobs.flushPending(f.ctx);
    await flush();
    assert.equal(f.messages.length, 0);
  } finally { await f.jobs.shutdown(); }
});
