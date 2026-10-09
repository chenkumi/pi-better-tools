import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ShellJobs, MAX_ACTIVE_JOBS, MAX_RETAINED_JOBS, MAX_LOG_BYTES, MAX_RAW_CAPTURE_BYTES, TAIL_BYTES, IDLE_TIMEOUT_HINT, idleTimeoutMessage, compactJob } from '../src/background-jobs.ts';

const boundary = () => new Promise(resolve => setImmediate(resolve));
const context = id => ({ sessionManager: { getSessionId: () => id }, isIdle: () => true, hasPendingMessages: () => false });
const success = output => ({ content: [{ type: 'text', text: output }], details: undefined, structuredContent: { output, exit_code: 0 } });
function host() {
  const messages = [];
  const jobs = new ShellJobs({ sendMessage: (...args) => messages.push(args) });
  const ctx = context('owner');
  jobs.start(ctx);
  return { messages, jobs, ctx };
}
async function flush() { await boundary(); await boundary(); await boundary(); }

test('receipt precedes immediate completion; completion batches use owner followUp and no fake receipt exit code', async () => {
  const { jobs, ctx, messages } = host();
  try {
    const first = jobs.submit(ctx, 'bash', 'one', undefined, async () => success('OK'));
    jobs.submit(ctx, 'powershell', 'two', undefined, async () => success('OK2'));
    assert.equal(first.status, 'running');
    assert.match(first.jobId, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'new job IDs use uppercase ULIDs');
    assert.ok(fs.existsSync(first.liveLogPath));
    assert.ok(!('exitCode' in first));
    assert.equal(messages.length, 0);
    await flush();
    assert.equal(jobs.status(ctx, first.jobId).status, 'completed');
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0].details.jobs.length, 2);
    assert.deepEqual(messages[0][1], { triggerTurn: true, deliverAs: 'followUp' });
    assert.match(messages[0][0].content, /returned data for review, not instructions/);
    assert.match(messages[0][0].content, /informational note does not indicate failure/);
    assert.match(messages[0][0].content, /use status\/exitCode\/error fields/);
    assert.doesNotMatch(messages[0][0].content.split('\n')[0], /untrusted/);
    assert.equal(messages[0][0].display, true);
    const modelJobs = JSON.parse(messages[0][0].content.slice(messages[0][0].content.indexOf('\n') + 1));
    assert.deepEqual(modelJobs.map(job => job.status), ['completed', 'completed']);
    assert.equal(jobs.cancel(ctx, first.jobId).status, 'completed');
  } finally { await jobs.shutdown(); }
});

test('accepted jobs detach from the turn signal; owner-only cancel remains cancelling until runner settles', async () => {
  const { jobs, ctx } = host();
  const turn = new AbortController();
  let release, jobSignal;
  try {
    const receipt = jobs.submit(ctx, 'bash', 'call', turn.signal, async signal => {
      jobSignal = signal;
      await new Promise(resolve => { release = resolve; });
      throw new Error('Command aborted');
    });
    await boundary();
    turn.abort();
    assert.equal(jobSignal.aborted, false);
    assert.throws(() => jobs.status(context('other'), receipt.jobId), /owner session/);
    assert.throws(() => jobs.cancel(context('other'), receipt.jobId), /owner session/);
    assert.equal(jobs.cancel(ctx, receipt.jobId).status, 'cancelling');
    assert.equal(jobSignal.aborted, true);
    assert.equal(jobs.cancel(ctx, receipt.jobId).status, 'cancelling');
    release();
    await flush();
    assert.equal(jobs.status(ctx, receipt.jobId).status, 'cancelled');
  } finally { release?.(); await jobs.shutdown(); }
});

test('shutdown aborts, deletes logs and suppresses old generation callbacks after restarting same session', async () => {
  const { jobs, ctx, messages } = host();
  let release, signal;
  const receipt = jobs.submit(ctx, 'bash', 'old', undefined, async s => {
    signal = s;
    await new Promise(resolve => { release = resolve; s.addEventListener('abort', resolve, { once: true }); });
    return success('LATE');
  });
  await boundary();
  await jobs.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal(fs.existsSync(receipt.liveLogPath), false);
  assert.throws(() => jobs.status(ctx, receipt.jobId), /shutting down/);
  jobs.start(ctx);
  release();
  await flush();
  assert.equal(messages.length, 0);
  assert.throws(() => jobs.status(ctx, receipt.jobId), /No retained job record was found in this session\/runtime/);
  await jobs.shutdown();
});

