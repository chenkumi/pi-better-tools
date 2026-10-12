import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { ManagedSession, ConversationDigest, canonicalCwd, snapshotConfig } from '../extensions/subagent/session-store.ts';

async function fixture() {
  const root = await canonicalCwd(await mkdtemp(join(tmpdir(), 'managed-writer-barrier-')));
  const filePath = join(root, 'agent.md'); await writeFile(filePath, 'source');
  const config = { ...await snapshotConfig({ name: 'worker', description: 'test', source: 'bundled', filePath, systemPrompt: 'test' }, 'user', root, 'offline/model', 'off', false), childTrusted: false };
  const session = await ManagedSession.allocate(join(root, 'managed'), { parentSessionId: 'owner', parentCwd: root }, config);
  return { root, session };
}
async function native(session: ManagedSession) {
  const user = { role: 'user', content: 'task' }, assistant = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' };
  let leaf: string | null = null;
  const entry = (type: string, data: any) => { const id = ulid().toUpperCase(), value = { type, id, parentId: leaf, ...data }; leaf = id; return value; };
  await appendFile(join(session.directory, 'pi', 'native.jsonl'), [
    { type: 'session', version: 3, id: session.id, cwd: session.manifest.config.cwd }, entry('model_change', { provider: 'offline', modelId: 'model' }),
    entry('thinking_level_change', { thinkingLevel: 'off' }), entry('message', { message: user }), entry('message', { message: assistant }),
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const segment = join(session.runDir, 'transcript.jsonl'); await writeFile(segment, '{}\n');
  const digest = new ConversationDigest(); digest.add(user); digest.add(assistant);
  return { segment, digest };
}

const stages = ['owner', 'begin-run', 'begin-manifest', 'committing-run', 'committing-manifest', 'aggregate', 'completed-run', 'ready-manifest', 'blocked-run', 'blocked-manifest', 'rollback'] as const;
for (const stage of stages) test(`all managed writer close barriers retain actual ${stage} handle and reject release/mutation`, async t => {
  const f = await fixture(), s = f.session, taskId = ulid().toUpperCase();
  const registry = (globalThis as any)[Symbol.for('pi-better-tools.subagents.live-writer-locks')] as Set<string>;
  const before = new Set(registry);
  const open = fs.promises.open.bind(fs.promises);
  let retained: fs.promises.FileHandle | undefined, originalClose: (() => Promise<void>) | undefined, closes = 0;
  let armed = false;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
    const h = await open(...args), file = String(args[0]); let state = '';
    if (armed && !retained && file.endsWith('.partial')) {
      const write = h.writeFile.bind(h);
      t.mock.method(h, 'writeFile', async (...values: Parameters<typeof write>) => { state = JSON.parse(String(values[0])).state ?? ''; return write(...values); });
    }
    const close = h.close.bind(h);
    t.mock.method(h, 'close', async () => {
      const kind = stage === 'owner' ? file.includes('owner.json.') : stage === 'aggregate' ? file === s.logPath : stage === 'rollback' ? file.includes('manifest.json.') && state === 'ready' :
        file.includes(stage.endsWith('-run') ? 'run.json.' : 'manifest.json.') && state === (stage.startsWith('begin') ? 'running' : stage.startsWith('committing') ? 'committing' : stage.startsWith('completed') ? 'completed' : stage.startsWith('ready') ? 'ready' : 'blocked');
      if (armed && !retained && kind) { retained = h; originalClose = close; closes++; throw new Error(`${stage} close unconfirmed`); }
      return close();
    });
    return h;
  });
  try {
    let operation: Promise<unknown>;
    if (stage === 'owner') { armed = true; operation = s.acquire(taskId); }
    else {
      await s.acquire(taskId);
      if (stage.startsWith('begin')) { armed = true; operation = s.begin(taskId, 'call', 'task', () => true); }
      else {
        await s.begin(taskId, 'call', 'task', () => true);
        const n = await native(s);
        if (stage === 'rollback') { await s.commit(n.segment, n.digest, {}, () => true); armed = true; operation = s.rollbackToCheckpoint(() => true); }
        else { armed = true; operation = stage.startsWith('blocked') ? s.blocked('COMMIT_FAILED', {}, () => true) : s.commit(n.segment, n.digest, {}, () => true); }
      }
    }
    await assert.rejects(operation, /close.*unconfirmed|unconfirmed.*close/);
    assert.ok(retained); await retained.stat(); assert.equal(closes, 1);
    await assert.rejects(s.release(), /close.*unconfirmed|unconfirmed.*close/);
    await stat(join(s.directory, 'writer.lock'));
    assert.equal([...registry].filter(id => !before.has(id)).length, 1);
    const disk = await readFile(join(s.directory, 'manifest.json'));
    await assert.rejects(s.blocked('COMMIT_FAILED', {}, () => true), /close.*unconfirmed|unconfirmed.*close/);
    await assert.rejects(s.rollbackToCheckpoint(() => true), /close.*unconfirmed|unconfirmed.*close/);
    assert.deepEqual(await readFile(join(s.directory, 'manifest.json')), disk);
    const other = await ManagedSession.resolve(s.root, s.id, s.manifest.owner);
    await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
    await assert.rejects(other.acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
  } finally {
    t.mock.restoreAll(); if (originalClose) { await originalClose(); await assert.rejects(retained!.stat(), /closed|EBADF/); }
    await rm(f.root, { recursive: true, force: true });
    for (const nonce of registry) if (!before.has(nonce)) {
      registry.delete(nonce);
      ((globalThis as any)[Symbol.for('pi-better-tools.subagents.unsafe-writer-handles')] as Map<string, unknown> | undefined)?.delete(nonce);
    }
  }
});
