import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorRuntime, LIMITS, type SourceSink, type Clock } from '../src/core.ts';
import { LineParser } from '../src/lines.ts';
import { validateStart } from '../src/schema.ts';

class FakeClock implements Clock {
  time = 0; id = 0; tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.time) { this.tasks.delete(id); task.fn(); } }
}
const turn = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture(send?: (message: any, options: any) => void) {
  const clock = new FakeClock(), messages: any[] = [], options: any[] = [];
  const owner = { sessionId: 'session-A', cwd: '/canonical/workspace' };
  let current: typeof owner | undefined = owner, sink!: SourceSink, finish!: () => void, aborted = false;
  const runtime = new MonitorRuntime((m, o) => { send?.(m, o); messages.push(m); options.push(o); }, clock);
  runtime.bind(owner, () => current);
  const launch = async (s: SourceSink, signal: AbortSignal) => { sink = s; signal.addEventListener('abort', () => { aborted = true; }); s.started(); await new Promise<void>(r => { finish = r; }); s.closed({ sourceClosed: true, processTreeState: 'unknown' }); };
  const start = (overrides = {}) => runtime.start(validateStart({ source: { kind: 'command', tool: 'bash', command: 'fixture' }, ...overrides }), launch);
  return { runtime, clock, owner, messages, options, start, launch, sink: () => sink, finish: () => finish(), aborted: () => aborted, lose: () => { current = undefined; } };
}

