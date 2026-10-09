import { SessionManager } from '@earendil-works/pi-coding-agent';
import { MonitorRuntime, type Clock } from '../../src/core.ts';
import { validateStart } from '../../src/schema.ts';
/** Parent/Blackhole handoff: actual Monitor producer + actual Pi1.1.0 persisted-entry shape, no consumer edits. */
export async function buildProducerFixtures() {
  const fixtures: Record<string, unknown[]> = {};
  for (const mode of ['success', 'failure', 'rate', 'expiry', 'cleanup-unknown']) {
    let now = 0, next = 0; const tasks = new Map<number, { at: number; fn: () => void }>();
    const clock: Clock = { now: () => now, set(fn, ms) { const id = ++next; tasks.set(id, { at: now + ms, fn }); return id; }, clear(id) { tasks.delete(id as number); } };
    const advance = (ms: number) => { now += ms; for (const [id, t] of [...tasks]) if (t.at <= now) { tasks.delete(id); t.fn(); } };
    const manager = SessionManager.inMemory(process.cwd()), owner = { sessionId: manager.getSessionId(), cwd: process.cwd() };
    const runtime = new MonitorRuntime(message => { manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); }, clock);
    runtime.bind(owner, () => owner);
    let expire!: () => void;
    const input = validateStart({ source: { kind: 'command', tool: 'bash', command: '[fixture-only]' }, durationMs: 1000, wakeAgent: false });
    const receipt = runtime.start(input, async (sink, signal) => {
      sink.started();
      if (mode === 'expiry') await new Promise<void>(r => { expire = r; signal.addEventListener('abort', () => r(), { once: true }); });
      else if (mode === 'rate') for (let i = 0; i < 61; i++) sink.data(`bounded-${i}`);
      else if (mode === 'failure' || mode === 'cleanup-unknown') sink.fault('source_error');
      else sink.data('completed output, untrusted data');
      if (mode !== 'cleanup-unknown') sink.closed({ sourceClosed: true, exitCode: mode === 'failure' ? 7 : 0, processTreeState: 'unknown' }, mode === 'failure');
    });
    await Promise.resolve(); await Promise.resolve();
    if (mode === 'expiry') { advance(1000); expire(); }
    await runtime.settled(receipt.monitorId); for (let i = 0; i < 4; i++) advance(i ? 30000 : 0);
    fixtures[mode] = manager.getEntries().filter(e => e.type === 'custom_message'); await runtime.shutdown();
  }
  return fixtures;
}
