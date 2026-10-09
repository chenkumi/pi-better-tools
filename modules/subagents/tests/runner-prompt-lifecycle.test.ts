import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ulid } from 'ulid';
import { runSingleAgent } from '../extensions/subagent/index.ts';
import { ManagedSession } from '../extensions/subagent/session-store.ts';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: import('node:test').TestContext) {
  const root = await fs.promises.mkdtemp(join(tmpdir(), 'pi-prompt-lifecycle-'));
  const agentPath = join(root, 'agent.md'); await fs.promises.writeFile(agentPath, 'test');
  const controller = new AbortController();
  let managed: ManagedSession | undefined;
  const allocate = ManagedSession.allocate;
  t.mock.method(ManagedSession, 'allocate', async (...args: Parameters<typeof allocate>) => { managed = await allocate(...args); return managed; });
  const run = (invocation: (args: string[]) => never) => runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false },
    [{ name: 'worker', description: 'test', source: 'bundled', filePath: agentPath, systemPrompt: 'system' }],
    'worker', 'task', undefined, undefined, controller.signal, undefined,
    (results, progress) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results, progress }),
    'parent', 'call', { sessionRootDir: join(root, 'managed'), invocation, ioTimeoutMs: 60000 });
  return { root, controller, run, get managed() { return managed!; } };
}
test('cancelled pending temp write cannot retain an otherwise settled native writer lock', { timeout: 10000 }, async t => {
  const h = await fixture(t), entered = deferred(), release = deferred(), cleaned = deferred();
  const write = fs.promises.writeFile, rm = fs.promises.rm;
  let directory: string | undefined, spawned = false;
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).endsWith('prompt-worker.md')) { directory = dirname(String(args[0])); entered.resolve(); await release.promise; }
    return write(...args);
  });
  t.mock.method(fs.promises, 'rm', async (...args: Parameters<typeof rm>) => {
    await rm(...args); if (String(args[0]) === directory) cleaned.resolve();
  });
  const pending = h.run(() => { spawned = true; throw new Error('must not spawn'); });
  try {
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`settled before injection: ${JSON.stringify(result)}`); })]);
    h.controller.abort(new Error('cancelled'));
    const result = await pending;
    assert.equal(result.status, 'aborted'); assert.equal(spawned, false);
    assert.ok(directory && fs.existsSync(directory), 'temp owner still holds its pending write');
    await assert.rejects(fs.promises.stat(join(h.managed.directory, 'writer.lock')), { code: 'ENOENT' });
    assert.equal(h.managed.manifest.state, 'blocked', 'initial cancelled run is not falsely resumable');
    await h.managed.acquire(ulid().toUpperCase()); await h.managed.release();
    assert.equal(getEventListeners(h.controller.signal, 'abort').length, 0);
    release.resolve(); await cleaned.promise; assert.equal(fs.existsSync(directory!), false);
  } finally { release.resolve(); await pending; if (directory) await cleaned.promise; t.mock.restoreAll(); await rm(h.root, { recursive: true, force: true }); }
});
test('pre-aborted prompt cleanup admits owned deletion without waiting for its stalled completion', { timeout: 10000 }, async t => {
  const h = await fixture(t), entered = deferred(), release = deferred(), cleaned = deferred();
  const rm = fs.promises.rm;
  let directory: string | undefined;
  t.mock.method(fs.promises, 'rm', async (...args: Parameters<typeof rm>) => {
    if (String(args[0]).includes('pi-subagent-')) { directory = String(args[0]); entered.resolve(); await release.promise; }
    await rm(...args); if (String(args[0]) === directory) cleaned.resolve();
  });
  const pending = h.run(() => { h.controller.abort(new Error('already cancelled')); throw new Error('injected invocation failure'); });
  try {
    await entered.promise;
    const result = await pending; // deletion remains blocked; no timer advance/sleep
    assert.match(result.errorMessage!, /injected invocation failure/);
    assert.match(result.logError!, /Prompt cleanup.*aborted/);
    assert.ok(directory && fs.existsSync(directory));
    assert.equal(getEventListeners(h.controller.signal, 'abort').length, 0);
    release.resolve(); await cleaned.promise; assert.equal(fs.existsSync(directory!), false);
  } finally { release.resolve(); await pending; if (directory) await cleaned.promise; t.mock.restoreAll(); await rm(h.root, { recursive: true, force: true }); }
});