test('strict schemas/default total TTL and source-specific options', () => {
  assert.equal(validateStart({ source: { kind: 'command', tool: 'bash', command: 'x' } }).durationMs, 300000);
  for (const durationMs of [999, 1800001, 1.5, NaN]) assert.throws(() => validateStart({ source: { kind: 'command', tool: 'bash', command: 'x' }, durationMs }));
  assert.throws(() => validateStart({ source: { kind: 'command', tool: 'bash', command: 'x', intervalMs: 30000 } }));
  assert.throws(() => validateStart({ source: { kind: 'shell_job', jobId: 'x', intervalMs: 29999 } }));
  assert.throws(() => validateStart({ source: { kind: 'websocket', url: 'wss://example.org', headers: {} } }));
  assert.throws(() => validateStart({ source: { kind: 'command', tool: 'bash', command: 'x' }, extra: true }));
});
test('receipt identity, ordering, busy latch and truthful no-ack submission', async () => {
  const f = fixture(); f.runtime.setBusy(true); const r = f.start(); await turn();
  assert.match(r.monitorId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  f.sink().data('first'); f.sink().data('second'); f.clock.advance(0); assert.equal(f.messages.length, 0);
  f.runtime.setBusy(false); f.clock.advance(0);
  assert.equal(f.messages[0].customType, 'monitor_event');
  assert.deepEqual(f.messages[0].details.events.filter((e: any) => e.category === 'data').map((e: any) => e.text), ['first', 'second']);
  assert.equal(f.runtime.status(r.monitorId).notification.state, 'submitted');
  assert.equal(f.runtime.status(r.monitorId).notification.hostAcknowledgment, 'unknown');
  assert.equal(f.options[0].triggerTurn, true); f.finish(); await turn(); await f.runtime.shutdown();
});
test('total TTL stops source, never implies close before actual barrier', async () => {
  const f = fixture(); const r = f.start({ durationMs: 1000 }); await turn(); f.clock.advance(1000);
  assert.equal(f.aborted(), true); assert.equal(f.runtime.status(r.monitorId).cleanupPending, true);
  assert.equal(f.runtime.status(r.monitorId).state, 'stopping');
  f.finish(); await turn(); assert.equal(f.runtime.status(r.monitorId).state, 'expired');
  assert.equal(f.runtime.status(r.monitorId).cleanupEvidence.processTreeState, 'unknown'); await f.runtime.shutdown();
});
test('idempotent stop and stopAfterEvents preserve cleanup evidence', async () => {
  const f = fixture(); const r = f.start({ stopAfterEvents: 2, wakeAgent: false }); await turn(); f.sink().data('a'); f.sink().data('b');
  assert.equal(f.aborted(), true); assert.equal(f.runtime.status(r.monitorId).counts.adopted, 2);
  f.runtime.stop(r.monitorId); f.runtime.stop(r.monitorId); f.finish(); await turn(); f.clock.advance(0);
  assert.equal(f.runtime.status(r.monitorId).state, 'limited'); assert.equal(f.options[0].triggerTurn, false); await f.runtime.shutdown();
});
test('rolling rate rejects 61st event, with one terminal rate event', async () => {
  const f = fixture(); const r = f.start(); await turn(); for (let i = 0; i < 61; i++) f.sink().data(String(i));
  assert.equal(f.runtime.status(r.monitorId).counts.adopted, 60); assert.equal(f.runtime.status(r.monitorId).stopReason, 'rate_limit');
  f.finish(); await turn(); f.clock.advance(0); f.clock.advance(30000); assert.equal(f.messages.flatMap(m => m.details.events).filter(e => e.kind === 'rate_limit').length, 1); await f.runtime.shutdown();
});
test('rolling window permits new data after 60 seconds and total stops at 600', async () => {
  const f = fixture(); const r = f.start({ durationMs: 1800000 }); await turn();
  for (let round = 0; round < 10; round++) { for (let i = 0; i < 60; i++) f.sink().data('x'); f.clock.advance(0); f.clock.advance(30000); f.clock.advance(30001); }
  assert.equal(f.runtime.status(r.monitorId).counts.adopted, 600); assert.equal(f.runtime.status(r.monitorId).stopReason, 'total_limit'); f.finish(); await turn(); await f.runtime.shutdown();
});
test('event bytes enforced before enqueue and pending data byte caps', async () => {
  const f = fixture(); const r = f.start(); await turn(); f.sink().data('💥'.repeat(4097));
  assert.equal(f.runtime.status(r.monitorId).stopReason, 'payload_limit'); assert.equal(f.runtime.status(r.monitorId).counts.adopted, 0); f.finish(); await turn(); await f.runtime.shutdown();
  const g = fixture(); g.runtime.setBusy(true); const b = g.start(); await turn(); for (let i = 0; i < 18; i++) g.sink().data('z'.repeat(16384));
  assert.equal(g.runtime.status(b.monitorId).stopReason, 'buffer_limit'); assert.ok(g.runtime.status(b.monitorId).bufferedBytes <= LIMITS.pendingBytes); g.finish(); await turn(); await g.runtime.shutdown();
});
test('foreign owner, disposed getter and generation suppression', async () => {
  const f = fixture(); const r = f.start(); await turn(); assert.throws(() => f.runtime.status(r.monitorId, { sessionId: 'B', cwd: f.owner.cwd }));
  assert.throws(() => f.runtime.stop(r.monitorId, { sessionId: 'A', cwd: '/foreign' }));
  f.lose(); f.sink().data('must not enqueue'); assert.equal(f.aborted(), true); f.finish(); await turn(); f.clock.advance(0); assert.equal(f.messages.length, 0);
  await f.runtime.shutdown(); f.runtime.bind({ sessionId: 'new', cwd: '/new' }, () => ({ sessionId: 'new', cwd: '/new' })); assert.throws(() => f.runtime.status(r.monitorId));
});
test('sync throw retains ordered batch, retries are bounded and never tight-loop', async () => {
  let attempts = 0; const f = fixture(() => { attempts++; throw new Error('host failed'); }); const r = f.start(); await turn(); f.sink().data('x');
  f.clock.advance(0); assert.equal(attempts, 1); f.clock.advance(0); assert.equal(attempts, 1);
  for (let i = 0; i < 5; i++) { f.runtime.setBusy(false); f.clock.advance(30000); }
  assert.equal(attempts, 3); assert.equal(f.runtime.status(r.monitorId).notification.state, 'submission_failed'); assert.ok(f.runtime.status(r.monitorId).buffered > 0); f.finish(); await turn(); await f.runtime.shutdown();
});
test('stderr is bounded diagnostic data and does not become events', async () => {
  const f = fixture(); const r = f.start(); await turn(); f.sink().stderr(Buffer.alloc(20000, 0xff));
  assert.equal(f.runtime.status(r.monitorId).counts.adopted, 0); assert.equal(f.runtime.status(r.monitorId).diagnostics.stderrInputBytes, 20000);
  assert.ok(Buffer.byteLength(f.runtime.status(r.monitorId).diagnostics.stderrTail) <= 8192); f.finish(); await turn(); await f.runtime.shutdown();
});
test('parser chunk UTF8 CRLF EOF/blank/invalid and pre-decode byte bound', () => {
  const events: any[] = [], faults: string[] = []; const p = new LineParser((text, partial) => events.push({ text, partial }), reason => faults.push(reason));
  const bytes = Buffer.from('hello\r\n\n繁體\nlast'); p.push(bytes.subarray(0, 11)); p.push(bytes.subarray(11)); p.end();
  assert.deepEqual(events.map(e => e.text), ['hello', '繁體', 'last']);
  const q = new LineParser((text, partial) => events.push({ text, partial }), reason => faults.push(reason)); q.push(Buffer.from([0xff, 10])); assert.equal(events.at(-1).partial, true);
  q.push(Buffer.alloc(16385, 65)); assert.deepEqual(faults, ['payload_limit']); assert.ok(q.bufferedBytes <= 16384);
});
