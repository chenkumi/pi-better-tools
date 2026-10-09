import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { runSingleAgent } from '../extensions/subagent/index.ts';
import { discoverAgents } from '../extensions/subagent/agents.ts';
import { ManagedSession } from '../extensions/subagent/session-store.ts';
import { runReadyQuery } from '../extensions/subagent/ready-query.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-ready-query-')));
  const config = { sessionRootDir: join(root, 'managed'), projectTrusted: false, debugLog: false,
    invocation: (args: string[]) => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/managed-native.mjs', import.meta.url)), 'normal', ...args] }) };
  const result = await runSingleAgent(root, { model: 'offline-fixture/model', thinkingLevel: 'off', modelWasExplicit: true, thinkingLevelWasExplicit: true }, discoverAgents(root, 'user').agents, 'worker', 'retained evidence', root, undefined, undefined, undefined,
    results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }), 'owner', 'create', config);
  assert.equal(result.canResume, true, JSON.stringify(result));
  const owner = { parentSessionId: 'owner', parentCwd: root };
  const session = await ManagedSession.resolve(config.sessionRootDir, result.subagentSessionId!, owner);
  const capture = async () => Promise.all([join(session.directory, 'manifest.json'), session.logPath, join(session.directory, session.manifest.nativeFile!)].map(path => readFile(path)));
  return { root, session, capture, close: () => rm(root, { recursive: true, force: true }) };
}

test('ready query lease freezes exact committed bytes without changing manifest/native/transcript or recovering stale writers', async () => {
  const f = await fixture();
  try {
    const before = await f.capture();
    await (f.session as any).acquireQueryLease(ulid().toUpperCase());
    const bytes = await (f.session as any).readQuerySnapshot();
    assert.deepEqual(bytes, before[2]);
    assert.deepEqual(await f.capture(), before);
    const another = await ManagedSession.resolve(f.session.root, f.session.id, f.session.manifest.owner);
    await assert.rejects(another.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
    await assert.rejects((another as any).acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
    await f.session.release();
    await assert.rejects(stat(join(f.session.directory, 'writer.lock')), { code: 'ENOENT' });
    assert.deepEqual(await f.capture(), before);
    await mkdir(join(f.session.directory, 'writer.lock'));
    await writeFile(join(f.session.directory, 'writer.lock', 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'not-live', taskId: ulid().toUpperCase() }));
    await assert.rejects((another as any).acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/, 'query never rolls back or takes over even a stale writer');
    assert.deepEqual(await f.capture(), before);
  } finally { await f.session.release(); await f.close(); }
});

for (const fault of ['invalid-json', 'forbidden-mainline', 'invalid-json-tail', 'forbidden-mainline-tail']) test(`ready query cannot report completed after post-answer ${fault}`, async () => {
  const f = await fixture();
  let releases = 0;
  const notices: any[] = [];
  try {
    const before = await f.capture();
    const queryId = ulid().toUpperCase();
    await f.session.acquireQueryLease(queryId);
    const result = await runReadyQuery({ session: f.session, snapshot: await f.session.readQuerySnapshot(), queryId, question: 'read-only question', signal: new AbortController().signal,
      invocation: args => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/ready-query-fault.mjs', import.meta.url)), fault, ...args] }),
      acquireChild: async () => () => { releases++; }, validate: async () => {}, onInteractive: () => {}, onInteraction: notice => { notices.push({ ...notice, releasedAt: releases }); } });
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.usage && (result.usage as any).totalTokens, 7);
    assert.equal(result.output, undefined, 'a confirmed protocol fault cannot preserve a successful answer');
    assert.equal(result.cleanupPending, false);
    assert.ok(notices.length > 0); assert.ok(notices.every(n => n.status === 'failed'));
    assert.ok(notices.filter(n => n.cleanupPending).every(n => n.releasedAt === 0));
    assert.equal(releases, 1);
    assert.deepEqual(await f.capture(), before);
  } finally { await f.session.release(); await f.close(); }
});

for (const fault of ['startup-invalid-json', 'startup-mainline']) test(`ready query rejects ${fault} before interactive/provider admission`, async () => {
  const f = await fixture(); let interactive = 0, releases = 0, faultObserved!: () => void;
  const faultBarrier = new Promise<void>(resolve => { faultObserved = resolve; }); let validations = 0;
  try {
    const before = await f.capture(), queryId = ulid().toUpperCase();
    await f.session.acquireQueryLease(queryId);
    const result = await runReadyQuery({ session: f.session, snapshot: await f.session.readQuerySnapshot(), queryId, question: 'must not be dispatched', signal: new AbortController().signal,
      invocation: args => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/ready-query-fault.mjs', import.meta.url)), fault, ...args] }),
      acquireChild: async () => () => { releases++; }, validate: async () => { if (++validations > 1) await faultBarrier; },
      onInteractive: () => { interactive++; }, onInteraction: notice => { if (notice.status === 'failed') faultObserved(); } });
    assert.equal(result.status, 'failed'); assert.equal(result.output, undefined);
    assert.equal(interactive, 0, 'a failed startup must never activate the query handle');
    assert.equal(existsSync(join(f.root, 'query-request-seen')), false, 'no query IPC may reach the fixture after startup fault');
    assert.equal(releases, 1); assert.deepEqual(await f.capture(), before);
  } finally { await f.session.release(); await f.close(); }
});

