// STATUS: todo / known-upstream (@ff-labs/pi-fff 0.11.0).
// D15: neither AuxFinderPool nor the main finder (ensureFinder/destroyFinder) has a shutdown generation fence: a finder whose
// native creation resolves AFTER session_shutdown is still published and never destroyed.
// Level: real Pi 1.1.0 AgentSession + real pi-fff 0.11.0 (real tool path, session_start path, real shutdown event emit).
// DEGRADED: the native FileFinder is a deferred-promise fake at the SDK boundary; no native DLL, no reload re-creation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { barrier, createHost, entry, heartbeat, isolate, log } from '../../../tests/helpers/regression/host.mjs';
import { installFakeFffSdk } from '../../../tests/helpers/regression/fake-fff-sdk.mjs';

async function scenario(name, hold, body) {
  const env = await isolate(`d15-${name}`); const stop = heartbeat(`D15 ${name}`); const gate = barrier(); const pending = [];
  const ctl = { holdMain: hold === 'main', holdAux: hold === 'aux' };
  const fake = installFakeFffSdk({
    gate: record => ((record.basePath === env.cwd ? ctl.holdMain : ctl.holdAux) ? new Promise(resolve => { pending.push(resolve); }) : undefined),
    onCreate: () => gate.poke() });
  const release = () => { ctl.holdMain = ctl.holdAux = false; for (const resolve of pending.splice(0)) resolve(); };
  let host;
  try {
    await writeFile(join(env.agentDir, 'pi-fff.json'), JSON.stringify({ mode: 'tools-only' }));
    host = await createHost({ env, extensionPaths: [entry('node_modules/@ff-labs/pi-fff/src/index.ts')] });
    await body({ env, host, fake, gate, release });
  } finally { release(); try { await host?.close(); } catch { /* ignore */ } fake.restore(); stop(); await env.cleanup(); }
}

test('D15 (aux): acquire -> shutdown -> late create resolves; the late finder must be destroyed and not published', { timeout: 120000, todo: 'known-upstream @ff-labs/pi-fff 0.11.0 (D15): no shutdown generation fence; a late-resolving finder is published and never destroyed; third-party snapshot is not modified here' }, async () => {
  await scenario('aux', 'aux', async ({ env, host, fake, gate, release }) => {
    await host.bind(); assert.deepEqual(host.loadErrors(), []); // main finder is not held in this scenario
    const root = join(env.home, 'roots', 'r1'); await mkdir(root, { recursive: true });
    log('starting an auxiliary search whose native creation stays pending');
    const run = host.callTools({ name: 'ffgrep', arguments: { pattern: 'needle', path: root } });
    await gate.wait(() => fake.created.some(r => r.basePath === root), 'aux creation started');
    log('emitting real session_shutdown while the aux creation is still pending');
    await host.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    release(); await run;
    const late = fake.created.find(r => r.basePath === root);
    assert.equal(late.destroyed, true, 'late aux finder created after shutdown was published into the pool and never destroyed');
  });
});

test('D15 (main): session_start ensureFinder pending -> shutdown -> late main finder must be destroyed', { timeout: 120000, todo: 'known-upstream @ff-labs/pi-fff 0.11.0 (D15): no shutdown generation fence; a late-resolving finder is published and never destroyed; third-party snapshot is not modified here' }, async () => {
  await scenario('main', 'main', async ({ env, host, fake, gate, release }) => {
    const binding = host.bind();
    await gate.wait(() => fake.created.some(r => r.basePath === env.cwd), 'main finder creation started');
    log('emitting real session_shutdown while ensureFinder(cwd) is pending');
    await host.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    release(); await binding;
    const late = fake.created.find(r => r.basePath === env.cwd);
    assert.equal(late.destroyed, true, 'main finder resolved after shutdown was published into mainFinder and never destroyed');
  });
});
