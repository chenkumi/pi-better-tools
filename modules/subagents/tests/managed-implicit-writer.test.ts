import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { ManagedSession, ConversationDigest, snapshotConfig, canonicalCwd } from '../extensions/subagent/session-store.ts';

for (const stage of ['dispatch', 'native-truncate', 'aggregate-truncate'] as const) {
  for (const recovery of stage === 'dispatch' ? [false] : [false, true]) for (const late of [false, true]) test(`managed ${stage} close failure late=${late} recovery=${recovery} retains real resource and ownership`, async t => {
    const root = await canonicalCwd(await fs.promises.mkdtemp(join(tmpdir(), 'managed-implicit-')));
    const source = join(root, 'agent.md'); await fs.promises.writeFile(source, 'offline');
    const config = { ...await snapshotConfig({ name: 'worker', description: 'offline', source: 'bundled', filePath: source, systemPrompt: 'offline' }, 'user', root, 'offline/model', 'off', false), childTrusted: false };
    let s = await ManagedSession.allocate(join(root, 'managed'), { parentSessionId: 'owner', parentCwd: root }, config);
    const registry = (globalThis as any)[Symbol.for('pi-better-tools.subagents.live-writer-locks')] as Set<string>, before = new Set(registry);
    const taskId = ulid().toUpperCase(), nativeFile = join(s.directory, 'pi', 'native.jsonl');
    const open = fs.promises.open.bind(fs.promises), writeFile = fs.promises.writeFile.bind(fs.promises), truncate = fs.promises.truncate.bind(fs.promises);
    let retained: fs.promises.FileHandle | undefined, originalClose: (() => Promise<void>) | undefined;
    let entered!: () => void, unblock!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { unblock = resolve; });
    const isTarget = (file: string, flags: unknown) => stage === 'dispatch' ? file.includes(`${join(s.directory, 'dispatch')}`) && flags === 'wx' : flags === 'r+' && file === (stage === 'native-truncate' ? nativeFile : s.logPath);
    let operation: Promise<unknown> | undefined;
    try {
      await s.acquire(taskId);
      if (stage !== 'dispatch') {
        await s.begin(taskId, 'call', 'task', () => true);
        const user = { role: 'user', content: 'task' }, assistant = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' };
        let leaf: string | null = null;
        const e = (type: string, data: unknown) => { const id = ulid().toUpperCase(), value = { type, id, parentId: leaf, ...(data as object) }; leaf = id; return value; };
        await fs.promises.writeFile(nativeFile, [{ type: 'session', version: 3, id: s.id, cwd: root }, e('model_change', { provider: 'offline', modelId: 'model' }), e('thinking_level_change', { thinkingLevel: 'off' }), e('message', { message: user }), e('message', { message: assistant })].map(v => JSON.stringify(v)).join('\n') + '\n');
        const segment = join(s.runDir, 'transcript.jsonl'); await fs.promises.writeFile(segment, '{}\n');
        const digest = new ConversationDigest(); digest.add(user); digest.add(assistant);
        await s.commit(segment, digest, {}, () => true);
        await fs.promises.appendFile(nativeFile, 'uncommitted\n'); await fs.promises.appendFile(s.logPath, 'uncommitted\n');
        if (recovery) {
          await s.release();
          await fs.promises.mkdir(join(s.directory, 'writer.lock'));
          await fs.promises.writeFile(join(s.directory, 'writer.lock', 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: ulid().toUpperCase(), taskId }));
          s = await ManagedSession.resolve(s.root, s.id, s.manifest.owner);
        }
      }
      t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
        const h = await open(...args);
        if (!retained && isTarget(String(args[0]), args[1])) {
          const close = h.close.bind(h);
          t.mock.method(h, 'close', async () => { retained = h; originalClose = close; entered(); if (late) await barrier; throw new Error(`${stage} close EIO`); });
        }
        return h;
      });
      // Baseline path APIs hide their handles. This seam reproduces their real
      // open/write-or-truncate/close contract; after repair explicit handles use
      // the same open/close injector directly, without this compatibility seam.
      t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
        if (stage !== 'dispatch' || typeof args[0] !== 'string' || !args[0].startsWith(join(s.directory, 'dispatch'))) return writeFile(...args);
        const h = await fs.promises.open(args[0], 'wx', 0o600); try { await h.writeFile(args[1]); } finally { await h.close(); }
      });
      t.mock.method(fs.promises, 'truncate', async (...args: Parameters<typeof truncate>) => {
        if (!isTarget(String(args[0]), 'r+')) return truncate(...args);
        const h = await fs.promises.open(args[0], 'r+'); try { await h.truncate(args[1]); } finally { await h.close(); }
      });
      operation = stage === 'dispatch' ? s.begin(taskId, 'next-call', 'task', () => true) : recovery ? s.acquire(taskId) : s.rollbackToCheckpoint(() => true);
      void operation.catch(() => {});
      if (late) { await entry; assert.equal(s.writerCloseConfirmed, false, 'pending writable close is not ownership settlement'); await assert.rejects(s.release(), /not settled/); unblock(); }
      await assert.rejects(operation, /close EIO/);
      assert.ok(retained); await retained.stat();
      assert.equal(s.writerCloseConfirmed, false);
      await assert.rejects(s.release(), /close EIO/);
      await fs.promises.stat(join(s.directory, 'writer.lock'));
      assert.equal([...registry].filter(n => !before.has(n)).length, 1);
      const writers = (globalThis as any)[Symbol.for('pi-better-tools.subagents.unsafe-writer-handles')] as Map<string, { handle: fs.promises.FileHandle }[]>;
      assert.ok([...writers.values()].some(records => records.some(r => r.handle === retained)), 'owner retains actual unsafe handle');
      await assert.rejects(s.rollbackToCheckpoint(() => true), /close EIO/);
      const other = await ManagedSession.resolve(s.root, s.id, s.manifest.owner);
      await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
      await assert.rejects(other.acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
    } finally {
      unblock(); await operation?.catch(() => {}); t.mock.restoreAll(); await originalClose?.();
      if (retained) await assert.rejects(retained.stat(), /closed|EBADF/);
      await fs.promises.rm(root, { recursive: true, force: true });
      for (const n of registry) if (!before.has(n)) { registry.delete(n); ((globalThis as any)[Symbol.for('pi-better-tools.subagents.unsafe-writer-handles')] as Map<string, unknown> | undefined)?.delete(n); }
    }
  });
}