test('owner cancellation inside attachment callback never sends query IPC', async () => {
  const f = await fixture(), controller = new AbortController(); let attached = 0, releases = 0;
  try {
    const before = await f.capture(), queryId = ulid().toUpperCase();
    await f.session.acquireQueryLease(queryId);
    const result = await runReadyQuery({ session: f.session, snapshot: await f.session.readQuerySnapshot(), queryId, question: 'must not dispatch after callback cancellation', signal: controller.signal,
      invocation: args => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/ready-query-fault.mjs', import.meta.url)), 'clean', ...args] }),
      acquireChild: async () => () => { releases++; }, validate: async () => {},
      onInteractive: () => { attached++; controller.abort(); }, onInteraction: () => {} });
    assert.equal(attached, 1); assert.equal(result.status, 'aborted'); assert.equal(result.output, undefined);
    assert.equal(result.usageUnknown, true, 'no request was sent; do not invent terminal usage');
    assert.equal(existsSync(join(f.root, 'query-request-seen')), false);
    assert.equal(result.cleanupPending, false); assert.equal(releases, 1);
    assert.deepEqual(await f.capture(), before);
  } finally { await f.session.release(); await f.close(); }
});

for (const scenario of ['held-close', 'held-cleanup', 'cleanup-failed']) test(`ready query reports truthful ${scenario} evidence without releasing active work`, async () => {
  const f = await fixture(); let releases = 0, privateDirectory: string | undefined;
  const notices: any[] = [];
  let entered!: () => void, release!: () => void;
  const cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
  const cleanupRelease = new Promise<void>(resolve => { release = resolve; });
  try {
    const before = await f.capture(), queryId = ulid().toUpperCase();
    await f.session.acquireQueryLease(queryId);
    const work = runReadyQuery({ session: f.session, snapshot: await f.session.readQuerySnapshot(), queryId, question: 'probe', signal: new AbortController().signal,
      invocation: args => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/ready-query-fault.mjs', import.meta.url)), scenario === 'held-close' ? 'hold-fault' : scenario === 'held-cleanup' ? 'forbidden-mainline' : 'clean', ...args] }),
      acquireChild: async () => () => { releases++; }, validate: async () => {}, onInteractive: () => {},
      onInteraction: notice => {
        notices.push({ ...notice, releasedAt: releases });
        if (scenario === 'held-close' && notice.cleanupPending) writeFileSync(join(f.root, 'release-query-close'), 'confirmed pending before close');
      },
      ...(scenario === 'held-close' ? {} : { removeTemporary: async (directory: string) => {
        privateDirectory = directory; entered();
        if (scenario === 'cleanup-failed') throw new Error('EACCES: private copies could not be removed');
        await cleanupRelease; await rm(directory, { recursive: true, force: true });
      } }) });
    if (scenario === 'held-cleanup') {
      await cleanupEntered;
      assert.equal(releases, 0); assert.ok(existsSync(join(f.session.directory, 'writer.lock')));
      assert.ok(notices.some(n => n.cleanupPending && n.status === 'failed'));
      release();
    }
    const result = await work;
    assert.equal(result.status, 'failed'); assert.equal((result.usage as any).totalTokens, 7);
    assert.equal(result.cleanupPending, scenario === 'cleanup-failed');
    assert.equal((result.cleanupEvidence as any).childClosed, true);
    assert.equal((result.cleanupEvidence as any).ioSettled, true);
    assert.equal((result.cleanupEvidence as any).temporaryRemoved, scenario !== 'cleanup-failed');
    if (scenario === 'held-close') assert.ok(notices.some(n => n.cleanupPending && !n.cleanupEvidence.childClosed && n.releasedAt === 0));
    assert.equal(releases, 1); assert.deepEqual(await f.capture(), before);
  } finally { release?.(); await f.session.release(); if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true }); await f.close(); }
});

test('ready query refuses checkpoint drift rather than reading changed history', async () => {
  const f = await fixture();
  try {
    await (f.session as any).acquireQueryLease(ulid().toUpperCase());
    await writeFile(join(f.session.directory, f.session.manifest.nativeFile!), 'changed\n');
    await assert.rejects((f.session as any).readQuerySnapshot(), /CHECKPOINT_MISMATCH/);
  } finally { await f.session.release(); await f.close(); }
});
