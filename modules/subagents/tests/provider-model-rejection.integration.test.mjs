// D19: subagent execute() returns plain results (no isError) for blank provider, provider-without-model and
// provider + provider/model; the sibling validation branches (INVALID_DISPATCH, capacity) do set isError.
// Level: real Pi 1.1.0 AgentSession + real subagents module entry + real agent-loop tool execution + real tool-result messages.
// Safety: PI_SUBAGENTS_PI_CLI points at a stub that would write a marker if any child were spawned (asserted absent).
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHost, entry, heartbeat, isolate, log, text } from '../../../tests/helpers/regression/host.mjs';

test('D19: invalid provider/model combinations must be isError:true tool results', { timeout: 120000 }, async () => {
  const env = await isolate('d19-sub'); const stop = heartbeat('D19'); let host;
  try {
    const marker = join(env.home, 'CHILD_SPAWNED'); const stub = join(env.home, 'stub-pi.mjs');
    await writeFile(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(1);\n`);
    process.env.PI_SUBAGENTS_PI_CLI = stub;
    host = await createHost({ env, extensionPaths: [entry('modules/subagents/src/index.ts')] });
    await host.bind(); assert.deepEqual(host.loadErrors(), []);
    assert.ok(host.session.getActiveToolNames().includes('subagent'), 'subagent tool is active');
    const base = { agent: 'scout', task: 'noop' };
    const cases = {
      'blank provider': { ...base, provider: '   ' },
      'provider without model': { ...base, provider: 'openai' },
      'provider + provider/model': { ...base, provider: 'openai', model: 'openai/gpt-5' },
    };
    const control = await host.callTools({ name: 'subagent', arguments: { agent: 'scout' } }); // sibling branch: INVALID_DISPATCH (mode normalisation)
    log(`control (INVALID_DISPATCH) isError=${control[0].isError}: ${text(control[0]).slice(0, 100)}`);
    const failures = [];
    for (const [name, args] of Object.entries(cases)) {
      const [result] = await host.callTools({ name: 'subagent', arguments: args });
      log(`${name}: isError=${result.isError} text=${JSON.stringify(text(result)).slice(0, 130)}`);
      if (result.isError !== true) failures.push(`${name}: rejection message returned without isError (${JSON.stringify(text(result)).slice(0, 80)})`);
    }
    await assert.rejects(access(marker), 'no child process may be spawned by validation-only calls');
    assert.equal(failures.length, 0, failures.join('; '));
  } finally {
    delete process.env.PI_SUBAGENTS_PI_CLI;
    try { await host?.close(); } catch { /* ignore */ }
    stop(); await env.cleanup();
  }
});