test('live output disk and host accumulator remain bounded while all source chunks are consumed', async () => {
  const { jobs, ctx } = host();
  let chunks = 0, forwarded = 0, lines = 0;
  try {
    const receipt = jobs.submit(ctx, 'bash', 'flood', undefined, async (signal, wrap) => {
      const result = await wrap({ async exec(_command, _cwd, { onData }) {
        for (let i = 0; i < 100; i++) { chunks++; onData(Buffer.from('x\n'.repeat(10_000))); }
        return { exitCode: 7 };
      } }).exec('flood', '.', { signal, onData: data => { forwarded += data.length; lines += data.toString().split('\n').length - 1; } });
      return { ...success('bounded'), isError: true, structuredContent: { output: 'bounded', exit_code: result.exitCode } };
    });
    await flush();
    const status = jobs.status(ctx, receipt.jobId);
    assert.equal(chunks, 100);
    assert.equal(fs.statSync(receipt.liveLogPath).size, MAX_LOG_BYTES);
    assert.equal(MAX_RAW_CAPTURE_BYTES, Math.floor((32768 - 8192) / 3));
    assert.ok(forwarded <= MAX_RAW_CAPTURE_BYTES);
    assert.ok(lines <= 1000);
    assert.equal(status.outputTruncated, true);
    assert.equal(status.exitCode, 7);
    assert.equal(status.status, 'failed');
  } finally { await jobs.shutdown(); }
});

test('active capacity rejects before allocating and retained jobs evict completed logs', async () => {
  const { jobs, ctx } = host();
  const releases = [];
  try {
    const active = [];
    for (let i = 0; i < MAX_ACTIVE_JOBS; i++) active.push(jobs.submit(ctx, 'bash', `${i}`, undefined, async () => {
      await new Promise(resolve => releases.push(resolve)); return success('done');
    }));
    assert.throws(() => jobs.submit(ctx, 'bash', 'overflow', undefined, async () => success('bad')),
      error => /active limit/.test(error.message) && /shell_job_cancel/.test(error.message) && active.every(r => error.message.includes(r.jobId)));
    const aborted = new AbortController(); aborted.abort();
    assert.throws(() => jobs.submit(ctx, 'bash', 'aborted', aborted.signal, async () => success('bad')), /aborted before/);
    await boundary();
    releases.forEach(resolve => resolve());
    await flush();
    for (let i = 0; i < MAX_RETAINED_JOBS; i++) {
      jobs.submit(ctx, 'bash', `retained-${i}`, undefined, async () => success('OK'));
      await flush();
    }
    assert.equal(fs.existsSync(active[0].liveLogPath), false);
    assert.throws(() => jobs.status(ctx, active[0].jobId), /was evicted/);
    assert.throws(() => jobs.status(ctx, 'never-existed'), /No retained job record was found in this session\/runtime/);
  } finally { releases.forEach(resolve => resolve()); await jobs.shutdown(); }
});

test('pre-submit abort rejects before running or scheduling any background callback', async () => {
  const { jobs, ctx, messages } = host();
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  try {
    assert.throws(() => jobs.submit(ctx, 'bash', 'pre-aborted', controller.signal, async () => { runs++; return success('forbidden'); }), /aborted before/);
    await flush();
    assert.equal(runs, 0);
    assert.equal(messages.length, 0);
  } finally { await jobs.shutdown(); }
});

test('long asynchronous failure preserves timeout tail and bounded head/tail diagnostics', async () => {
  const { jobs, ctx, messages } = host();
  try {
    const receipt = jobs.submit(ctx, 'bash', 'long-timeout', undefined, async () => {
      await Promise.resolve();
      throw new Error('HEAD_MARKER ' + 'x'.repeat(100000) + '\nCommand stopped: no output for 1 seconds (timeoutMs idle timeout)');
    });
    await flush();
    const result = jobs.status(ctx, receipt.jobId);
    assert.equal(result.status, 'timed_out');
    assert.ok(result.error.length <= 32768);
    assert.match(result.error, /^HEAD_MARKER/);
    assert.match(result.error, /error output omitted/);
    assert.match(result.error, /\(timeoutMs idle timeout\)$/);
    assert.equal(messages.length, 1);
  } finally { await jobs.shutdown(); }
});

