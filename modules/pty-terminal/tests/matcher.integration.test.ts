import assert from 'node:assert/strict';
import test from 'node:test';
import { PtySessionManager } from '../src/pty-manager.ts';
import { compileWaitFor } from '../src/wait-for.ts';
function harness() {
  let data!: (text: string) => void, exit!: (value: any) => void;
  const manager = new PtySessionManager({ spawnPty: (() => ({ pid: 1, onData(fn: any) { data = fn; }, onExit(fn: any) { exit = fn; }, write() {}, resize() {}, kill() { exit({ exitCode: 0 }); } })) as never });
  const { sessionId } = manager.spawn('fake', [], {}, process.cwd());
  return { manager, sessionId, data: (text: string) => data(text) };
}
test('actual regex worker bounds catastrophic alternation while host remains responsive', { timeout: 10000 }, async t => {
  const h = harness(); t.after(() => h.manager.shutdown());
  h.data('a'.repeat(48) + '!');
  const pending = h.manager.readEx(h.sessionId, { timeoutMs: 0, waitFor: compileWaitFor('^(a|aa)+$') });
  const rejection = assert.rejects(pending, /worker budget.*Session and output retained/);
  await new Promise<void>(resolve => setImmediate(resolve)); // main loop keeps servicing work
  await rejection; // includes confirmed worker termination, not an abandoned waiter
  assert.equal((await h.manager.readEx(h.sessionId, { timeoutMs: 0 })).text, 'a'.repeat(48) + '!');
  assert.equal((await h.manager.readEx(h.sessionId, { timeoutMs: 0, waitFor: /^a/ })).wait, 'matched');
});
test('actual matcher abort and shutdown terminate owned workers without draining output', async t => {
  const h = harness(); t.after(() => h.manager.shutdown()); h.data('a'.repeat(48) + '!');
  const controller = new AbortController();
  const read = h.manager.readEx(h.sessionId, { timeoutMs: 60000, waitFor: /^(a|aa)+$/, signal: controller.signal });
  const stopped = assert.rejects(read, /cancel/); controller.abort(new Error('cancelled')); await stopped;
  assert.equal((await h.manager.readEx(h.sessionId, { timeoutMs: 0 })).text.length, 49);
  const again = h.manager.readEx(h.sessionId, { timeoutMs: 60000, waitFor: /^(a|aa)+$/ });
  const shutting = assert.rejects(again, /shutting down/);
  assert.deepEqual((await h.manager.shutdown()).retained, []); await shutting;
});
test('POSIX shutdown escalates a real SIGHUP-resistant local child and observes exit', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const manager = new PtySessionManager(); t.after(() => manager.shutdown());
  const { sessionId } = manager.spawn(process.execPath, ['-e', "process.on('SIGHUP',()=>{});process.stdout.write('READY');setInterval(()=>{},1000)"], {}, process.cwd());
  assert.equal((await manager.readEx(sessionId, { timeoutMs: 10000, waitFor: /READY/ })).wait, 'matched');
  const exit = manager.waitForExit(sessionId, 10000);
  assert.deepEqual((await manager.shutdown()).retained, []);
  assert.equal((await exit).signal, 9); assert.deepEqual(manager.list(), []);
});
