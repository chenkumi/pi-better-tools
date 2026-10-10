// Real Pi 1.1.0 + pinned FFF 0.11.0, real manifest order and native finder.
// Isolated HOME/agentDir/config/data; no fake SDK or external provider requests.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHost, entry, heartbeat, isolate, log, manifest, text } from '../../../tests/helpers/regression/host.mjs';

test('FFF override owns and executes grep/find before and after reload', { timeout: 120000 }, async () => {
  const env = await isolate('fff-override'); const stop = heartbeat('FFF override'); let host;
  try {
    await writeFile(join(env.agentDir, 'pi-fff.json'), JSON.stringify({ mode: 'override' }));
    await writeFile(join(env.cwd, 'override-marker.txt'), 'FFF_OVERRIDE_MARKER\n');
    const wanted = ['./modules/file-tools/src/index.ts', './node_modules/@ff-labs/pi-fff/src/index.ts'];
    const order = (await manifest()).pi.extensions.filter(item => wanted.includes(item));
    assert.deepEqual(order, wanted, 'manifest retains File Tools before FFF');
    host = await createHost({ env, extensionPaths: order.map(entry) });
    await host.bind();
    for (const phase of ['startup', 'reload']) {
      if (phase === 'reload') await host.session.reload();
      assert.deepEqual(host.loadErrors(), []); assert.deepEqual(host.errors, []);
      const fileExtension = host.loader.getExtensions().extensions.find(ext => ext.path === entry(wanted[0]));
      assert.ok(fileExtension);
      assert.deepEqual([...fileExtension.tools.keys()], ['read', 'write', 'edit', 'ls']);
      const active = host.session.getActiveToolNames(), callable = host.session.getCallableToolNames();
      for (const name of ['grep', 'find']) {
        const tool = host.session.getAllTools().find(tool => tool.name === name);
        assert.equal(tool?.sourceInfo?.path, entry(wanted[1]), `${phase}: ${name} must be FFF, not builtin/File Tools`);
        assert.ok(active.includes(name)); assert.ok(callable.includes(name));
      }
      for (const name of ['ffgrep', 'fffind']) assert.ok(!active.includes(name), `${phase}: stale FFF alias ${name} inactive`);
      const results = await host.callTools(
        { name: 'grep', arguments: { pattern: 'FFF_OVERRIDE_MARKER' } },
        { name: 'find', arguments: { pattern: 'override-marker.txt' } },
      );
      assert.equal(results.length, 2);
      for (const result of results) { assert.ok(!result.isError, text(result)); assert.match(text(result), /override-marker\.txt/); }
      assert.match(text(results.find(result => result.toolName === 'grep')), /FFF_OVERRIDE_MARKER/);
      log(`${phase}: FFF native grep/find ownership and execution passed`);
    }
  } finally {
    try { await host?.close(); } finally { stop(); await env.cleanup(); }
  }
});
