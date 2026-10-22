import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileLaunch, jobLaunch, resolveFilePath } from '../src/sources.ts';
import type { Clock, SourceSink } from '../src/core.ts';
import type { ReadonlyJobLease } from '../../shell-tools/src/monitor-capability.ts';

function manual() {
  const tasks = new Map<number, () => void>(); let next = 0;
  const clock: Clock = { now: () => 0, set: (fn) => { const id = ++next; tasks.set(id, fn); return id; }, clear: (id) => { tasks.delete(id as number); } };
  const fire = () => { const entry = [...tasks][0]; if (!entry) return false; tasks.delete(entry[0]); entry[1](); return true; };
  return { clock, fire, pending: () => tasks.size };
}
/** A sink whose hooks can be overridden, recording what the source reports. */
function sink(overrides: Partial<SourceSink> = {}) {
  const events: unknown[][] = [];
  const base: SourceSink = { started: () => events.push(['started']), data: (_t, _p, snapshot) => events.push(['data', snapshot]), stderr: () => {},
    fault: (kind) => events.push(['fault', kind]), closed: (evidence) => events.push(['closed', evidence]) };
  return { events, sink: { ...base, ...overrides } as SourceSink, closedCount: () => events.filter(e => e[0] === 'closed').length };
}
/** Signal whose listener registrations are observable. */
function trackedSignal() {
  const controller = new AbortController(), signal = controller.signal, listeners = new Set<unknown>();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: any, options?: any) => { listeners.add(fn); add(type, fn, options); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, fn: any, options?: any) => { listeners.delete(fn); remove(type, fn, options); }) as typeof signal.removeEventListener;
  return { controller, signal, listeners };
}
const lease = (snapshot: () => Record<string, unknown>) => ({ snapshot }) as unknown as ReadonlyJobLease;

test('a file source aborted by its own started() leaves no timer pending after it reports closed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-poll-')));
  try {
    writeFileSync(join(root, 'a.txt'), 'x');
    const m = manual(), { controller, signal } = trackedSignal();
    const s = sink({ started: () => controller.abort() });
    await fileLaunch(root, resolveFilePath(root, 'a.txt'), 1000, m.clock)(s.sink, signal, Infinity);
    assert.equal(s.closedCount(), 1);
    assert.equal(m.pending(), 0, 'timerCleared:true must mean no timer is left');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a job source whose started() throws faults, reports closed once and removes its abort listener', async () => {
  const m = manual(), { signal, listeners } = trackedSignal();
  const s = sink({ started: () => { throw new Error('sink finalized'); } });
  await jobLaunch(lease(() => ({ status: 'running' })), 'job', 30000, m.clock)(s.sink, signal, Infinity);
  assert.deepEqual(s.events.map(e => e[0]), ['fault', 'closed']);
  assert.equal(s.events[0]![1], 'source_error');
  assert.equal(listeners.size, 0);
  assert.equal(m.pending(), 0);
});

test('a job sample that stops the monitor through data() never reschedules', async () => {
  const m = manual(), { controller, signal } = trackedSignal();
  const s = sink({ data: () => controller.abort() });
  await jobLaunch(lease(() => ({ status: 'running' })), 'job', 30000, m.clock)(s.sink, signal, Infinity);
  assert.equal(s.closedCount(), 1);
  assert.equal(m.pending(), 0);
});

test('a job sample that throws later faults and closes without rescheduling', async () => {
  const m = manual(), { signal, listeners } = trackedSignal();
  let calls = 0;
  const s = sink();
  const done = jobLaunch(lease(() => { if (++calls > 1) throw new Error('gone'); return { status: 'running' }; }), 'job', 30000, m.clock)(s.sink, signal, Infinity);
  assert.equal(m.pending(), 1);
  m.fire();
  await done;
  assert.deepEqual(s.events.map(e => e[0]), ['started', 'data', 'fault', 'closed']);
  assert.equal(listeners.size, 0);
  assert.equal(m.pending(), 0);
});
