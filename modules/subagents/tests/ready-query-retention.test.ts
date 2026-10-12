import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { runReadyQuery } from '../extensions/subagent/ready-query.ts';

for (const mode of ['capacity', 'invalid-json', 'control']) test(`ready stdout ${mode}: fault drains without retention or early release`, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ready-retention-'));
  const sizes: number[] = [], notices: any[] = [];
  let releases = 0, querySends = 0, interactive = 0;
  const byteLength = Buffer.byteLength;
  t.mock.method(Buffer, 'byteLength', (value: any, encoding?: any) => {
    const size = byteLength(value, encoding);
    if (typeof value === 'string' && value.startsWith('X')) sizes.push(size);
    return size;
  });
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[], options: any) => {
    const guard = JSON.parse(options.env.PI_SUBAGENTS_GUARD);
    const stdout = new PassThrough(), stderr = new PassThrough();
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      if (mode === 'control') setImmediate(() => { void (async () => {
        await fs.writeFile(guard.startupPath, JSON.stringify({ id: guard.id, cwd: root, model: 'offline/model', thinkingLevel: 'off', childTrusted: false }));
        stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true,
          data: { sessionId: guard.id, sessionFile: args[args.indexOf('--session') + 1], model: { provider: 'offline', id: 'model' }, thinkingLevel: 'off' } }) + '\n');
      })().catch(error => { proc.emit('error', error); close(1); }); });
      callback();
    }, final(callback) { if (mode === 'control') setImmediate(() => close(0)); callback(); } });
    const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, connected: true, exitCode: null as number | null, signalCode: null,
      kill: () => true, send(data: any, callback: any) {
        if (data.type === 'query') { querySends++; setImmediate(() => proc.emit('message', { channel: data.channel, token: data.token,
          type: 'query_result', queryId: data.queryId, status: 'completed', output: 'answer', provider: 'offline', model: 'model', usageUnknown: true })); }
        callback?.(null);
      } });
    const close = (code: number) => { stdout.end(); stderr.end(); proc.connected = false; proc.exitCode = code; proc.emit('close', code, null); };
    if (mode !== 'control') setImmediate(() => {
      stdout.write(mode === 'capacity' ? Buffer.alloc(8 * 1024 * 1024 + 1, 'X') : 'bad JSON\n');
      assert.ok(notices.some(n => n.status === 'failed'));
      assert.equal(releases, 0, 'fault/EOF request is not actual close');
      const checks = sizes.length;
      for (let i = 0; i < 4; i++) stdout.write(Buffer.alloc(1024 * 1024, 'X'));
      assert.equal(sizes.length, checks, 'post-fault bytes must not re-enter rejected buffer byteLength checks');
      assert.equal(releases, 0); close(1);
    });
    return proc;
  });
  syncBuiltinESMExports();
  try {
    const session = { id: ulid().toUpperCase(), manifest: { config: { agent: { systemPrompt: 'offline' }, cwd: root, model: 'offline/model', thinkingLevel: 'off', childTrusted: false }, checkpoint: { nativeSha256: '0'.repeat(64), leafId: 'unused' } } };
    const result = await runReadyQuery({ session: session as any, snapshot: Buffer.from('{}\n'), queryId: ulid().toUpperCase(), question: 'probe', signal: t.signal,
      invocation: args => ({ command: 'fake-offline-child', args }), acquireChild: async () => () => { releases++; }, validate: async () => {},
      onInteractive: () => { interactive++; }, onInteraction: notice => notices.push(notice) });
    assert.equal(result.status, mode === 'control' ? 'completed' : 'failed', JSON.stringify(result));
    assert.equal(querySends, mode === 'control' ? 1 : 0); assert.equal(interactive, querySends);
    if (mode === 'capacity') { assert.deepEqual(sizes, [8388609]); assert.match(String(result.error), /RPC_CAPACITY/); }
    else assert.deepEqual(sizes, []);
    assert.equal(releases, 1); assert.equal(result.cleanupPending, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});
