// D03: a background observer worker started on branch A must not commit its result after the SAME
// SessionManager navigated to another leaf (branch B). Real AgentSession + real navigateTree + real Blackhole entry,
// worker provider held at a deferred barrier. PI_BLACKHOLE_PASSIVE=false (non-passive) is required here on purpose:
// the AGENTS.md default passive mode disables the observer, and this test must run the real background worker
// (offline scripted provider, isolated home/credentials, no real model). Asserts CORRECT behaviour; RED while the defect exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { makeHost, log, withLimit } from './fixtures/real-host.mjs';

async function scenario({ navigate, advance = false }) {
  let releaseWorker, workerStarted;
  const barrier = new Promise(resolve => { releaseWorker = resolve; });
  const started = new Promise(resolve => { workerStarted = resolve; });
  let workerCalls = 0;
  const streamSimple = (model, context) => {
    const stream = createAssistantMessageEventStream();
    const text = JSON.stringify(context.messages);
    const ids = [...text.matchAll(/Source entry id: ([0-9a-zA-Z]+)/g)].map(m => m[1]);
    // The bridge hands workers a messages-only context whose system message is the observer prompt.
    const isObserver = text.includes('You are the observation agent');
    const finish = message => { stream.push({ type: 'start', partial: { ...message, stopReason: 'pending' } }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); };
    const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (!isObserver) { finish({ ...base, content: [{ type: 'text', text: 'OFFLINE_OK' }], stopReason: 'stop' }); return stream; }
    workerCalls++; workerStarted();
    barrier.then(() => {
      if (workerCalls > 1 || ids.length === 0) return finish({ ...base, content: [{ type: 'text', text: 'done' }], stopReason: 'stop' });
      finish({ ...base, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_1', name: 'record_observations',
        arguments: { observations: [{ content: 'BRANCH_A_ONLY_OBSERVATION', relevance: 'high', sourceEntryIds: [ids.at(-1)] }], complete: true } }] });
    });
    return stream;
  };
  const host = await makeHost({ streamSimple, env: { PI_BLACKHOLE_PASSIVE: 'false' },
    globalBlackholeConfig: { memory: true, compaction: 'auto', observeAfterTokens: 1000, reflectAfterTokens: 200000, observerChunkMaxTokens: 50000 } });
  try {
    assert.deepEqual(host.loadErrors(), []);
    const notes = [];
    const uiContext = new Proxy({ notify: m => notes.push(m) }, { get: (t, k) => k in t ? t[k] : () => undefined });
    await host.session.bindExtensions({ uiContext, mode: 'json', onError: e => notes.push(`ERR ${e.error}`) });
    // Branch A: root (kept by both branches) then A-only turns.
    const root = host.user('shared root task');
    host.reply('shared root answer');
    const rootLeaf = host.sm.getLeafId();
    for (let i = 1; i <= 3; i++) { host.user(`A-only task ${i} ${'detail '.repeat(300)}`); host.reply(`A-only answer ${i} ${'detail '.repeat(300)}`); }
    const aLeaf = host.sm.getLeafId();
    log('D03 prompting on branch A (worker will block at provider barrier)');
    await withLimit(host.session.prompt('continue on A'), 60000, 'prompt');
    await withLimit(started, 60000, 'observer worker to reach provider barrier');
    if (advance) {
      log('D03 worker in flight; ordinary conversation advances the leaf on the same branch');
      host.user('ordinary follow-up on A'); host.reply('ordinary reply on A');
    }
    if (navigate) {
      log('D03 worker is in flight; navigating same SessionManager to branch B');
      await withLimit(host.session.navigateTree(rootLeaf, { summarize: false }), 60000, 'navigateTree');
      assert.equal(host.sm.getLeafId(), rootLeaf);
      assert.notEqual(rootLeaf, aLeaf);
    }
    const idsOnB = () => new Set(host.sm.getBranch().map(e => e.id));
    const omOnB = () => host.sm.getBranch().filter(e => e.type === 'custom' && String(e.customType).startsWith('om.'));
    log('D03 releasing deferred worker provider');
    releaseWorker();
    // Poll the real session for the commit; upper bound only (no fixed-sleep validation).
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && omOnB().length === 0) await new Promise(r => setTimeout(r, 100));
    assert.ok(workerCalls >= 1);
    return omOnB().map(e => `${e.customType} covers=${e.data?.coversUpToId} inBranchB=${idsOnB().has(e.data?.coversUpToId)}`);
  } finally { releaseWorker(); await host.cleanup(); }
}

test('D03 positive control: without navigation the worker commits its OM entry (pipeline is live)', async () => {
  const committed = await scenario({ navigate: false });
  assert.ok(committed.length > 0, 'control: expected the worker to commit when the branch did not change');
});

test('D03 ordinary same-branch progress does not cancel the in-flight worker', async () => {
  const committed = await scenario({ navigate: false, advance: true });
  assert.ok(committed.length > 0, 'leaf advancing along the same branch must not revoke the worker');
});

test('D03 stale branch-A worker result is not appended onto branch B', async () => {
  const leaked = await scenario({ navigate: true });
  assert.deepEqual(leaked, [], `stale branch-A worker appended OM entry onto branch B: ${JSON.stringify(leaked)}`);
});
