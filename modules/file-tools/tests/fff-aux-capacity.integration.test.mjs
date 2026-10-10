// STATUS: todo / known-upstream (@ff-labs/pi-fff 0.11.0). Placed in file-tools only because tests/ has no auto-discovered integration directory; see report.
// D14: AuxFinderPool.acquire() counts only completed entries; slots are not reserved while FilePicker creation is awaited,
// so concurrent acquires for DIFFERENT roots exceed MAX_AUX (3).
// Level: real Pi 1.1.0 AgentSession + real pi-fff 0.11.0 (real tool path, real AuxFinderPool/FilePickerFactory). DEGRADED:
// the native FileFinder is a deferred-promise fake at the SDK boundary (waitForScan is the barrier); no native DLL.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { barrier, createHost, entry, heartbeat, isolate, log, turns } from '../../../tests/helpers/regression/host.mjs';
import { installFakeFffSdk } from '../../../tests/helpers/regression/fake-fff-sdk.mjs';

const MAX_AUX = 3; // exported constant of pi-fff/src/aux-finders.ts

test('D14: concurrent acquires for different roots must never exceed MAX_AUX live/pending finders', { timeout: 120000, todo: 'known-upstream @ff-labs/pi-fff 0.11.0 (D14): AuxFinderPool.acquire counts only completed entries, so concurrent different-root acquires exceed MAX_AUX; third-party snapshot is not modified here' }, async () => {
  const env = await isolate('d14-fff'); const stop = heartbeat('D14'); const gate = barrier();
  const gates = []; let open = false;
  const fake = installFakeFffSdk({ gate: record => { if (open || record.basePath === env.cwd) return undefined; return new Promise(resolve => { gates.push(resolve); }); }, onCreate: () => gate.poke() });
  let host;
  try {
    await writeFile(join(env.agentDir, 'pi-fff.json'), JSON.stringify({ mode: 'tools-only' }));
    host = await createHost({ env, extensionPaths: [entry('node_modules/@ff-labs/pi-fff/src/index.ts')] });
    await host.bind(); assert.deepEqual(host.loadErrors(), []);
    const roots = [];
    for (let i = 1; i <= MAX_AUX + 1; i++) { const root = join(env.home, 'roots', `r${i}`); await mkdir(root, { recursive: true }); roots.push(root); }
    const auxCreated = () => fake.created.filter(record => record.basePath !== env.cwd);
    log(`issuing ${roots.length} parallel searches over ${roots.length} distinct roots (MAX_AUX=${MAX_AUX})`);
    const run = host.callTools(...roots.map(root => ({ name: 'ffgrep', arguments: { pattern: 'needle', path: root } })));
    await gate.wait(() => auxCreated().length >= MAX_AUX, 'first MAX_AUX native creations started');
    await turns(300); // let every other pending acquire reach its create() call; scan barrier is still closed
    const concurrent = auxCreated().length;
    log(`native finders being created concurrently while all scans are pending: ${concurrent}`);
    open = true; for (const release of gates) release();
    // later gates (created after open) resolve immediately
    await run;
    const live = auxCreated().filter(record => !record.destroyed).length;
    log(`live (undestroyed) aux finders after completion: ${live}`);
    assert.ok(concurrent <= MAX_AUX, `concurrent aux creations ${concurrent} exceeded MAX_AUX=${MAX_AUX} (slots are not reserved before awaiting create)`);
    assert.ok(live <= MAX_AUX, `live aux finders ${live} exceeded MAX_AUX=${MAX_AUX}`);
  } finally {
    open = true; for (const release of gates) release();
    try { await host?.close(); } catch { /* ignore */ }
    fake.restore(); stop(); await env.cleanup();
  }
});
