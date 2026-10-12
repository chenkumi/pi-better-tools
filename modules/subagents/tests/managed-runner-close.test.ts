import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { runSingleAgent } from '../extensions/subagent/index.ts';
import { ManagedSession, snapshotConfig, canonicalCwd } from '../extensions/subagent/session-store.ts';

for (const mode of ['control', 'dispatch-close', 'begin-close', 'metadata-close', 'aggregate-close']) {
  for (const late of mode === 'control' ? [false] : [false, true]) test(`runner ${mode} late=${late} keeps unsafe managed ownership after all gates settle`, async t => {
    const root = await canonicalCwd(await fs.promises.mkdtemp(join(tmpdir(), 'managed-runner-close-')));
    const filePath = join(root, 'agent.md'); await fs.promises.writeFile(filePath, 'offline source');
    const agent = { name: 'worker', description: 'offline', source: 'bundled' as const, filePath, systemPrompt: 'offline' };
    const config = { ...await snapshotConfig(agent, 'user', root, 'offline/model', 'off', false), childTrusted: false };
    const managed = await ManagedSession.allocate(join(root, 'managed'), { parentSessionId: 'owner', parentCwd: root }, config);
    const registry = (globalThis as any)[Symbol.for('pi-better-tools.subagents.live-writer-locks')] as Set<string>, before = new Set(registry);
    let actualClose: (() => Promise<void>) | undefined, retained: fs.promises.FileHandle | undefined, faults = 0, spawns = 0, owned: Promise<void> | undefined;
    let enter!: () => void, unblock!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { unblock = resolve; });
    const controller = new AbortController(), open = fs.promises.open.bind(fs.promises);
    t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await open(...args), path = String(args[0]);
      if ((['begin-close', 'metadata-close'].includes(mode) && /run\.json\..*\.partial$/.test(path)) || (mode === 'aggregate-close' && path === managed.logPath) || (mode === 'dispatch-close' && path.startsWith(join(managed.directory, 'dispatch')) && args[1] === 'wx')) {
        let text = ''; const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        t.mock.method(handle, 'writeFile', async (...values: Parameters<typeof write>) => { text += String(values[0]); return write(...values); });
        t.mock.method(handle, 'close', async () => {
          if (faults === 0 && (mode === 'aggregate-close' || mode === 'dispatch-close' || text.includes(mode === 'begin-close' ? '"running"' : '"committing"'))) {
            faults++; retained = handle; actualClose = close; enter();
            if (late) await blocked;
            throw new Error(`injected ${mode} close EIO`);
          }
          return close();
        });
      }
      return handle;
    });
    t.mock.method(childProcess, 'spawn', (_command: string, _args: string[], options: any) => {
      spawns++;
      const stdout = new PassThrough(), stderr = new PassThrough();
      const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null, kill: () => true });
      setImmediate(() => { void (async () => {
        const guard = JSON.parse(options.env.PI_SUBAGENTS_GUARD);
        await fs.promises.writeFile(guard.startupPath, JSON.stringify({ version: 1, id: guard.id, cwd: guard.cwd, model: 'offline/model', thinkingLevel: 'off', childTrusted: false }));
        const user = { role: 'user', content: 'Task: test', timestamp: 1 }, assistant = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: 2 };
        let leaf: string | null = null;
        const entry = (type: string, data: any) => { const id = ulid().toUpperCase(), e = { type, id, parentId: leaf, ...data }; leaf = id; return e; };
        const header = { type: 'session', version: 3, id: managed.id, cwd: root };
        await fs.promises.writeFile(join(managed.directory, 'pi', 'native.jsonl'), [header, entry('model_change', { provider: 'offline', modelId: 'model' }), entry('thinking_level_change', { thinkingLevel: 'off' }), entry('message', { message: user }), entry('message', { message: assistant })].map(e => JSON.stringify(e)).join('\n') + '\n');
        stdout.end([header, { type: 'message_end', message: user }, { type: 'message_end', message: assistant }, { type: 'agent_settled' }].map(e => JSON.stringify(e)).join('\n') + '\n');
        stderr.end(); proc.exitCode = 0; proc.emit('close', 0, null);
      })().catch(error => { proc.emit('error', error); proc.emit('close', 1, null); }); });
      return proc;
    });
    syncBuiltinESMExports();
    try {
      const work = runSingleAgent(root, { model: 'offline/model', thinkingLevel: 'off', modelWasExplicit: true, thinkingLevelWasExplicit: true }, [agent], 'worker', 'test', root, undefined, controller.signal, undefined,
        results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }), 'owner', `close-${mode}-${late}`,
        { allocatedSession: managed, debugLog: false, invocation: args => ({ command: 'fake-offline-child', args }), onOwnedSettlement: value => { owned = value; } });
      if (late) { await entered; controller.abort(); }
      const result = await work;
      if (late) { await fs.promises.stat(join(managed.directory, 'writer.lock')); unblock(); }
      await owned;
      if (mode === 'control') {
        assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.canResume, true);
        await assert.rejects(fs.promises.stat(join(managed.directory, 'writer.lock')), { code: 'ENOENT' });
      } else {
        assert.equal(result.canResume, false); assert.notEqual(result.status, 'completed'); assert.equal(faults, 1);
        await retained!.stat(); await fs.promises.stat(join(managed.directory, 'writer.lock'));
        assert.equal(spawns, ['begin-close', 'dispatch-close'].includes(mode) ? 0 : 1);
        assert.equal(managed.writerCloseConfirmed, false);
        await assert.rejects(managed.release(), /injected .* close EIO/);
        const other = await ManagedSession.resolve(managed.root, managed.id, managed.manifest.owner);
        await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
      }
    } finally {
      unblock(); if (owned) await owned.catch(() => {});
      t.mock.restoreAll(); syncBuiltinESMExports(); await actualClose?.();
      if (retained) await assert.rejects(retained.stat(), /closed|EBADF/);
      await fs.promises.rm(root, { recursive: true, force: true });
      for (const nonce of registry) if (!before.has(nonce)) {
        registry.delete(nonce);
        ((globalThis as any)[Symbol.for('pi-better-tools.subagents.unsafe-writer-handles')] as Map<string, unknown> | undefined)?.delete(nonce);
      }
    }
  });
}