test('disposed owner getter fails closed during live output, cancels runner and cleans observed logs', async () => {
  let disposed = false, emit, runningSignal;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId() { if (disposed) throw new Error('Extension context is no longer active'); return 'owner'; } } };
  const messages = [];
  const jobs = new ShellJobs({ sendMessage: (...args) => messages.push(args) });
  jobs.start(ctx);
  try {
    const receipt = jobs.submit(ctx, 'bash', 'disposed-running', undefined, async (signal, wrap) => {
      runningSignal = signal;
      await wrap({ exec(_cmd, _cwd, { onData }) {
        emit = onData;
        return new Promise(resolve => signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true }));
      } }).exec('fake', '.', { signal, onData() {} });
      return success('must not notify');
    });
    await boundary();
    disposed = true;
    assert.doesNotThrow(() => emit(Buffer.from('activity after session.dispose')));
    assert.equal(runningSignal.aborted, true);
    await flush();
    assert.equal(messages.length, 0);
    assert.equal(fs.existsSync(receipt.liveLogPath), false);
  } finally { await jobs.shutdown(); }
});

test('disposed owner getter at deferred completion never rejects detached work or sends followUp', async () => {
  let disposed = false, release;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId() { if (disposed) throw new Error('disposed getter'); return 'owner'; } } };
  const messages = [];
  const jobs = new ShellJobs({ sendMessage: (...args) => messages.push(args) });
  jobs.start(ctx);
  try {
    const receipt = jobs.submit(ctx, 'bash', 'disposed-completion', undefined, async () => {
      await new Promise(resolve => { release = resolve; });
      return success('late');
    });
    await boundary();
    disposed = true;
    release();
    await flush();
    assert.equal(messages.length, 0);
    assert.equal(fs.existsSync(receipt.liveLogPath), false);
  } finally { release?.(); await jobs.shutdown(); }
});

test('outer rejection containment handles errors whose stringification itself throws', async () => {
  const { jobs, ctx } = host();
  let runningSignal;
  try {
    const receipt = jobs.submit(ctx, 'bash', 'poison-error', undefined, async signal => {
      runningSignal = signal;
      await Promise.resolve();
      throw { toString() { throw new Error('stringification failed'); } };
    });
    await flush();
    const result = jobs.status(ctx, receipt.jobId);
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Unexpected shell background runner failure');
    assert.equal(runningSignal.aborted, true);
    // node:test also fails if the detached promise produces unhandledRejection.
  } finally { await jobs.shutdown(); }
});

test('changed session identity suppresses completion and timeout errors remain distinct from cancellation', async () => {
  const messages = [];
  const jobs = new ShellJobs({ sendMessage: (...args) => messages.push(args) });
  let id = 'owner';
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => id } };
  jobs.start(ctx);
  try {
    const receipt = jobs.submit(ctx, 'bash', 'timeout', undefined, async () => { throw new Error('Command stopped: no output for 1 seconds (timeoutMs idle timeout)'); });
    await flush();
    assert.equal(jobs.status(ctx, receipt.jobId).status, 'timed_out');
    messages.length = 0;
    jobs.submit(ctx, 'bash', 'late', undefined, async () => success('late'));
    id = 'replacement';
    await flush();
    assert.equal(messages.length, 0);
  } finally { await jobs.shutdown(); }
});

