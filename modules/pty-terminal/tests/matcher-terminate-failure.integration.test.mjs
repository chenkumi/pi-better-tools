// D12: matcher.ts releases worker capacity (active--) in `finally` even when worker.terminate() rejects, and the
// terminate rejection overwrites the original match outcome.
// Level: real Pi 1.1.0 AgentSession, real PTY module entry/tool path, real node-pty and REAL match workers running a
// catastrophic regex. Only Worker.prototype.terminate is made to reject (workers keep running = unconfirmed exit).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createHost, entry, heartbeat, isolate, log, text } from '../../../tests/helpers/regression/host.mjs';

const require = createRequire(import.meta.url);
const MAX_MATCH_WORKERS = 16; // documented constant in modules/pty-terminal/src/matcher.ts
const ATTEMPTS = MAX_MATCH_WORKERS + 4;

test('D12: capacity must stay held while a worker is unterminated, and the original match outcome must survive', { timeout: 150000 }, async () => {
  const env = await isolate('d12-pty'); const stop = heartbeat('D12');
  const pty = require('node-pty'); const realSpawn = pty.spawn; const ptys = [];
  pty.spawn = (...args) => { const handle = realSpawn.apply(pty, args); ptys.push(handle); return handle; };
  const realTerminate = Worker.prototype.terminate; const workers = new Map();
  const failingTerminate = function () {
    // Real worker is NOT stopped: the termination request fails, so its exit is unconfirmed.
    if (!workers.has(this)) { const record = { exited: false }; workers.set(this, record); this.once('exit', () => { record.exited = true; }); }
    return Promise.reject(new Error('INJECTED worker.terminate() failure'));
  };
  let host;
  try {
    host = await createHost({ env, extensionPaths: [entry('modules/pty-terminal/src/index.ts')] });
    await host.bind(); assert.deepEqual(host.loadErrors(), []);
    // The child prints a line that makes ^(a|aa)+$ backtrack (passes the nested-quantifier heuristic) exponentially: the worker never finishes by itself.
    const program = "console.log('a'.repeat(60) + '!'); setInterval(() => {}, 1000)";
    const [spawned] = await host.callTools({ name: 'pty_spawn', arguments: { command: process.execPath, args: ['-e', program] } });
    assert.ok(!spawned.isError, text(spawned)); const { sessionId } = JSON.parse(text(spawned));
    // Make sure the output arrived before the attempts (benign regex, no draining thanks to `since`).
    const [primed] = await host.callTools({ name: 'pty_read', arguments: { sessionId, timeoutMs: 8000, since: 0, waitFor: 'a{20}' } });
    assert.match(text(primed), /aaaa/, 'precondition: output buffered'); // matcher still healthy here
    Worker.prototype.terminate = failingTerminate; // inject the failure only for the measured attempts

    const outcomes = [];
    for (let i = 1; i <= ATTEMPTS; i++) {
      log(`regex read attempt ${i}/${ATTEMPTS}; unterminated workers so far: ${[...workers.values()].filter(w => !w.exited).length}`);
      const [result] = await host.callTools({ name: 'pty_read', arguments: { sessionId, waitFor: '^(a|aa)+$', timeoutMs: 100, since: 0 } });
      outcomes.push({ isError: Boolean(result.isError), text: text(result) });
    }
    log('outcomes: ' + JSON.stringify(outcomes.slice(0, 3)));
    const running = [...workers.values()].filter(w => !w.exited).length;
    const overwritten = outcomes.filter(o => /INJECTED worker\.terminate/.test(o.text)).length;
    const capacityRefusals = outcomes.filter(o => /capacity exhausted/.test(o.text)).length;
    log(`unterminated live workers=${running}, outcomes overwritten by terminate failure=${overwritten}, capacity refusals=${capacityRefusals}`);
    const failures = [];
    if (running > MAX_MATCH_WORKERS) failures.push(`capacity released while workers were unterminated: ${running} live workers > MAX ${MAX_MATCH_WORKERS}`);
    if (overwritten > 0) failures.push(`${overwritten}/${ATTEMPTS} original budget/match outcomes were overwritten by the terminate rejection (first: ${JSON.stringify(outcomes[0].text).slice(0, 160)})`);
    assert.equal(failures.length, 0, failures.join('; '));
  } finally {
    Worker.prototype.terminate = realTerminate;
    await Promise.allSettled([...workers.keys()].map(worker => worker.terminate()));
    // Close the host first (its shutdown kills the session); killing the node-pty handle beforehand makes the later kill crash conpty natively.
    try { await host?.close(); } catch { /* ignore */ }
    for (const handle of ptys) { try { handle.kill(); } catch { /* gone */ } }
    stop(); await env.cleanup();
  }
});
