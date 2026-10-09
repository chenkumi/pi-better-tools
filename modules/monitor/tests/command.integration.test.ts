import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorRuntime, type Clock } from '../src/core.ts';
import { commandLaunch } from '../src/sources.ts';
import { validateStart } from '../src/schema.ts';
class ClockFixture implements Clock {
  time = 0; next = 0; tasks = new Map<number, { at: number; fn: () => void }>(); now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.time) { this.tasks.delete(id); task.fn(); } }
}
const owner = { sessionId: 'command-integration', cwd: process.cwd() };
const pi = { getSettings: () => ({}) } as any;
const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => owner.sessionId, getSessionFile: () => undefined } } as any;
for (const mode of ['expiry', 'stop', 'event-limit'] as const) test(`actual command ${mode} requests cancellation then confirms actual close only`, async () => {
  const clock = new ClockFixture(), runtime = new MonitorRuntime(() => {}, clock); runtime.bind(owner, () => owner);
  let started!: () => void; const startBarrier = new Promise<void>(r => { started = r; });
  const input = validateStart({ source: { kind: 'command', tool: 'bash', command: `node -e "require('http').createServer().listen(0);console.log('ready')"` }, durationMs: 1000, ...(mode === 'event-limit' ? { stopAfterEvents: 1 } : {}) });
  const launch = commandLaunch(pi, ctx, input.source as any);
  const receipt = runtime.start(input, (sink, signal, deadline) => launch({ ...sink, started: () => { sink.started(); started(); } }, signal, deadline));
  try {
    await startBarrier;
    if (mode === 'expiry') clock.advance(1000); else if (mode === 'stop') { assert.equal(runtime.stop(receipt.monitorId).cleanupPending, true); runtime.stop(receipt.monitorId); }
    await runtime.settled(receipt.monitorId);
    const status = runtime.status(receipt.monitorId); assert.equal(status.cleanupPending, false); assert.equal(status.cleanupEvidence.sourceClosed, true); assert.equal(status.cleanupEvidence.processTreeState, 'unknown');
    assert.equal(status.state, mode === 'expiry' ? 'expired' : mode === 'stop' ? 'stopped' : 'limited');
    if (mode === 'event-limit') assert.equal(status.counts.adopted, 1);
  } finally { await runtime.shutdown(); }
});