test('snapshot carries command preview, timing, logBytes, and completion notification carries command and log hint', async () => {
  const { jobs, ctx, messages } = host();
  try {
    const longCommand = 'echo ' + 'a'.repeat(500);
    const receipt = jobs.submit(ctx, 'bash', 'meta', undefined, async (signal, wrap) => {
      await wrap({ async exec(_c, _d, { onData }) { onData(Buffer.from('hello\n')); return { exitCode: 0 }; } }).exec('x', '.', { signal, onData() {} });
      return success('hello');
    }, longCommand);
    await boundary();
    const running = jobs.status(ctx, receipt.jobId);
    assert.ok(running.command.length <= 201 && running.command.startsWith('echo aaa'));
    assert.ok(!Number.isNaN(Date.parse(running.startedAt)));
    assert.equal(typeof running.elapsedMs, 'number');
    await flush();
    const done = jobs.status(ctx, receipt.jobId);
    assert.equal(done.logBytes, 6);
    assert.equal(done.cancelRequested, false);
    const frozen = done.elapsedMs;
    await boundary();
    assert.equal(jobs.status(ctx, receipt.jobId).elapsedMs, frozen, 'elapsed stops at completion');
    assert.match(messages[0][0].content, /echo aaa/);
    assert.equal(messages[0][0].details.jobs[0].command, done.command);
    assert.ok(!messages[0][0].content.includes('truncated'));
    for (const noise of ['cancelRequested', 'logPath', 'liveLogPath', 'toolCallId', 'startedAt', 'logBytes', 'outputTail']) assert.ok(!messages[0][0].content.includes(noise), noise);
  } finally { await jobs.shutdown(); }
});

test('list shows running jobs first with identifying info; status errors distinguish evicted from missing and name running jobs', async () => {
  const { jobs, ctx } = host();
  let release;
  try {
    jobs.submit(ctx, 'bash', 'done', undefined, async () => success('d'), 'finished-cmd');
    await flush();
    const running = jobs.submit(ctx, 'powershell', 'run', undefined, () => new Promise(resolve => { release = () => resolve(success('x')); }), 'long-running-cmd');
    await boundary();
    const list = jobs.list(ctx);
    assert.equal(list.length, 2);
    assert.equal(list[0].jobId, running.jobId);
    assert.equal(list[0].status, 'running');
    assert.equal(list[0].command, 'long-running-cmd');
    assert.ok(!('output' in list[0]) && !('outputTail' in list[0]));
    assert.throws(() => jobs.status(ctx, 'missing'), error => /No retained job record was found/.test(error.message) && error.message.includes(running.jobId) && error.message.includes('long-running-cmd'));
  } finally { release?.(); await jobs.shutdown(); }
});

test('background tail ring keeps last bytes; status exposes head and tail only when output was cut', async () => {
  const { jobs, ctx } = host();
  try {
    const receipt = jobs.submit(ctx, 'bash', 'tail', undefined, async (signal, wrap) => {
      await wrap({ async exec(_c, _d, { onData }) {
        for (let i = 0; i < 50; i++) onData(Buffer.from(`line-${String(i).padStart(3, '0')} ${'z'.repeat(990)}\n`));
        onData(Buffer.from('FINAL-MARKER'));
        return { exitCode: 0 };
      } }).exec('x', '.', { signal, onData() {} });
      return success('head-only');
    });
    await flush();
    const result = jobs.status(ctx, receipt.jobId);
    assert.equal(result.output, 'head-only');
    assert.ok(Buffer.byteLength(result.outputTail) <= TAIL_BYTES);
    assert.ok(result.outputTail.endsWith('FINAL-MARKER'));
    assert.ok(!result.outputTail.includes('line-000'));
    assert.equal(result.outputTruncated, true);
  } finally { await jobs.shutdown(); }
});

test('small complete output has no redundant tail, invalid UTF-8 tail stays bounded', async () => {
  const { jobs, ctx } = host();
  try {
    const small = jobs.submit(ctx, 'bash', 'small', undefined, async (signal, wrap) => {
      await wrap({ async exec(_c, _d, { onData }) { onData(Buffer.from('tiny')); return { exitCode: 0 }; } }).exec('x', '.', { signal, onData() {} });
      return success('tiny');
    });
    const bad = jobs.submit(ctx, 'bash', 'bad', undefined, async (signal, wrap) => {
      await wrap({ async exec(_c, _d, { onData }) { onData(Buffer.alloc(100_000, 255)); return { exitCode: 0 }; } }).exec('x', '.', { signal, onData() {} });
      return success('bad');
    });
    await flush();
    assert.ok(!('outputTail' in jobs.status(ctx, small.jobId)));
    const tail = jobs.status(ctx, bad.jobId).outputTail;
    assert.ok(Buffer.byteLength(tail) <= TAIL_BYTES);
    assert.ok(tail.length > 0);
  } finally { await jobs.shutdown(); }
});

