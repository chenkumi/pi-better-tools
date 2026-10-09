import assert from 'node:assert/strict';
import test from 'node:test';
import { PtySessionManager } from '../src/pty-manager.ts';
import { truncatePtyOutput, MAX_OUTPUT_BYTES } from '../src/output.ts';

test('oversized complete and incomplete escapes advance raw cursor and report loss', async () => {
  for (const suffix of ['mTAIL', '']) {
    let emit!: (text: string) => void;
    const manager = new PtySessionManager({ spawnPty: (() => ({ pid: 1, onData(fn: any) { emit = fn; }, onExit() {}, write() {}, resize() {}, kill() { throw new Error('fake'); } })) as never });
    const { sessionId } = manager.spawn('fake', [], {}, process.cwd());
    const raw = '\x1b[' + '0;'.repeat(30000) + suffix;
    emit(raw);
    const first = await manager.readEx(sessionId, { timeoutMs: 0 }), output = truncatePtyOutput(first.text, { final: false });
    assert.match(output.content, /discarded .*oversized escape/);
    if (suffix) assert.match(output.content, /TAIL/);
    assert.ok(Buffer.byteLength(output.content) < MAX_OUTPUT_BYTES);
    const cursor = first.start + first.text.length - output.remainder.length;
    assert.equal(cursor, raw.length); manager.consume(sessionId, cursor);
    assert.equal((await manager.readEx(sessionId, { timeoutMs: 0 })).text, '');
  }
});
test('shutdown retains refused transport without fabricating exit; other transports still close', async () => {
  const callbacks: Array<(value: any) => void> = [];
  let count = 0, refuse = true;
  const manager = new PtySessionManager({ spawnPty: (() => {
    const index = count++;
    return { pid: index + 1, onData() {}, onExit(fn: any) { callbacks[index] = fn; }, write() {}, resize() {}, kill() { if (!index && refuse) throw new Error('refused'); callbacks[index]({ exitCode: 7 }); } };
  }) as never });
  const first = manager.spawn('fake', [], {}, process.cwd()); manager.spawn('healthy', [], {}, process.cwd());
  let exitResolved = false; const pending = manager.waitForExit(first.sessionId, 60000).then(value => { exitResolved = true; return value; });
  const report = await manager.shutdown();
  assert.deepEqual(report.retained, [first.sessionId]); assert.match(report.errors.join(' '), /refused/);
  assert.equal(manager.list()[0].state, 'running'); assert.equal(exitResolved, false);
  assert.throws(() => manager.spawn('new', [], {}, process.cwd()), /shutting down/);
  refuse = false;
  assert.deepEqual((await manager.shutdown()).retained, []);
  assert.equal((await pending).exitCode, 7); assert.equal(exitResolved, true);
});
test('output arriving during asynchronous matching is re-examined without missing wakeup', async () => {
  let emit!: (text: string) => void, release!: (matched: boolean) => void, calls = 0;
  const first = new Promise<boolean>(resolve => { release = resolve; });
  const manager = new PtySessionManager({ spawnPty: (() => ({ pid: 1, onData(fn: any) { emit = fn; }, onExit() {}, write() {}, resize() {}, kill() {} })) as never,
    matchPattern: async (pattern, input) => ++calls === 1 ? first : pattern.test(input) });
  const { sessionId } = manager.spawn('fake', [], {}, process.cwd());
  const read = manager.readEx(sessionId, { timeoutMs: 10000, waitFor: /READY/ });
  emit('READY'); release(false);
  assert.equal((await read).wait, 'matched'); assert.equal(calls, 2);
});
