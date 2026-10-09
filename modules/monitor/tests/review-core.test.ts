import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorRuntime, LIMITS, type Clock, type SourceSink } from '../src/core.ts';
import { validateStart } from '../src/schema.ts';

class FakeClock implements Clock {
  time = 0; id = 0; tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.time) { this.tasks.delete(id); task.fn(); } }
}
const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const input = (extra = {}) => validateStart({ source: { kind: 'command', tool: 'bash', command: 'offline-fixture' }, durationMs: 1800000, wakeAgent: false, ...extra });
function fixture(callback?: (message: any, options: any) => void) {
  const clock = new FakeClock(), messages: any[] = [], options: any[] = [], times: number[] = [];
  const owner = { sessionId: 'review-core', cwd: '/canonical/offline' };
  const runtime = new MonitorRuntime((m, o) => { callback?.(m, o); messages.push(m); options.push(o); times.push(clock.now()); }, clock);
  runtime.bind(owner, () => owner);
  function start(extra = {}, signal?: AbortSignal, started = true) {
    let sink!: SourceSink, release!: () => void, sourceSignal!: AbortSignal;
    const receipt = runtime.start(input(extra), async (s, sig) => { sink = s; sourceSignal = sig; if (started) s.started(); await new Promise<void>(r => { release = r; }); s.closed({ sourceClosed: true, exitCode: 9, processTreeState: 'unknown' }); }, signal);
    return { id: receipt.monitorId, sink: () => sink, finish: () => release(), signal: () => sourceSignal };
  }
  return { clock, runtime, messages, options, times, owner, start };
}
for (const reason of ['stop_requested', 'duration_exceeded', 'source_fault']) test(`review W1: ${reason} submitted before deferred close has distinct terminal evidence`, async () => {
  const f = fixture(), row = f.start(reason === 'duration_exceeded' ? { durationMs: 100000 } : {}); await turn();
  row.sink().data('never-replay'); f.clock.advance(0); assert.equal(f.messages.length, 1);
  f.clock.advance(reason === 'duration_exceeded' ? 100000 : 30000);
  if (reason === 'stop_requested') f.runtime.stop(row.id);
  if (reason === 'source_fault') row.sink().fault(reason);
  f.clock.advance(0);
  const requested = f.messages.at(-1).details.monitors.find((m: any) => m.monitorId === row.id);
  assert.equal(requested.state, 'stopping'); assert.equal(requested.cleanupPending, true); assert.equal(requested.cleanupEvidence.sourceClosed, false);
  const submitted = f.messages.length; row.finish(); await f.runtime.settled(row.id); f.clock.advance(30000);
  assert.equal(f.messages.length, submitted + 1, 'actual close requires a NEW terminal batch');
  const terminal = f.messages.at(-1).details.monitors[0];
  assert.notEqual(terminal.state, 'stopping'); assert.equal(terminal.cleanupPending, false); assert.equal(terminal.cleanupEvidence.sourceClosed, true); assert.equal(terminal.cleanupEvidence.exitCode, 9); assert.equal(terminal.cleanupEvidence.processTreeState, 'unknown');
  const events = f.messages.flatMap(m => m.details.events);
  assert.equal(events.filter(e => e.kind === reason).length, 1); assert.equal(events.filter(e => e.kind === 'source_closed').length, 1); assert.equal(events.filter(e => e.text === 'never-replay').length, 1);
  await f.runtime.shutdown();
});
test('review W2: four busy backlogs have first-batch representation/terminal metadata, round-robin order and bounded batches', async () => {
  const f = fixture(); f.runtime.setBusy(true); const rows = Array.from({ length: 4 }, () => f.start()); await turn();
  for (const row of rows.slice(0, 3)) for (let i = 0; i < 60; i++) row.sink().data(`${row.id}:${i}`);
  rows[3].finish(); await f.runtime.settled(rows[3].id); f.runtime.setBusy(false); f.clock.advance(0);
  assert.deepEqual(new Set(f.messages[0].details.monitors.map((m: any) => m.monitorId)), new Set(rows.map(r => r.id)));
  const terminal = f.messages[0].details.monitors.find((m: any) => m.monitorId === rows[3].id); assert.equal(terminal.state, 'completed'); assert.equal(terminal.cleanupEvidence.sourceClosed, true);
  assert.ok(f.messages[0].details.events.some((e: any) => e.monitorId === rows[3].id && e.kind === 'source_closed'));
  for (let batch = 0; batch < 8; batch++) f.clock.advance(30000);
  for (const m of f.messages) { assert.ok(m.details.events.length <= 32); assert.ok(Buffer.byteLength(JSON.stringify(m.details)) <= 32768); }
  for (let i = 1; i < f.times.length; i++) assert.ok(f.times[i] - f.times[i - 1] >= 30000);
  for (const row of rows.slice(0, 3)) {
    const events = f.messages.flatMap(m => m.details.events).filter(e => e.monitorId === row.id);
    assert.deepEqual(events.filter(e => e.category === 'data').map(e => e.text), Array.from({ length: 60 }, (_, i) => `${row.id}:${i}`));
    assert.deepEqual(events.map(e => e.sequence), [...events.map(e => e.sequence)].sort((a, b) => a - b)); assert.equal(new Set(events.map(e => e.eventId)).size, events.length);
    row.finish(); await f.runtime.settled(row.id);
  }
  await f.runtime.shutdown();
});
test('review S1: exact 4 active, 32 pending retained, and terminal eviction only after submitted', async () => {
  const f = fixture(); f.runtime.setBusy(true); const active = Array.from({ length: 4 }, () => f.start()); await turn(); assert.throws(() => f.start(), /active capacity/);
  for (const row of active) { row.finish(); await f.runtime.settled(row.id); }
  const ids = active.map(r => r.id);
  for (let i = 4; i < 32; i++) { const row = f.start(); ids.push(row.id); await turn(); row.finish(); await f.runtime.settled(row.id); }
  assert.equal(f.runtime.list().length, 32); assert.throws(() => f.start(), /receipt capacity/);
  f.runtime.setBusy(false); f.clock.advance(0); assert.throws(() => f.start(), /receipt capacity/, 'first fair round retains every terminal tail'); f.clock.advance(30000); const next = f.start(); await turn(); assert.equal(f.runtime.list().length, 32); assert.throws(() => f.runtime.status(ids[0]), /Unknown/); next.finish(); await f.runtime.settled(next.id); await f.runtime.shutdown();
});
test('review S1: aggregate owner exactly 512KiB independent of 256KiB per monitor', async () => {
  const f = fixture(); f.runtime.setBusy(true); const rows = Array.from({ length: 3 }, () => f.start()); await turn();
  for (const row of rows.slice(0, 2)) for (let i = 0; i < 16; i++) row.sink().data('x'.repeat(16384));
  assert.equal(f.runtime.list().reduce((n, r) => n + r.bufferedBytes, 0), LIMITS.ownerPendingBytes);
  rows[2].sink().data('x'); assert.equal(f.runtime.status(rows[2].id).stopReason, 'buffer_limit'); assert.equal(f.runtime.status(rows[2].id).counts.adopted, 0);
  for (const row of rows) { row.finish(); await f.runtime.settled(row.id); } await f.runtime.shutdown();
});
test('review S1: abort before acceptance does not launch, accepted turn abort detaches, and held startup retains cleanup fence', async () => {
  const f = fixture(), pre = new AbortController(); pre.abort(); let launched = false;
  assert.throws(() => f.runtime.start(input(), async () => { launched = true; }, pre.signal), /before acceptance/); await turn(); assert.equal(launched, false);
  const tool = new AbortController(), row = f.start({ durationMs: 1000 }, tool.signal, false); tool.abort(); await turn(); assert.equal(row.signal().aborted, false);
  f.clock.advance(1000); assert.equal(row.signal().aborted, true); assert.equal(f.runtime.status(row.id).state, 'stopping'); assert.equal(f.runtime.status(row.id).cleanupPending, true); assert.equal(f.runtime.status(row.id).cleanupEvidence.sourceClosed, false);
  const shutdown = f.runtime.shutdown(); f.clock.advance(2000); await shutdown; assert.throws(() => f.runtime.bind(f.owner, () => f.owner), /cleanup/);
  const count = f.messages.length; row.finish(); await f.runtime.settled(row.id); f.clock.advance(30000); assert.equal(f.messages.length, count, 'old owner suppressed'); f.runtime.bind(f.owner, () => f.owner); assert.deepEqual(f.runtime.list(), []); await f.runtime.shutdown();
});
test('review S1: synchronous send reentry never replays data and later close remains deliverable', async () => {
  let f!: ReturnType<typeof fixture>, id = '', reentered = false;
  f = fixture(() => { if (!reentered) { reentered = true; f.runtime.stop(id); f.runtime.setBusy(true); f.runtime.opportunity(); } });
  const row = f.start(); id = row.id; await turn(); row.sink().data('one'); f.clock.advance(0); assert.equal(f.messages.length, 1);
  f.clock.advance(30000); assert.equal(f.messages.length, 1); row.finish(); await f.runtime.settled(id); f.runtime.setBusy(false); f.clock.advance(0);
  assert.equal(f.messages.flatMap(m => m.details.events).filter(e => e.text === 'one').length, 1); assert.ok(f.messages.at(-1).details.events.some((e: any) => e.kind === 'source_closed')); await f.runtime.shutdown();
});
test('review S1: mixed wake is OR of selected monitors, not any retained true monitor', async () => {
  const f = fixture(); f.runtime.setBusy(true); const yes = f.start({ wakeAgent: true }), no = f.start(); await turn(); yes.sink().data('yes'); no.sink().data('no'); f.runtime.setBusy(false); f.clock.advance(0); assert.equal(f.options[0].triggerTurn, true);
  no.sink().data('no-again'); f.clock.advance(30000); assert.equal(f.options[1].triggerTurn, false); yes.finish(); no.finish(); await Promise.all([f.runtime.settled(yes.id), f.runtime.settled(no.id)]); await f.runtime.shutdown();
});
test('review W2: byte-blocked large head gets next-batch priority despite early source refills and small peers', async () => {
  const f = fixture(); f.runtime.setBusy(true); const rows = Array.from({ length: 4 }, (_, i) => f.start({ source: { kind: 'shell_job', jobId: `offline-${i}` } })); await turn();
  rows[0].sink().data(undefined, false, { marker: 'A', body: 'a'.repeat(16000) }); rows[1].sink().data(undefined, false, { marker: 'B', body: 'b'.repeat(16000) });
  for (const row of rows.slice(2)) row.sink().data(undefined, false, { marker: 'small' });
  f.runtime.setBusy(false); f.clock.advance(0); assert.ok(!f.messages[0].details.events.some((e: any) => e.snapshot?.marker === 'B'));
  // Keep A plus the late small sources eligible; they must not reset priority to A.
  rows[0].sink().data(undefined, false, { marker: 'A2', body: 'a'.repeat(16000) }); for (const row of rows.slice(2)) row.sink().data(undefined, false, { marker: 'small-again' });
  f.clock.advance(30000); assert.ok(f.messages[1].details.events.some((e: any) => e.snapshot?.marker === 'B'), 'blocked B must be served before refill A');
  for (const m of f.messages) assert.ok(Buffer.byteLength(JSON.stringify(m.details)) <= LIMITS.batchBytes);
  for (const row of rows) { row.finish(); await f.runtime.settled(row.id); } await f.runtime.shutdown();
});

