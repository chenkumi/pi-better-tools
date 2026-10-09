import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPiFixture } from './helpers/pi-fixture.mjs';
import { execMonitorCommand } from '../src/monitor-exec.ts';

test('review adapter W2: actual offline Pi effective shellPath/prefix/trust plus pre-spawn and running cancellation/close barriers', async () => {
  const fixture = await createPiFixture(); const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Monitor exec integration external fetch forbidden'); };
  try {
    const sdk = fixture.sdk; assert.equal(sdk.VERSION, '1.1.0');
    for (const trusted of [false, true]) {
      console.log(`[monitor-exec-host] Checking actual effective settings, projectTrusted=${trusted}`);
      const shell = sdk.getShellConfig().shell;
      const host = await fixture.createSession({ loadOverride: false, tools: [], disk: true, trusted,
        globalSettings: { shellPath: pathToFileURL(shell).href, shellCommandPrefix: 'export MONITOR_EFFECTIVE_PREFIX=global' },
        projectSettings: { shellPath: pathToFileURL(shell).href, shellCommandPrefix: 'export MONITOR_EFFECTIVE_PREFIX=project' } });
      let pi;
      const loader = new sdk.DefaultResourceLoader({ cwd: host.cwd, agentDir: fixture.agentDir, settingsManager: host.settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [api => { pi = api; }] });
      await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(fixture.agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      const { session } = await sdk.createAgentSession({ cwd: host.cwd, agentDir: fixture.agentDir, settingsManager: host.settingsManager, resourceLoader: loader, modelRuntime, tools: [], sessionManager: sdk.SessionManager.inMemory(host.cwd) });
      await session.bindExtensions({});
      try {
        const ctx = session.extensionRunner.createToolContext('monitor-exec-contract', undefined);
        let output = '', diagnostic = '', closeCount = 0, spawnedShell;
        const events = { stdout: b => { output += b.toString(); }, stderr: b => { diagnostic += b.toString(); }, started() {}, closed: (code, signal, spawnError) => { closeCount++; assert.equal(code, 0); assert.equal(signal, null); assert.equal(spawnError, false); } };
        const seam = { spawn: (file, ...args) => { spawnedShell = file; return spawn(file, ...args); } };
        await execMonitorCommand(pi, ctx, 'bash', 'printf "%s" "$MONITOR_EFFECTIVE_PREFIX"; printf diagnostic >&2', new AbortController().signal, events, seam);
        assert.equal(output, trusted ? 'project' : 'global'); assert.equal(diagnostic, 'diagnostic'); assert.equal(closeCount, 1); assert.equal(spawnedShell, shell);
        host.settingsManager.applyOverrides({ shellCommandPrefix: 'export MONITOR_EFFECTIVE_PREFIX=memory' }); output = ''; diagnostic = '';
        await execMonitorCommand(pi, ctx, 'bash', 'printf "%s" "$MONITOR_EFFECTIVE_PREFIX"', new AbortController().signal, events); assert.equal(output, 'memory');
        let preSpawns = 0; const pre = new AbortController(); pre.abort();
        await execMonitorCommand(pi, ctx, 'bash', 'MUST_NOT_SPAWN', pre.signal, { ...events, closed: () => {} }, { spawn: () => { preSpawns++; throw new Error('MUST_NOT_SPAWN'); } }); assert.equal(preSpawns, 0);
        const controller = new AbortController(); let ready, closed = false, settled = false;
        const barrier = new Promise(r => { ready = r; });
        const pending = execMonitorCommand(pi, ctx, 'bash', 'node -e "console.log(\'MONITOR_ABORT_READY\');setInterval(()=>{},1000)"', controller.signal,
          { stdout: b => { if (b.toString().includes('MONITOR_ABORT_READY')) ready(); }, stderr() {}, started() {}, closed: (_code, _signal, spawnError) => { assert.equal(spawnError, false); closed = true; } }).then(() => { settled = true; });
        await barrier; assert.equal(closed, false); controller.abort(); assert.equal(closed, false, 'request is not close'); assert.equal(settled, false); await pending; assert.equal(closed, true);
      } finally { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    }
  } finally { globalThis.fetch = previousFetch; fixture.cleanup(); }
});
