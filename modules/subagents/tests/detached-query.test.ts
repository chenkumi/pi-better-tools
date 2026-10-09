import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';
import { BackgroundJobs } from '../extensions/subagent/background.ts';
import { RpcInteraction } from '../extensions/subagent/rpc.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
for (const evidence of ['close', 'terminal'] as const) test(`late ${evidence} reconciles detached cleanup, usage and capacity without reviving answers`, async () => {
  const children = Array.from({ length: 2 }, () => Object.assign(new EventEmitter(), { connected: true, stdin: new Writable({ write(_b, _e, cb) { cb(); } }), send(_message: any, cb?: (error?: Error) => void) { cb?.(); } }));
  const ready = deferred(), hold = deferred(), finished = deferred();
  const notices: any[] = [];
  const jobs = new BackgroundJobs((kind, receipt, interaction) => { if (kind === 'query_result') notices.push({ receipt, interaction }); }); jobs.start();
  let abandoned!: RpcInteraction, sibling!: RpcInteraction;
  const receipt = jobs.submit('owner', 'cwd', jobs.epoch, ['abandoned', 'healthy'], async (_signal, _ids, live, finish, attach, interaction) => {
    abandoned = new RpcInteraction(children[0] as any, 'token', 'offline/model', n => interaction(0, n));
    sibling = new RpcInteraction(children[1] as any, 'token', 'offline/model', n => interaction(1, n));
    for (const [index, handle] of [abandoned, sibling].entries()) { handle.start(); live(index, `session${index}`, `log${index}.partial`); attach(index, handle); }
    abandoned.query('first'); abandoned.query('second'); abandoned.close(true);
    finish(0, { usage: { totalTokens: 1 }, error: 'runner abandoned' }, 'failed'); ready.resolve();
    await hold.promise;
    sibling.close(true); finish(1, {}, 'completed'); finished.resolve();
  });
  try {
    await ready.promise;
    const before = jobs.get(receipt.jobId, 'owner', 'cwd').tasks[0].queries!;
    assert.ok(before.every(q => q.cleanupPending));
    assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[1].taskId, 'query', 'blocked', 'owner', 'cwd'), /QUERY_CAPACITY/);
    if (evidence === 'close') children[0].emit('close');
    else for (const query of before) children[0].emit('message', { channel: 'pi-subagent-query', token: 'token', type: 'query_result', queryId: query.queryId, status: 'completed', provider: 'offline', model: 'model', output: 'must not revive', usage: { totalTokens: 7 } });
    const saved = jobs.get(receipt.jobId, 'owner', 'cwd').tasks[0];
    assert.equal(saved.status, 'failed'); assert.ok(saved.queries!.every(q => q.cleanupPending === false && q.status === 'aborted' && q.output === undefined));
    assert.equal((saved.result as any).usage.totalTokens, 1);
    if (evidence === 'terminal') assert.ok(saved.queries!.every(q => (q.usage as any).totalTokens === 7 && q.lateUsage === true));
    const count = notices.length;
    children[0].emit('close');
    assert.equal(notices.length, count, 'duplicate terminal evidence must not duplicate usage notifications');
    assert.equal(jobs.message(receipt.jobId, receipt.tasks[1].taskId, 'query', 'healthy1', 'owner', 'cwd').status, 'accepted');
    assert.equal(jobs.message(receipt.jobId, receipt.tasks[1].taskId, 'query', 'healthy2', 'owner', 'cwd').status, 'accepted');
    assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[1].taskId, 'query', 'healthy3', 'owner', 'cwd'), /QUERY_CAPACITY/);
  } finally { hold.resolve(); await finished.promise; children.forEach(proc => { proc.emit('close'); proc.stdin.destroy(); }); await jobs.shutdown(); }
});
