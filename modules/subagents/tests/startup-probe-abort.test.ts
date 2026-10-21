import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSingleAgent } from '../extensions/subagent/index.ts';
import { installManagedBoundary, fixtureAgentPath } from './fixtures/managed-boundary.ts';

// A child that exits non-zero makes the runner probe startup.json after close. A stalled probe must stay
// cancelable and bounded instead of pinning the active-child permit and writer lock.
for (const mode of ['abort', 'deadline'] as const) test(`stalled post-close startup probe is released by ${mode}`, async t => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), 'startup-probe-'));
  const controller = new AbortController();
  let enter!: () => void, unblock!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { unblock = resolve; });
  let owned: Promise<void> = Promise.resolve(), settled = false, running: ReturnType<typeof runSingleAgent> | undefined;
  const access = fs.promises.access.bind(fs.promises);
  try {
    installManagedBoundary(t);
    t.mock.method(fs.promises, 'access', async (...args: Parameters<typeof access>) => {
      if (String(args[0]).endsWith('startup.json')) { enter(); await blocked; }
      return access(...args);
    });
    t.mock.method(childProcess, 'spawn', (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const stdout = new PassThrough(), stderr = new PassThrough();
      const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null, kill() { throw new Error('No live child should be killed'); } });
      // A real child reports the cwd it was launched with, which is the guard's canonical cwd. Recomputing it here with
      // realpathSync would disagree with the runner's fs.promises.realpath on Windows short (8.3) temp paths.
      const childCwd = JSON.parse(String(options.env.PI_SUBAGENTS_GUARD)).cwd as string;
      setImmediate(() => {
        stdout.write(JSON.stringify({ type: 'session', version: 3, id: args[args.indexOf('--session-id') + 1], cwd: childCwd }) + '\n');
        stdout.end(); stderr.end(); proc.exitCode = 1; proc.emit('close', 1, null);
      });
      return proc;
    });
    syncBuiltinESMExports();
    running = runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false } as any, [{ name: 'worker', description: 'probe', source: 'bundled', filePath: fixtureAgentPath, systemPrompt: 'probe' }] as any, 'worker', 'probe', undefined, undefined, controller.signal, undefined, results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) as any, 'probe-owner', 'probe-call', {
      sessionRootDir: join(root, 'managed'), invocation: (args: string[]) => ({ command: 'fake-child', args }), onOwnedSettlement: (p: Promise<void>) => { owned = p; },
      ioTimeoutMs: mode === 'deadline' ? 400 : undefined,
    } as any).then(result => { settled = true; return result; });
    assert.notEqual(await Promise.race([entered.then(() => 'entered'), running.then(() => 'finished-early'), new Promise(r => setTimeout(r, 20000, 'timeout'))]), 'finished-early', 'runner never reached the startup probe');
    if (mode === 'abort') controller.abort();
    const outcome = await Promise.race([running.then(() => 'settled'), new Promise(r => setTimeout(r, 1500, 'stuck'))]);
    assert.equal(outcome, 'settled', 'runner must not wait on a stalled startup probe');
    assert.equal(settled, true);
    assert.equal((await running).status, mode === 'abort' ? 'aborted' : 'failed');
  } finally {
    unblock();
    if (running) await running;
    await owned;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
