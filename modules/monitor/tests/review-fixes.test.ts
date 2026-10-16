import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorRuntime, LIMITS, type SourceSink, type Clock } from '../src/core.ts';

/** `wall` can be stepped (NTP/manual correction); `mono` only moves with elapsed time, like performance.now(). */
class SteppableClock implements Clock {
  wall = 1_000_000; monotonic = 5_000; id = 0; tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.wall;
  mono = () => this.monotonic;
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.tasks.set(id, { at: this.monotonic + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) { this.wall += ms; this.monotonic += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.monotonic) { this.tasks.delete(id); task.fn(); } }
  step(ms: number) { this.wall += ms; }
}
const turn = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

for (const stepMs of [-600_000, 0]) {
  test(`G3-001: a ${stepMs} ms wall-clock step does not change throttle delay or elapsed time`, async () => {
    const clock = new SteppableClock(), sent: any[] = [];
    const owner = { sessionId: 'S', cwd: '/w' };
    const runtime = new MonitorRuntime(m => sent.push(m), clock);
    runtime.bind(owner, () => owner);
    let sink!: SourceSink, finish!: () => void;
    const receipt = runtime.start({ source: { kind: 'command', tool: 'bash', command: 'x' }, durationMs: 1_200_000, wakeAgent: false } as never, async s => { sink = s; s.started(); await new Promise<void>(r => { finish = () => { s.closed({ sourceClosed: true }); r(); }; }); });
    await turn();
    sink.data('first'); clock.advance(0); assert.equal(sent.length, 1);
    clock.advance(1_000); clock.step(stepMs);
    const timersBefore = new Set(clock.tasks.keys());
    sink.data('later');
    const delays = [...clock.tasks.entries()].filter(([id]) => !timersBefore.has(id)).map(([, t]) => t.at - clock.monotonic);
    assert.deepEqual(delays, [LIMITS.progressMs - 1_000], 'throttle is measured on the monotonic clock');
    assert.equal(runtimeElapsed(runtime, receipt.monitorId), 1_000, 'elapsed never goes negative or jumps');
    finish(); await runtime.settled(receipt.monitorId); await runtime.shutdown();
  });
}
const runtimeElapsed = (runtime: MonitorRuntime, id: string) => (runtime.status(id) as { elapsedMs: number }).elapsedMs;
