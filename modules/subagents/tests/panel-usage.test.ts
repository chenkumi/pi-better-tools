import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundJobs } from '../extensions/subagent/background.ts';
import { panelUsage } from '../../shell-tools/src/job-view.js';
const usage = (total: number) => ({ input: total - 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: 0.1 });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
test('job-level projection sums task invocation snapshots once, keeps query costs separate and private metadata out of receipts', async () => {
  const entered = deferred(), release = deferred(), done = deferred(); let update: any, finishTask: any;
  const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); });
  const receipt = jobs.submit('owner', '/cwd', jobs.epoch, ['scout', 'reviewer'], async (_signal, _ids, live, finish, attach, _interaction, progress) => {
    update = progress; finishTask = finish; live(0, 'first', '/first.partial'); live(1, 'second', '/second.partial');
    attach(0, { isRunning: true, snapshot: () => ({ queries: [{ queryId: 'query', status: 'completed', output: 'SECRET QUERY ANSWER', usage: usage(100) }], controls: [] }), close() {} } as any);
    entered.resolve(); await release.promise;
  }, ['Inspect UI', 'Review state']);
  try {
    assert.equal(jobs.panelJobs('owner', '/cwd').length, 1);
    await entered.promise;
    update(0, { activity: 'Tool running: read', usageReported: true, usage: usage(12) });
    update(0, { activity: 'Tool running: read', usageReported: true, usage: usage(12) });
    update(1, { activity: 'Generating reply', usageReported: true, usage: usage(30) });
    const job = jobs.panelJobs('owner', '/cwd')[0]; assert.equal(job.usage?.totalTokens, 42); assert.match(job.activity, /2 running/);
    assert.match(job.details.join('\n'), /Independent query.*Total 100/); assert.doesNotMatch(JSON.stringify(job), /SECRET QUERY ANSWER/);
    const state = jobs.get(receipt.jobId, 'owner', '/cwd'); assert.doesNotMatch(JSON.stringify(state), /widgetProgress|Inspect UI|Tool running/); assert.equal(state.tasks[0].result, undefined);
    job.usage!.totalTokens = 10000; assert.equal(jobs.panelJobs('owner', '/cwd')[0].usage!.totalTokens, 42);
    finishTask(0, { output: 'SECRET OUTPUT', usage: usage(20), logPath: '/first.jsonl', model: 'offline/model' }, 'completed');
    finishTask(1, { usage: usage(30) }, 'completed');
    const finalizing = jobs.panelJobs('owner', '/cwd')[0]; assert.equal(finalizing.state, 'finalizing'); assert.equal(finalizing.usage!.totalTokens, 50); assert.doesNotMatch(JSON.stringify(finalizing), /SECRET OUTPUT/);
    release.resolve(); await done.promise;
    const retained = jobs.panelJobs('owner', '/cwd')[0]; assert.equal(retained.active, false); assert.equal(retained.state, 'completed'); assert.equal(retained.usage!.totalTokens, 50);
    assert.deepEqual(jobs.panelJobs('foreign', '/cwd'), []); assert.deepEqual(jobs.panelJobs('owner', '/different'), []);
  } finally { release.resolve(); await jobs.shutdown(); }
});
test('empty unreported runner usage is pending then unknown, never fake zero; partial batch usage explicitly marked', async () => {
  const entered = deferred(), release = deferred(), done = deferred(); let update: any, finishTask: any;
  const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); });
  jobs.submit('owner', '/cwd', jobs.epoch, ['scout', 'reviewer'], async (_s, _ids, live, finish, _a, _i, progress) => { update = progress; finishTask = finish; live(0, 'first', '/first.partial'); entered.resolve(); await release.promise; });
  try {
    await entered.promise; update(0, { activity: 'Starting', usageReported: false });
    assert.equal(jobs.panelJobs('owner', '/cwd')[0].usageState, 'pending'); assert.equal(jobs.panelJobs('owner', '/cwd')[0].usage, undefined);
    finishTask(0, { usage: usage(0) }, 'failed'); finishTask(1, {}, 'skipped'); release.resolve(); await done.promise;
    assert.equal(jobs.panelJobs('owner', '/cwd')[0].usageState, 'unknown'); assert.equal(jobs.panelJobs('owner', '/cwd')[0].usage, undefined);
  } finally { release.resolve(); await jobs.shutdown(); }
  const nextEntered = deferred(), nextRelease = deferred(); let progress: any;
  const next = new BackgroundJobs(() => {});
  next.submit('owner', '/cwd', next.epoch, ['scout', 'reviewer'], async (_s, _ids, _l, _f, _a, _i, p) => { progress = p; nextEntered.resolve(); await nextRelease.promise; });
  try { await nextEntered.promise; progress(0, { activity: 'Generating reply', usageReported: true, usage: panelUsage(usage(12)) }); const job = next.panelJobs('owner', '/cwd')[0]; assert.equal(job.usage!.totalTokens, 12); assert.match(job.activity, /usage partial/); }
  finally { nextRelease.resolve(); await next.shutdown(); }
});
test('ready query model completion does not certify worker/lease settlement; independent usage and cleanup remain visible', async () => {
  const entered = deferred(), release = deferred(), done = deferred(); let notice: any, finishTask: any;
  const jobs = new BackgroundJobs(kind => { if (kind === 'query_result') done.resolve(); });
  jobs.submit('owner', '/cwd', jobs.epoch, ['scout'], async (_s, _ids, _live, finish, attach, interaction) => {
    notice = interaction; finishTask = finish;
    attach(0, { isRunning: false, snapshot: () => ({ queries: [], controls: [] }), close() {} } as any);
    entered.resolve(); await release.promise;
  }, ['Query snapshot'], undefined, 'Q1');
  try {
    await entered.promise;
    notice(0, { kind: 'query_result', queryId: 'Q1', status: 'completed', usage: usage(15), output: 'PRIVATE ANSWER' });
    const job = jobs.panelJobs('owner', '/cwd')[0]; assert.equal(job.active, true); assert.equal(job.state, 'finalizing'); assert.equal(job.usage!.totalTokens, 15); assert.doesNotMatch(JSON.stringify(job), /PRIVATE ANSWER/);
    finishTask(0, { usage: usage(15) }, 'completed'); release.resolve(); await done.promise;
    assert.equal(jobs.panelJobs('owner', '/cwd')[0].usage!.totalTokens, 15, 'not summed again from task and query receipt');
  } finally { release.resolve(); await jobs.shutdown(); }
});
test('late progress after settlement, shutdown or replacement cannot mutate retained/new jobs or redraw them', async () => {
  const entered = deferred(), release = deferred(), done = deferred(); let update: any; let changes = 0;
  const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); }, undefined, () => changes++);
  jobs.submit('owner', '/cwd', jobs.epoch, ['scout'], async (_s, _ids, _l, finish, _a, _i, p) => { update = p; entered.resolve(); await release.promise; finish(0, { usage: usage(12) }, 'completed'); });
  await entered.promise; release.resolve(); await done.promise;
  const count = changes; update(0, { activity: 'OLD', usageReported: true, usage: usage(999) }); assert.equal(changes, count); assert.equal(jobs.panelJobs('owner', '/cwd')[0].usage!.totalTokens, 12);
  await jobs.shutdown(); jobs.start(); const nextEntered = deferred(), nextRelease = deferred();
  jobs.submit('owner', '/cwd', jobs.epoch, ['reviewer'], async () => { nextEntered.resolve(); await nextRelease.promise; });
  try { await nextEntered.promise; const before = changes; update(0, { activity: 'OLD', usageReported: true, usage: usage(999) }); assert.equal(changes, before); assert.doesNotMatch(JSON.stringify(jobs.panelJobs('owner', '/cwd')), /OLD|999/); }
  finally { nextRelease.resolve(); await jobs.shutdown(); }
});
test('R2: final positive usage outranks an earlier unreported snapshot; actual reported zero remains distinguishable from initialization', async () => {
  for (const reported of [false, true]) {
    const done = deferred(); const jobs = new BackgroundJobs(kind => { if (kind === 'task_result') done.resolve(); });
    jobs.submit('owner', '/cwd', jobs.epoch, ['scout'], async (_s, _ids, _l, finish, _a, _i, progress) => {
      progress(0, { activity: 'Starting', usageReported: reported, ...(reported ? { usage: panelUsage(usage(0)) } : {}) });
      finish(0, { usage: usage(reported ? 0 : 12) }, 'failed');
    });
    try { await done.promise; const job = jobs.panelJobs('owner', '/cwd')[0]; assert.equal(job.usageState, 'reported'); assert.equal(job.usage?.totalTokens, reported ? 0 : 12); }
    finally { await jobs.shutdown(); }
  }
});
test('R3: ready-query worker fault outranks raw completed RPC snapshot and active success still marks lease cleanup pending', async () => {
  for (const failed of [false, true]) {
    const entered = deferred(), release = deferred(); let interaction: any;
    const jobs = new BackgroundJobs(() => {});
    const receipt = jobs.submit('owner', '/cwd', jobs.epoch, ['scout'], async (_s, _ids, _l, _f, attach, notice) => {
      interaction = notice;
      attach(0, { isRunning: false, snapshot: () => ({ queries: [{ queryId: 'Q1', status: 'completed', usage: usage(15), output: 'PRIVATE QUERY' }], controls: [] }), close() {} } as any);
      entered.resolve(); await release.promise;
    }, ['Query'], undefined, 'Q1');
    try {
      await entered.promise;
      if (failed) interaction(0, { kind: 'query_result', queryId: 'Q1', status: 'failed', usage: usage(15), error: 'worker protocol failure', cleanupPending: true });
      const authoritative = jobs.get(receipt.jobId, 'owner', '/cwd').tasks[0].queries![0];
      const job = jobs.panelJobs('owner', '/cwd')[0], details = job.details.join('\n');
      assert.match(details, new RegExp(`Independent query Q1 · ${authoritative.status} · cleanup pending`));
      assert.doesNotMatch(details, /Independent query Q1 · completed|PRIVATE QUERY/); assert.equal(job.usage!.totalTokens, 15);
    } finally { release.resolve(); await jobs.shutdown(); }
  }
});