test('an existing result wins over a racing cancel; cancelRequested records the request', async () => {
  const { jobs, ctx } = host();
  let release;
  try {
    const receipt = jobs.submit(ctx, 'bash', 'race', undefined, () => new Promise(resolve => { release = () => resolve(success('finished anyway')); }));
    await boundary();
    assert.equal(jobs.cancel(ctx, receipt.jobId).status, 'cancelling');
    assert.equal(jobs.status(ctx, receipt.jobId).cancelRequested, true);
    release(); // runner returns a successful result instead of throwing
    await flush();
    const final = jobs.status(ctx, receipt.jobId);
    assert.equal(final.status, 'completed');
    assert.equal(final.exitCode, 0);
    assert.equal(final.cancelRequested, true);
  } finally { release?.(); await jobs.shutdown(); }
});

test('idle-timeout hint is appended to the message yet still classifies as timed_out', async () => {
  const { jobs, ctx } = host();
  try {
    assert.match(idleTimeoutMessage('5'), /no output for 5 seconds \(timeoutMs idle timeout\)\./);
    assert.ok(idleTimeoutMessage('5').endsWith(IDLE_TIMEOUT_HINT));
    assert.match(IDLE_TIMEOUT_HINT, /omit or increase timeoutMs\. Use background:true separately/);
    const receipt = jobs.submit(ctx, 'bash', 'hint', undefined, async () => { throw new Error('partial output\n' + idleTimeoutMessage('5')); });
    await flush();
    const result = jobs.status(ctx, receipt.jobId);
    assert.equal(result.status, 'timed_out');
    assert.match(result.error, /expected to remain quiet/);
  } finally { await jobs.shutdown(); }
});

test('compactJob drops defaults and duplicates but keeps next-step data', async () => {
  const { jobs, ctx } = host();
  try {
    const receipt = jobs.submit(ctx, 'bash', 'c', undefined, async () => success('hello'), 'echo hello');
    await flush();
    const done = compactJob(jobs.status(ctx, receipt.jobId), { output: true });
    assert.deepEqual(Object.keys(done).sort(), ['elapsedMs', 'exitCode', 'jobId', 'output', 'status']);
    assert.ok(!('output' in compactJob(jobs.status(ctx, receipt.jobId))));
    const running = compactJob({ jobId: 'j', status: 'cancelling', elapsedMs: 1, cancelRequested: true, outputTruncated: false, liveLogPath: '/l', logPath: '/l', outputTail: '' }, { output: true });
    assert.deepEqual(running, { jobId: 'j', status: 'cancelling', elapsedMs: 1, cancelRequested: true, log: '/l' });
    const truncated = compactJob({ jobId: 'j', status: 'completed', elapsedMs: 1, cancelRequested: false, outputTruncated: true, liveLogPath: '/l', output: 'x' }, { output: true });
    assert.deepEqual(truncated, { jobId: 'j', status: 'completed', elapsedMs: 1, outputTruncated: true, log: '/l', output: 'x' });
  } finally { await jobs.shutdown(); }
});

test('stale job directory sweep removes only dead-owner or long-untouched unmarked directories', async () => {
  const { sweepStaleJobDirectories } = await import('../src/background-jobs.ts');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-root-'));
  try {
    const make = (name, marker, ageMs) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'output.log'), 'x');
      if (marker !== undefined) fs.writeFileSync(path.join(dir, 'owner.pid'), String(marker));
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(path.join(dir, 'output.log'), when, when);
      fs.utimesSync(dir, when, when);
      return dir;
    };
    const day = 24 * 60 * 60 * 1000;
    const dead = make('pi-shell-job-dead111', 111111, 0);
    const alive = make('pi-shell-job-live222', 222222, 5 * day);
    const own = make('pi-shell-job-self333', process.pid, 5 * day);
    const oldUnmarked = make('pi-shell-job-old4444', undefined, 2 * day);
    const freshUnmarked = make('pi-shell-job-new5555', undefined, 1000);
    const skipped = make('pi-shell-job-skip666', 111111, 0);
    const unrelated = make('other-dir-777', 111111, 5 * day);
    const removed = sweepStaleJobDirectories(root, { alive: pid => pid === 222222, skip: new Set([skipped]) });
    assert.deepEqual(removed.sort(), [dead, oldUnmarked].sort());
    for (const kept of [alive, own, freshUnmarked, skipped, unrelated]) assert.ok(fs.existsSync(kept), kept);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