const jobInput = { source: { kind: 'shell_job', jobId: 'offline-reentry' } };
const snap = (revision: number) => ({ revision, status: 'running' });
const snapBytes = (revision: number) => Buffer.byteLength(JSON.stringify(snap(revision)));
test('reentry R1: selected snapshots stay owner-byte charged; over-cap replacement is rejected, not omitted', async () => {
  let row!: ReturnType<ReturnType<typeof fixture>['start']>, entered = false; const large = { revision: 1, body: 'x'.repeat(16000) };
  const f = fixture(() => { if (!entered) { entered = true; row.sink().data(undefined, false, { ...large, revision: 2 }); } }); f.runtime.setBusy(true);
  row = f.start(jobInput); const a = f.start(), b = f.start(); await turn(); for (let i = 0; i < 16; i++) a.sink().data('x'.repeat(16384)); for (let i = 0; i < 15; i++) b.sink().data('x'.repeat(16384)); row.sink().data(undefined, false, large);
  assert.equal(f.runtime.list().reduce((n, r) => n + r.bufferedBytes, 0), 31 * 16384 + Buffer.byteLength(JSON.stringify(large))); f.runtime.setBusy(false); f.clock.advance(0);
  const r = f.runtime.status(row.id); assert.equal(r.stopReason, 'buffer_limit'); assert.equal(r.counts.adopted, 1); assert.equal(r.counts.rejected, 1); assert.equal(r.counts.submitted, 1); assert.equal(r.counts.omitted, 0); assert.equal(r.buffered, 0); assert.equal(r.bufferedBytes, 0); assert.ok(f.runtime.list().reduce((n, x) => n + x.bufferedBytes, 0) <= LIMITS.ownerPendingBytes);
  assert.deepEqual(f.messages[0].details.events.filter((e: any) => e.monitorId === row.id && e.category === 'data').map((e: any) => e.snapshot.revision), [1]); for (const source of [row, a, b]) { source.finish(); await f.runtime.settled(source.id); } await f.runtime.shutdown();
});
test('reentry R1: successful S1 submission survives synchronous S2 adoption with exact bytes/counts/identities', async () => {
  let row!: ReturnType<ReturnType<typeof fixture>['start']>, entered = false, observedBytes = 0;
  const f = fixture(() => { if (!entered) { entered = true; row.sink().data(undefined, false, snap(2)); observedBytes = f.runtime.status(row.id).bufferedBytes; } });
  row = f.start(jobInput); await turn(); row.sink().data(undefined, false, snap(1)); f.clock.advance(0);
  assert.deepEqual(f.messages[0].details.events.filter((e: any) => e.category === 'data').map((e: any) => e.snapshot.revision), [1]);
  let r = f.runtime.status(row.id); assert.equal(r.counts.submitted, 1); assert.equal(r.counts.omitted, 0); assert.equal(observedBytes, snapBytes(1) + snapBytes(2)); assert.equal(r.buffered, 1); assert.equal(r.bufferedBytes, snapBytes(2)); assert.equal(r.notification.hostAcknowledgment, 'unknown');
  f.clock.advance(29999); assert.equal(f.messages.length, 1); f.clock.advance(1); r = f.runtime.status(row.id); assert.equal(r.counts.submitted, 2); assert.equal(r.counts.omitted, 0); assert.equal(r.buffered, 0); assert.equal(r.bufferedBytes, 0);
  const events = f.messages.flatMap(m => m.details.events).filter(e => e.category === 'data'); assert.deepEqual(events.map(e => e.snapshot.revision), [1, 2]); assert.deepEqual(events.map(e => e.sequence), [2, 3]); assert.equal(new Set(events.map(e => e.eventId)).size, 2);
  f.runtime.opportunity(); f.clock.advance(30000); assert.equal(f.messages.length, 2); row.finish(); await f.runtime.settled(row.id); await f.runtime.shutdown();
});
test('reentry R1: throw retains selected S1 retry identity; fresh S3 coalesces only unreserved S2', async () => {
  let row!: ReturnType<ReturnType<typeof fixture>['start']>, entered = false; const attempts: any[] = [];
  const f = fixture(m => { attempts.push(m); if (!entered) { entered = true; row.sink().data(undefined, false, snap(2)); throw new Error('offline sync rejection'); } });
  row = f.start(jobInput); await turn(); row.sink().data(undefined, false, snap(1)); f.clock.advance(0); let r = f.runtime.status(row.id);
  assert.equal(f.messages.length, 0); assert.equal(r.counts.submitted, 0); assert.equal(r.counts.omitted, 0); assert.equal(r.buffered, 2); assert.equal(r.bufferedBytes, snapBytes(1) + snapBytes(2));
  f.runtime.setBusy(true); row.sink().data(undefined, false, snap(3)); r = f.runtime.status(row.id); assert.equal(r.counts.omitted, 1); assert.equal(r.bufferedBytes, snapBytes(1) + snapBytes(3));
  f.runtime.setBusy(false); f.clock.advance(0); const data = f.messages[0].details.events.filter((e: any) => e.category === 'data'); assert.deepEqual(data.map((e: any) => e.snapshot.revision), [1, 3]); assert.equal(data[0].eventId, attempts[0].details.events.find((e: any) => e.category === 'data').eventId);
  r = f.runtime.status(row.id); assert.equal(r.counts.submitted, 2); assert.equal(r.counts.omitted, 1); assert.equal(r.buffered, 0); assert.equal(r.bufferedBytes, 0); assert.equal(r.notification.hostAcknowledgment, 'unknown'); f.runtime.opportunity(); f.clock.advance(30000); assert.equal(f.messages.length, 1); row.finish(); await f.runtime.settled(row.id); await f.runtime.shutdown();
});
for (const fence of ['busy', 'owner', 'shutdown'] as const) test(`reentry R1: successful snapshot transaction retains ${fence} fence/no replay`, async () => {
  let row!: ReturnType<ReturnType<typeof fixture>['start']>, entered = false, shutdown: Promise<void> | undefined;
  const f = fixture(() => { if (!entered) { entered = true; row.sink().data(undefined, false, snap(2)); if (fence === 'busy') f.runtime.setBusy(true); else if (fence === 'owner') f.owner.sessionId = 'replacement'; else shutdown = f.runtime.shutdown(); } });
  row = f.start(jobInput); await turn(); row.sink().data(undefined, false, snap(1)); f.clock.advance(0); assert.equal(f.messages.length, 1); f.clock.advance(30000); assert.equal(f.messages.length, 1);
  if (fence === 'busy') { assert.equal(f.runtime.status(row.id).counts.submitted, 1); f.runtime.setBusy(false); f.clock.advance(0); assert.deepEqual(f.messages[1].details.events.filter((e: any) => e.category === 'data').map((e: any) => e.snapshot.revision), [2]); }
  else { row.sink().data(undefined, false, snap(3)); assert.throws(() => f.runtime.status(row.id), /disposed/); f.runtime.opportunity(); f.clock.advance(30000); assert.equal(f.messages.length, 1); }
  row.finish(); await f.runtime.settled(row.id); if (shutdown) await shutdown; await f.runtime.shutdown(); if (fence !== 'busy') { f.runtime.bind(f.owner, () => f.owner); f.clock.advance(0); assert.deepEqual(f.runtime.list(), []); assert.equal(f.messages.length, 1); await f.runtime.shutdown(); }
});
test('reentry P3:32 large fixed competitors within32 successful capped batches; throw does not advance cursor', async () => {
  const attempts: any[] = []; let rejected = false; const f = fixture(m => { attempts.push(m); if (!rejected) { rejected = true; throw new Error('offline first rejection'); } }); f.runtime.setBusy(true);
  const rows: ReturnType<typeof f.start>[] = []; for (let i = 0; i < 32; i++) { const row = f.start({ source: { kind: 'shell_job', jobId: `fixed-${i}` } }, undefined, false); rows.push(row); await turn(); row.sink().data(undefined, false, { marker: i, body: 'x'.repeat(16000) }); row.finish(); await f.runtime.settled(row.id); }
  f.runtime.setBusy(false); f.clock.advance(0); assert.equal(f.messages.length, 0); f.runtime.opportunity(); f.clock.advance(0); assert.equal(attempts[1].details.events[0].eventId, attempts[0].details.events[0].eventId);
  const represented = new Set<string>(); for (let batch = 0; batch < 32; batch++) { if (batch) f.clock.advance(30000); for (const m of f.messages.at(-1).details.monitors) represented.add(m.monitorId); }
  assert.deepEqual(represented, new Set(rows.map(r => r.id))); assert.ok(f.messages.length <= 32); for (const m of f.messages) { assert.ok(m.details.events.length <= LIMITS.batchEvents); assert.ok(Buffer.byteLength(JSON.stringify(m.details)) <= LIMITS.batchBytes); }
  const events = f.messages.flatMap(m => m.details.events); assert.equal(new Set(events.map(e => e.eventId)).size, events.length); for (const row of rows) { const seq = events.filter(e => e.monitorId === row.id).map(e => e.sequence); assert.deepEqual(seq, [...seq].sort((a, b) => a - b)); } for (let i = 1; i < f.times.length; i++) assert.ok(f.times[i] - f.times[i - 1] >= LIMITS.progressMs); await f.runtime.shutdown();
});
test('reentry P3:unknown settlement emits terminal/reason once, no source_closed or submitted-data replay', async () => {
  const f = fixture(); let release!: () => void; const receipt = f.runtime.start(input(), async sink => { sink.started(); sink.data('unknown-once'); await new Promise<void>(r => { release = r; }); }); await turn(); f.clock.advance(0); f.runtime.stop(receipt.monitorId); f.clock.advance(30000); release(); await f.runtime.settled(receipt.monitorId); f.clock.advance(30000);
  const r = f.runtime.status(receipt.monitorId); assert.equal(r.cleanupPending, true); assert.equal(r.cleanupEvidence.sourceClosed, false); const events = f.messages.flatMap(m => m.details.events); assert.equal(events.filter(e => e.kind === 'stop_requested').length, 1); assert.equal(events.filter(e => e.kind === 'terminal').length, 1); assert.equal(events.filter(e => e.kind === 'source_closed').length, 0); assert.equal(events.filter(e => e.text === 'unknown-once').length, 1); assert.equal(r.notification.hostAcknowledgment, 'unknown'); f.runtime.opportunity(); f.clock.advance(30000); assert.equal(f.messages.length, 3); await f.runtime.shutdown();
});
