import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { ShellJobs } from '../src/background-jobs.ts';
import { BackgroundRecovery } from '../src/recovery.ts';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('shutdown stays bounded when background log directory removal never settles', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-shutdown-removal-'));
  const entered = deferred(), release = deferred();
  const jobs = new ShellJobs({ sendMessage() {} });
  let shutdown;
  t.mock.method(BackgroundRecovery.prototype, 'accept', () => ({ update() {} }));
  try {
    const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => 'removal-owner' } };
    const receipt = jobs.submit(ctx, 'bash', 'noop', undefined, async () => ({ content: [{ type: 'text', text: 'done' }], structuredContent: { output: 'done', exit_code: 0 } }), 'call');
    const job = jobs.jobs.get(receipt.jobId);
    await job.done;
    const directory = job.directory, rm = fs.promises.rm.bind(fs.promises);
    t.mock.method(fs.promises, 'rm', async (...args) => {
      if (String(args[0]) === directory) { entered.resolve(); await release.promise; }
      return rm(...args);
    });
    syncBuiltinESMExports();
    // The removal budget is injected so this test never waits on a real deadline.
    shutdown = jobs.shutdown('reload', 20);
    await entered.promise;
    const outcome = await Promise.race([shutdown.then(() => 'settled'), new Promise(r => setTimeout(r, 1000, 'stuck'))]);
    assert.equal(outcome, 'settled', 'shutdown must not wait on a stalled directory removal');
    assert.equal(jobs.jobs.size, 0, 'registry is cleared even when removal is late');
  } finally {
    release.resolve();
    if (shutdown) await shutdown;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
