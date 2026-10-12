import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ulid } from 'ulid';

const repo = process.cwd();
const evidence = resolve(repo, 'plan/review-20261012-evidence/verify-subagents');
globalThis.fetch = async () => { throw new Error('Network forbidden in offline probe'); };
const moduleUrl = (name: string) => pathToFileURL(resolve(repo,
  'modules/subagents/extensions/subagent', name)).href;

for (const mode of [process.env.PROBE_MODE ?? 'control']) {
  assert.ok(['control', 'large-text', 'metadata-close', 'aggregate-close', 'begin-close'].includes(mode));
  test(mode, { timeout: 20000 }, async t => {
    const root = await fs.promises.mkdtemp(join(evidence, 'subagents-probe-'));
    const savedEnv = { ...process.env };
    for (const [key, value] of Object.entries({ HOME: root, USERPROFILE: root,
      PI_CODING_AGENT_DIR: join(root, 'config'), TMP: root, TEMP: root, TMPDIR: root,
      PI_OFFLINE: '1', PI_BLACKHOLE_PASSIVE: 'true' })) process.env[key] = value;
    delete process.env.PI_SUBAGENTS_GUARD;
    const progress = setInterval(() => console.log(`Progress: ${mode} running`), 1000);
    let actualClose: (() => Promise<void>) | undefined;
    let retained: fs.promises.FileHandle | undefined;
    let managed: any;
    let owned: Promise<void> | undefined;
    let closeFaults = 0;
    let settled = false;
    let stats: any;
    let spawnCount = 0;
    let injectedPath: string | undefined;
    console.log(`Progress: ${mode} started pid=${process.pid}`);
    try {
      const { runSingleAgent } = await import(moduleUrl('index.ts'));
      const { ManagedSession, snapshotConfig, canonicalCwd } =
        await import(moduleUrl('session-store.ts'));
      const cwd = await canonicalCwd(root);
      const filePath = join(root, 'agent.md');
      await fs.promises.writeFile(filePath, 'offline source');
      const agent = { name: 'worker', description: 'offline', source: 'bundled',
        filePath, systemPrompt: 'Offline test; no models.' };
      const config = { ...await snapshotConfig(agent, 'user', cwd,
        'offline/model', 'off', false), childTrusted: false };
      managed = await ManagedSession.allocate(join(root, 'managed'),
        { parentSessionId: 'isolated-parent', parentCwd: cwd }, config);
      const nativeOpen = fs.promises.open;
      t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof nativeOpen>) => {
        const handle = await nativeOpen(...args);
        const path = String(args[0]);
        const runMetadata = path.includes(`${join('runs', '')}`) &&
          /run\.json\..*\.partial$/.test(path);
        const aggregate = path === join(managed.directory, 'transcript.jsonl');
        if (((mode === 'metadata-close' || mode === 'begin-close') && runMetadata) ||
            (mode === 'aggregate-close' && aggregate)) {
          let text = '';
          const write = handle.writeFile.bind(handle);
          const close = handle.close.bind(handle);
          t.mock.method(handle, 'writeFile', async (...a: any[]) => {
            text += String(a[0]);
            return write(...a as Parameters<typeof write>);
          });
          t.mock.method(handle, 'close', async () => {
            const target = mode === 'aggregate-close' || (mode === 'begin-close' ? text.includes('"running"') : text.includes('"committing"'));
            if (target && closeFaults === 0) {
              closeFaults++; retained = handle; actualClose = close; injectedPath = path;
              console.log(`Progress: injected close fault on real handle fd=${handle.fd}`);
              throw Object.assign(new Error(`injected ${mode} EIO`), { code: 'EIO' });
            }
            await close();
          });
        }
        return handle;
      });
      t.mock.method(childProcess, 'spawn', (_command: string, args: string[], opts: any) => {
        assert.equal(_command, 'fake-offline-child'); spawnCount++;
        const stdout = new PassThrough(), stderr = new PassThrough();
        const proc = Object.assign(new EventEmitter(), { stdout, stderr,
          exitCode: null as number | null, signalCode: null, kill: () => true });
        setImmediate(() => { void (async () => {
          const guard = JSON.parse(opts.env.PI_SUBAGENTS_GUARD);
          const taskId = args[args.indexOf('--session-id') + 1];
          assert.equal(taskId, managed.id);
          await fs.promises.writeFile(guard.startupPath, JSON.stringify({ version: 1,
            id: guard.id, cwd: guard.cwd, model: 'offline/model',
            thinkingLevel: 'off', childTrusted: false }));
          const user = { role: 'user', content: 'Task: test', timestamp: 1 };
          const assistant = { role: 'assistant', content: [{ type: 'text',
            text: mode === 'large-text' ? 'x'.repeat(1100000) : 'done' }],
            stopReason: 'stop', timestamp: 2 };
          let leaf: string | null = null;
          const entry = (type: string, data: any) => {
            const id = ulid().toUpperCase();
            const e = { type, id, parentId: leaf,
              timestamp: new Date().toISOString(), ...data }; leaf = id; return e;
          };
          const header = { type: 'session', version: 3, id: managed.id, cwd };
          await fs.promises.writeFile(join(managed.directory, 'pi/native.jsonl'),
            [header, entry('model_change', { provider: 'offline', modelId: 'model' }),
             entry('thinking_level_change', { thinkingLevel: 'off' }),
             entry('message', { message: user }), entry('message', { message: assistant })]
              .map(e => JSON.stringify(e)).join('\n') + '\n');
          const events = [header, { type: 'message_end', message: user },
            { type: 'message_end', message: assistant }, { type: 'agent_settled' }];
          stdout.end(events.map(e => JSON.stringify(e)).join('\n') + '\n');
          stderr.end(); proc.exitCode = 0; proc.emit('close', 0, null);
        })().catch(error => { stdout.destroy(); stderr.destroy();
          proc.emit('error', error); proc.emit('close', 1, null); }); });
        return proc;
      });
      syncBuiltinESMExports();
      const result = await runSingleAgent(cwd,
        { model: 'offline/model', thinkingLevel: 'off',
          modelWasExplicit: true, thinkingLevelWasExplicit: true },
        [agent], 'worker', 'test', cwd, undefined, t.signal, undefined,
        (results: any[]) => ({ mode: 'single', agentScope: 'user',
          projectAgentsDir: null, results }), 'isolated-parent', `probe-${mode}`,
        { allocatedSession: managed, debugLog: false,
          onResourceStats: (value: any) => { stats = value; },
          invocation: (args: string[]) => ({ command: 'fake-offline-child', args }),
          onOwnedSettlement: (value: Promise<void>) => { owned = value; } });
      await owned; settled = true;
      const lockPresent = await fs.promises.stat(join(managed.directory, 'writer.lock'))
        .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      const handleStillOpen = retained ? await retained.stat().then(() => true) : false;
      console.log(JSON.stringify({ mode, status: result.status,
        canResume: result.canResume, logError: result.logError,
        errorMessage: result.errorMessage, closeFaults, lockPresent, handleStillOpen, injectedPath,
        stats, spawnCount, manifestState: managed.manifest.state, ownedSettled: settled }));
      if (mode === 'large-text') {
        assert.equal(result.status, 'failed');
        assert.equal(result.errorMessage, 'Subagent stdout processing failed: Sub-session log record exceeds writer capacity');
        assert.match(result.logError ?? '', /Sub-session logging interrupted/);
        assert.equal(managed.manifest.state, 'blocked');
        assert.ok(stats.maxStdoutRecordBytes > 1048576 && stats.maxStdoutRecordBytes < 8388608);
        assert.equal(result.canResume, false);
      } else if (mode === 'control') {
        assert.equal(result.status, 'completed'); assert.equal(result.canResume, true);
        assert.equal(managed.manifest.state, 'ready'); assert.equal(lockPresent, false);
        assert.equal(closeFaults, 0); assert.equal(spawnCount, 1);
      } else {
        assert.equal(result.status, 'failed');
        assert.match((result.logError ?? '') + (result.errorMessage ?? ''), /injected .* EIO/);
        assert.equal(spawnCount, mode === 'begin-close' ? 0 : 1);
        assert.equal(closeFaults, 1); assert.equal(handleStillOpen, true);
        // Candidate characterization, not the desired regression behavior.
        assert.equal(lockPresent, false, 'candidate predicts premature writer lock removal');
      }
    } finally {
      clearInterval(progress);
      t.mock.restoreAll(); syncBuiltinESMExports();
      await actualClose?.();
      if (retained) { await assert.rejects(retained.stat(), /closed|EBADF/i); console.log('Progress: retained handle realclose verified'); }
      if (settled) { await managed?.release();
        await fs.promises.rm(root, { recursive: true, force: true });
        await assert.rejects(fs.promises.stat(root), { code: 'ENOENT' }); }
      process.env = savedEnv;
      console.log(`Progress: ${mode} finished; sandbox ${settled ? 'removed' : 'retained'}`);
    }
  });
}