import assert from 'node:assert/strict';
import test from 'node:test';
import { hostSampler, systemLaunch } from '../src/sources.ts';
import { validateStart } from '../src/schema.ts';
import type { Clock } from '../src/core.ts';

function manual() {
  let now = 0; const tasks = new Map<number, { at: number; fn: () => void }>(); let next = 0;
  const clock: Clock = { now: () => now, set: (fn, ms) => { const id = ++next; tasks.set(id, { at: now + ms, fn }); return id; }, clear: id => { tasks.delete(id as number); } };
  const tick = () => { const entry = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) return false; tasks.delete(entry[0]); now = entry[1].at; entry[1].fn(); return true; };
  return { clock, tick, pending: () => tasks.size };
}
function sink() {
  const events: any[] = [];
  return { events, started: () => events.push(['started']), data: (_t: unknown, _p: boolean, snapshot?: any) => events.push(['data', snapshot]), stderr: () => {}, fault: (kind: string) => events.push(['fault', kind]), closed: (evidence: unknown, failed?: boolean) => events.push(['closed', evidence, failed ?? false]) };
}
const reports = (s: ReturnType<typeof sink>) => s.events.filter(e => e[0] === 'data').map(e => e[1]);
/** Runs one sample per interval from a scripted utilisation series; `undefined` entries model "no baseline yet". */
async function run(series: (number | undefined)[], source: { metric: 'cpu' | 'ram'; thresholdPercent: number; sustainMs: number } = { metric: 'cpu', thresholdPercent: 80, sustainMs: 3000 }, intervalMs = 1000) {
  const m = manual(), s = sink(), controller = new AbortController(); let i = 0;
  const done = systemLaunch(source, intervalMs, m.clock, () => series[Math.min(i++, series.length - 1)])(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
  for (let n = 0; n < series.length; n++) m.tick();
  controller.abort(); await done;
  return { s, m };
}

test('system source accepts a bounded shape and refuses the rest with the fix', () => {
  assert.equal(validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 10000 } }).source.kind, 'system');
  assert.equal((validateStart({ source: { kind: 'system', metric: 'ram', thresholdPercent: 90, sustainMs: 5000, intervalMs: 2000 }, durationMs: 60000 }).source as any).intervalMs, 2000);
  assert.throws(() => validateStart({ source: { kind: 'system', thresholdPercent: 85, sustainMs: 10000 } }), /"metric".*"cpu" or "ram"/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'io', thresholdPercent: 85, sustainMs: 10000 } }), /"metric"/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', sustainMs: 10000 } }), /thresholdPercent/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 101, sustainMs: 10000 } }), /1–100/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 0, sustainMs: 10000 } }), /thresholdPercent/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85 } }), /sustainMs/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 999 } }), /sustainMs/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 10000, intervalMs: 999 } }), /intervalMs/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 10000, pid: 1 } }), /Unknown Monitor parameter/);
});

test('sustainMs must be below durationMs, including the default duration', () => {
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 60000 }, durationMs: 60000 }), /below "durationMs"/);
  assert.throws(() => validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 300000 } }), /the default/);
  assert.equal(validateStart({ source: { kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 300000 }, durationMs: 600000 }).durationMs, 600000);
});

test('a run at or above the threshold for sustainMs reports once with aggregate figures only', async () => {
  const r = reports((await run([50, 90, 92, 95, 99, 99, 99])).s);
  assert.equal(r.length, 1);
  assert.deepEqual(Object.keys(r[0]).sort(), ['intervalMs', 'metric', 'peakPercent', 'scope', 'sustainMs', 'sustainedMs', 'thresholdPercent', 'usagePercent']);
  assert.equal(r[0].metric, 'cpu'); assert.equal(r[0].sustainedMs, 3000); assert.equal(r[0].peakPercent, 99); assert.equal(r[0].usagePercent, 99);
});

test('the threshold is inclusive and a short spike never reports', async () => {
  assert.equal(reports((await run([80, 80, 80, 80])).s).length, 1);
  assert.equal(reports((await run([90, 90, 10, 90, 90, 10, 90, 90])).s).length, 0);
});

test('a dip below the threshold resets the run and a new excursion reports again after it sustains', async () => {
  const r = reports((await run([90, 90, 90, 90, 95, 40, 90, 90, 90, 90])).s);
  assert.equal(r.length, 2);
  assert.equal(r[1].sustainedMs, 3000);
});

