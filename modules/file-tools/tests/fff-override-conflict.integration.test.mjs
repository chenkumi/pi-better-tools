// Real Pi 1.1.0 + pinned FFF 0.11.0, real manifest order and native finder.
// Isolated HOME/agentDir/config/data; no fake SDK or external provider requests.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHost, entry, heartbeat, isolate, log, manifest, text } from '../../../tests/helpers/regression/host.mjs';

for (const [label, config] of [['default without pi-fff.json', null], ['explicit override file', { mode: 'override' }]]) test(`FFF override owns and executes grep/find before and after reload (${label})`, { timeout: 120000 }, async () => {
  const env = await isolate('fff-override'); const stop = heartbeat('FFF override'); let host;
  try {
    if (config) await writeFile(join(env.agentDir, 'pi-fff.json'), JSON.stringify(config));
    await writeFile(join(env.cwd, 'override-marker.txt'), 'FFF_OVERRIDE_MARKER\n');
    const wanted = ['./modules/file-tools/src/index.ts', './modules/file-tools/src/fff-override.mjs'];
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

test('explicit tools-only file mode is not replaced by the override default', { timeout: 120000 }, async () => {
  const env = await isolate('fff-tools-only'); const stop = heartbeat('FFF tools-only'); let host;
  try {
    await writeFile(join(env.agentDir, 'pi-fff.json'), JSON.stringify({ mode: 'tools-only' }));
    host = await createHost({ env, extensionPaths: ['./modules/file-tools/src/index.ts', './modules/file-tools/src/fff-override.mjs'].map(entry) });
    await host.bind();
    assert.deepEqual(host.loadErrors(), []); assert.deepEqual(host.errors, []);
    const names = host.session.getAllTools().map(tool => tool.name);
    for (const name of ['ffgrep', 'fffind']) assert.ok(names.includes(name), `${name} registered in tools-only`);
    const grep = host.session.getAllTools().find(tool => tool.name === 'grep');
    assert.notEqual(grep?.sourceInfo?.path, entry('./modules/file-tools/src/fff-override.mjs'));
    log('explicit tools-only mode preserved');
  } finally {
    try { await host?.close(); } finally { stop(); await env.cleanup(); }
  }
});
