import test from 'node:test';
import assert from 'node:assert/strict';
import { websocketLaunch } from '../src/sources.ts';

// MON-2: an abort (monitor_stop, session shutdown) while the endpoint is still being prepared is a cancellation, not a
// source error: the panel and the status must not tell the user the endpoint is broken.
function recorder() {
  const calls: Array<{ type: 'fault' | 'closed'; detail: unknown; failed?: boolean }> = [];
  const sink: any = {
    started() {}, data() {}, stderr() {},
    fault: (reason: string) => calls.push({ type: 'fault', detail: reason }),
    closed: (evidence: unknown, failed = false) => calls.push({ type: 'closed', detail: evidence, failed }),
  };
  return { sink, calls };
}
const source = { kind: 'websocket', url: 'wss://monitor-cancel.invalid/stream' } as any;

test('MON-2: abort before the endpoint is prepared closes as startupCanceled without a fault', async () => {
  const { sink, calls } = recorder();
  const controller = new AbortController(); controller.abort();
  await websocketLaunch(source)(sink, controller.signal, Date.now() + 10_000);
  assert.deepEqual(calls.map(c => c.type), ['closed']);
  assert.equal(calls[0]!.failed, false);
  assert.deepEqual(calls[0]!.detail, { sourceClosed: true, startupCanceled: true });
});

test('MON-2: abort while the endpoint is being prepared closes as startupCanceled without a fault', async () => {
  const { sink, calls } = recorder();
  const controller = new AbortController();
  const running = websocketLaunch(source)(sink, controller.signal, Date.now() + 10_000);
  controller.abort();
  await running;
  assert.equal(calls.some(c => c.type === 'fault'), false, 'no source_error fault');
  const closed = calls.find(c => c.type === 'closed')!;
  assert.equal(closed.failed, false);
  assert.deepEqual(closed.detail, { sourceClosed: true, startupCanceled: true });
});

test('MON-2: a startup that merely times out is still a failure', async () => {
  const { sink, calls } = recorder();
  const controller = new AbortController();
  await websocketLaunch(source)(sink, controller.signal, Date.now()); // deadline already reached: the startup timer fires first
  assert.deepEqual(calls.map(c => c.type), ['fault', 'closed']);
  assert.equal(calls[0]!.detail, 'source_error');
  assert.equal(calls[1]!.failed, true);
  assert.deepEqual(calls[1]!.detail, { sourceClosed: true, startupFailed: true, startupError: calls[1]!.detail && (calls[1]!.detail as any).startupError });
  assert.match((calls[1]!.detail as any).startupError, /^NETWORK_TIMEOUT: /);
});
