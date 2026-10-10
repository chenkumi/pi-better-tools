// D11: PTY shutdown with an unconfirmed transport exit throws; Pi invalidates the extension instance and the old
// manager becomes unreachable, leaving a live process with no retryable recovery handle.
// Level: real Pi 1.1.0 AgentSession + real PTY module entry + real node-pty process. Only the kill request is made
// ineffective at the node-pty boundary (simulating "transport kill cannot be confirmed").
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { barrier, createHost, entry, heartbeat, isolate, log, text } from '../../../tests/helpers/regression/host.mjs';

const require = createRequire(import.meta.url);

test('D11: an unconfirmed PTY transport must remain recoverable after shutdown/reload', { timeout: 120000 }, async () => {
  const env = await isolate('d11-pty'); const stop = heartbeat('D11');
  const pty = require('node-pty'); const realSpawn = pty.spawn; const real = [];
  // Native boundary injection: the kill request is accepted but has no effect, so exit can never be confirmed.
  pty.spawn = (...args) => { const handle = realSpawn.apply(pty, args); const kill = handle.kill.bind(handle); const record = { handle, kill, exited: false }; handle.onExit(() => { record.exited = true; }); real.push(record); handle.kill = () => {}; return handle; };
  let host;
  try {
    host = await createHost({ env, extensionPaths: [entry('modules/pty-terminal/src/index.ts')] });
    await host.bind(); assert.deepEqual(host.loadErrors(), []);
    log('spawning a real PTY child through the real tool path');
    const [spawned] = await host.callTools({ name: 'pty_spawn', arguments: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    assert.ok(!spawned.isError, text(spawned));
    const { sessionId } = JSON.parse(text(spawned)); const record = real[0]; assert.ok(record, 'real node-pty child was created');
    assert.equal(record.exited, false, 'child must be alive before shutdown');

    log('reloading the real host: shutdown handler throws because exit is unconfirmed; Pi catches and drops the old instance');
    await host.session.reload();
    const shutdownErrors = host.errors.map(e => String(e?.message ?? e));
    log(`host-observed extension errors: ${JSON.stringify(shutdownErrors)}`);
    assert.ok(shutdownErrors.some(m => /PTY shutdown incomplete/.test(m)), 'precondition: shutdown reported incomplete');
    assert.equal(record.exited, false, 'precondition: the real PTY transport is still running after reload (no confirmed exit)');

    const [listed] = await host.callTools({ name: 'pty_list', arguments: {} });
    const sessions = JSON.parse(text(listed));
    // Correct behaviour: a surviving/orphaned session is still reachable for retry (listed, killable) after reload.
    assert.ok(sessions.some(s => s.sessionId === sessionId),
      `live PTY transport (session ${sessionId}) has no recovery handle after reload; pty_list => ${JSON.stringify(sessions)}`);
    const recovered = sessions.find(s => s.sessionId === sessionId);
    assert.equal(recovered.recovered, true, 'the re-adopted session is explicitly marked recovered/unconfirmed');
    assert.match(recovered.note, /unconfirmed/);
    // Retry: once the kill actually works, pty_kill through the NEW instance releases it (and still never claims the remote tree stopped).
    for (const item of real) item.handle.kill = item.kill;
    const [killed] = await host.callTools({ name: 'pty_kill', arguments: { sessionId } });
    assert.equal(JSON.parse(text(killed)).released, true, text(killed));
    assert.match(text(killed), /remote process tree not confirmed stopped/);
  } finally {
    for (const { handle, kill } of real) { try { handle.kill = kill; kill(); } catch { /* already gone */ } }
    pty.spawn = realSpawn;
    try { await host?.close(); } catch { /* ignore */ }
    stop(); await env.cleanup();
  }
});