test('missing baseline samples are skipped and keep the monitor sampling', async () => {
  assert.equal(reports((await run([undefined, undefined, 90, 90, 90, 90])).s).length, 1);
});

test('ram reports the OS free-memory basis; abort closes with the timer cleared and nothing pending', async () => {
  const { s, m } = await run([95, 95, 95, 95], { metric: 'ram', thresholdPercent: 90, sustainMs: 3000 });
  assert.equal(reports(s)[0].basis, 'os.freemem (OS-reported free memory)');
  const closed = s.events.filter(e => e[0] === 'closed');
  assert.equal(closed.length, 1); assert.equal(closed[0][1].timerCleared, true);
  assert.equal(m.pending(), 0);
});

test('a sampler that throws faults and closes once', async () => {
  const m = manual(), s = sink(), controller = new AbortController();
  const done = systemLaunch({ metric: 'cpu', thresholdPercent: 80, sustainMs: 1000 }, 1000, m.clock, () => { throw new Error('boom'); })(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
  m.tick(); await done;
  assert.deepEqual(s.events.filter(e => e[0] === 'fault'), [['fault', 'source_error']]);
  assert.equal(s.events.filter(e => e[0] === 'closed').length, 1);
});

test('hostSampler computes cpu from successive busy/idle deltas and ram from used/total', () => {
  let user = 0, idle = 0;
  const host = { cpus: () => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }] as any, totalmem: () => 1000, freemem: () => 250 };
  const cpu = hostSampler('cpu', host);
  user += 30; idle += 70; assert.equal(cpu(), 30);
  user += 90; idle += 10; assert.equal(cpu(), 90);
  assert.equal(cpu(), undefined); // no elapsed time: no figure, not a division by zero
  assert.equal(hostSampler('ram', host)(), 75);
});

test('monitor_start accepts a system source, exposes only metric and threshold, and a rejected start leaves no receipt', async () => {
  const { default: monitorExtension } = await import('../src/index.ts');
  const tools = new Map<string, any>(), handlers = new Map<string, any>(); let runtime: any;
  const { clock } = manual();
  monitorExtension({ registerMessageRenderer() {}, registerTool: (t: any) => tools.set(t.name, t), on: (name: string, fn: any) => handlers.set(name, fn), getActiveTools: () => ['monitor_start', 'monitor_status', 'monitor_stop'], sendMessage() {} } as any, { clock, onRuntime: r => { runtime = r; } });
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'system-source-extension' } };
  try {
    await handlers.get('session_start')({}, ctx);
    const start = (source: unknown, durationMs?: number) => tools.get('monitor_start').execute('direct', { source, wakeAgent: false, ...(durationMs ? { durationMs } : {}) }, undefined, undefined, ctx);
    const rejected = await start({ kind: 'system', metric: 'cpu', thresholdPercent: 85, sustainMs: 300000 });
    assert.equal(rejected.isError, true); assert.match(rejected.structuredContent.error, /below "durationMs"/);
    assert.deepEqual((await tools.get('monitor_status').execute('direct', {}, undefined, undefined, ctx)).structuredContent, { monitors: [] });
    const accepted = await start({ kind: 'system', metric: 'ram', thresholdPercent: 90, sustainMs: 5000 }, 60000);
    assert.equal(accepted.isError, undefined); assert.equal(accepted.structuredContent.source, 'system'); assert.equal(accepted.structuredContent.sourcePreview, 'ram >= 90% for 5000 ms');
    const row = runtime.panelRows()[0];
    assert.equal(row.source, 'system'); assert.equal(row.target, 'ram >= 90% for 5000 ms'); assert.equal(row.intervalMs, 1000);
    assert.equal(runtime.briefs()[0].target, 'ram >= 90% for 5000 ms');
    await tools.get('monitor_stop').execute('direct', { monitorId: accepted.structuredContent.monitorId }, undefined, undefined, ctx);
    await runtime.settled(accepted.structuredContent.monitorId);
    assert.equal(runtime.status(accepted.structuredContent.monitorId).cleanupEvidence.sourceClosed, true);
  } finally { await handlers.get('session_shutdown')({}, ctx); }
});
