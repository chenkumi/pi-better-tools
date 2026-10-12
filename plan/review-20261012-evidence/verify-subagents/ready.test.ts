import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ulid } from 'ulid';

const mode = process.env.PROBE_MODE ?? 'ready-fault';
assert.ok(['ready-fault', 'ready-control'].includes(mode));
globalThis.fetch = async () => { throw new Error('Network forbidden in offline probe'); };
test(mode, { timeout: 20000 }, async t => {
  const repo = process.cwd();
  const root = await fs.mkdtemp(join(resolve(repo,
    'plan/review-20261012-evidence/verify-subagents'), 'subagents-buffer-'));
  const env = { ...process.env };
  for (const key of ['HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR']) process.env[key] = root;
  process.env.PI_CODING_AGENT_DIR = join(root, 'config');
  process.env.PI_OFFLINE = '1'; process.env.PI_BLACKHOLE_PASSIVE = 'true';
  const progress = setInterval(() => console.log('Progress: ready buffer probe running'), 1000);
  delete process.env.PI_SUBAGENTS_GUARD;
  console.log(`Progress: ${mode} started pid=${process.pid}`);
  const sizes: number[] = [], notices: any[] = [];
  let querySends = 0, interactive = 0, faultBeforeSecond = false, releaseBeforeClose = -1;
  let settled = false, releases = 0;
  try {
    const { runReadyQuery } = await import(pathToFileURL(resolve(repo,
      'modules/subagents/extensions/subagent/ready-query.ts')).href);
    const byteLength = Buffer.byteLength;
    t.mock.method(Buffer, 'byteLength', (value: any, encoding?: any) => {
      const size = byteLength(value, encoding);
      if (typeof value === 'string' && value.startsWith('X') && size > 8 * 1024 * 1024)
        sizes.push(size);
      return size;
    });
    t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: any) => {
      assert.equal(command, 'fake-offline-child');
      const guard = JSON.parse(options.env.PI_SUBAGENTS_GUARD);
      const stdout = new PassThrough(), stderr = new PassThrough();
      const stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk));
        assert.equal(request.type, 'get_state');
        if (mode === 'ready-control') setImmediate(() => { void (async () => {
          await fs.writeFile(guard.startupPath, JSON.stringify({ version: 1, id: guard.id, cwd: root,
            model: 'offline/model', thinkingLevel: 'off', childTrusted: false }));
          stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true,
            data: { sessionId: guard.id, sessionFile: args[args.indexOf('--session') + 1],
              model: { provider: 'offline', id: 'model' }, thinkingLevel: 'off' } }) + '\n');
        })().catch(error => { proc.emit('error', error); proc.emit('close', 1, null); }); });
        callback();
      }, final(callback) {
        if (mode === 'ready-control') setImmediate(() => { stdout.end(); stderr.end();
          proc.connected = false; proc.exitCode = 0; proc.emit('close', 0, null); });
        callback();
      } });
      const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin,
        connected: true, exitCode: null, signalCode: null, kill: () => true,
        send(data: any, callback: any) {
          if (data.type === 'query') {
            querySends++; assert.equal(mode, 'ready-control', 'fault must prohibit provider admission');
            setImmediate(() => proc.emit('message', { channel: data.channel, token: data.token,
              type: 'query_result', queryId: data.queryId, status: 'completed', output: 'offline control answer',
              provider: 'offline', model: 'model', usageUnknown: true }));
          } else assert.ok(['cancel_queries', 'cancel_query'].includes(data.type));
          callback?.(null);
        } });
      if (mode === 'ready-fault') setImmediate(() => {
        stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 'X'));
        faultBeforeSecond = notices.some(n => String(n.error).includes('RPC_CAPACITY'));
        assert.equal(faultBeforeSecond, true); assert.equal(releases, 0);
        stdout.write(Buffer.alloc(1024 * 1024, 'X'));
        releaseBeforeClose = releases;
        stdout.end(); stderr.end(); proc.connected = false;
        proc.emit('close', 1, null);
      });
      return proc;
    });
    syncBuiltinESMExports();
    const id = ulid().toUpperCase();
    const session = { id, manifest: { config: { agent: { systemPrompt: 'offline' },
      cwd: root, model: 'offline/model', thinkingLevel: 'off', childTrusted: false },
      checkpoint: { nativeSha256: '0'.repeat(64), leafId: 'unused' } } };
    const result = await runReadyQuery({ session: session as any,
      snapshot: Buffer.from('{}\n'), queryId: ulid().toUpperCase(), question: 'probe',
      signal: t.signal, invocation: args => ({ command: 'fake-offline-child', args }),
      acquireChild: async () => () => { releases++; }, validate: async () => {},
      onInteractive: () => { interactive++; assert.equal(mode, 'ready-control', 'faulted worker must not become interactive'); },
      onInteraction: notice => notices.push(notice) });
    settled = true;
    console.log(JSON.stringify({ sizes, releases, status: result.status,
      error: result.error, faultBeforeSecond, releaseBeforeClose, querySends, interactive,
      cleanupEvidence: result.cleanupEvidence, notices: notices.map(n => ({ status: n.status,
        cleanupPending: n.cleanupPending })) }));
    if (mode === 'ready-fault') {
      assert.ok(sizes.includes(8388609));
      assert.ok(sizes.includes(9437185), 'candidate predicts post-fault retention growth');
      assert.equal(result.status, 'failed'); assert.match(String(result.error), /RPC_CAPACITY/);
      assert.equal(querySends, 0); assert.equal(interactive, 0); assert.equal(releaseBeforeClose, 0);
    } else {
      assert.deepEqual(sizes, []); assert.equal(result.status, 'completed');
      assert.equal(result.output, 'offline control answer'); assert.equal(querySends, 1); assert.equal(interactive, 1);
    }
    assert.equal(releases, 1); assert.equal(result.cleanupPending, false);
  } finally {
    clearInterval(progress); t.mock.restoreAll(); syncBuiltinESMExports();
    process.env = env;
    if (settled) { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: 'ENOENT' }); }
    console.log(`Progress: ready buffer probe finished; sandbox ${settled ? 'removed' : 'retained'}`);
  }
});