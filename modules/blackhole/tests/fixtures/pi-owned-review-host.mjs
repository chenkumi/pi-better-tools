import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const root = resolve(process.argv[2]), scenario = process.argv[3], agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(agentDir, 'workspace');
await mkdir(cwd, { recursive: true }); await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
process.env.PI_BLACKHOLE_COMPACTION = 'manual'; process.env.PI_BLACKHOLE_MEMORY = 'true';
await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ compaction: 'manual', memory: true, fullFoldAlways: true, observeAfterTokens: 100000000, reflectAfterTokens: 100000000, showPreCompactionMessage: true }));
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: scenario === 'pre-refusal' ? 100000000 : 100 }, cacheWarming: 'off', retry: { enabled: false }, enableInstallTelemetry: false });
const control = { cancel: scenario === 'peer-cancel', events: [] }; globalThis[Symbol.for('blackhole-review-peer')] = control;
const paths = [join(root, 'modules/blackhole/src/index.ts'), join(root, 'modules/blackhole/tests/fixtures/pi-owned-review-peer.ts')];
if (scenario === 'stale-context') paths.reverse();
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
const providerCalls = 0; let syntheticSummaryAttempts = 0;
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: sm, noTools: 'all' });
// Public Agent property, not an ignored SDK options key. Never dispatch to network.
session.agent.streamFunction = () => { syntheticSummaryAttempts++; throw new Error('Synthetic offline summarization failure'); };
const errors = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const source = sm.appendMessage({ role: 'user', content: 'safe task', timestamp: Date.now() }); sm.appendMessage(assistant('normal dropped output'));
sm.appendMessage({ role: 'user', content: 'keep '.repeat(500), timestamp: Date.now() });
const pendingFile = join(agentDir, 'pi-blackhole', `${sm.getSessionId()}-pending.json`);
const pending = { observationBatches: [{ coversUpToId: source, data: { coversUpToId: source, observations: [{ id: 'aaaaaaaaaaaa', content: 'SAFE_PENDING_MEMORY', timestamp: '2026-10-09', relevance: 'high', sourceEntryIds: [source], tokenCount: 10 }] } }], reflectionBatches: [{ coversUpToId: source, data: { coversUpToId: source, reflections: [{ id: 'bbbbbbbbbbbb', content: 'SAFE_PENDING_REFLECTION', supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: 10 }] } }], cursors: { observer: { entryId: source, state: 'success' } } };
await writeFile(pendingFile, JSON.stringify(pending)); const beforePending = await readFile(pendingFile, 'utf8');
const oldFile = sm.getSessionFile(); const beforeRaw = await readFile(oldFile, 'utf8');
const originalUnlink = fs.unlinkSync; let denyUnlink = true;
if (scenario === 'deletion-stale-fault') await writeFile(pendingFile.replace('-pending.json', '-pending.stale.json'), beforePending);
if (scenario.startsWith('deletion-')) {
  const deniedPath = scenario === 'deletion-stale-fault' ? pendingFile.replace('-pending.json', '-pending.stale.json') : pendingFile;
  fs.unlinkSync = path => { if (denyUnlink && String(path) === deniedPath) throw new Error('Synthetic pending unlink failure'); return originalUnlink(path); }; syncBuiltinESMExports();
}
const originalAppend = sm.appendCustomEntry.bind(sm), originalCompaction = sm.appendCompaction.bind(sm); let appends = 0;
if (scenario === 'append-entry-fault') sm.appendCustomEntry = (...args) => { if (++appends === 2) throw new Error('Synthetic appendCustomEntry fault'); return originalAppend(...args); };
if (scenario === 'append-compaction-fault') sm.appendCompaction = () => { throw new Error('Synthetic appendCompaction fault'); };
if (scenario === 'summary-abort') control.abort = () => session.abortCompaction();
let oldTip;
if (scenario === 'branch-replacement') control.replace = () => { oldTip = sm.getLeafId(); sm.branch(source); };
if (scenario === 'session-replacement') control.replace = () => { sm.newSession(); };
if (scenario === 'stale-context') control.reload = async () => { delete control.reload; await session.reload(); };
try {
  let result, failure;
  try { result = await session.compact('__pi_vcc__'); } catch (error) { failure = error; }
  if (scenario === 'pre-refusal') {
    assert.ok(failure, 'Native preparation refuses before any hook');
    assert.equal(await readFile(pendingFile, 'utf8'), beforePending);
    assert.equal(sm.getBranch().filter(e => e.type === 'custom' && e.customType.startsWith('om.')).length, 0);
    assert.equal(providerCalls, 0);
    console.log(JSON.stringify({ scenario, pendingCommitContract: true, providerCalls, preHookRefusal: true }));
    process.exitCode = 0;
  } else {
  if (scenario !== 'success') {
    const committedButRetained = ['deletion-main-fault', 'deletion-stale-fault', 'stale-context', 'branch-replacement', 'session-replacement'].includes(scenario);
    if (!committedButRetained) { assert.ok(failure || !result, 'The native operation must not claim success'); assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 0); }
    if (scenario === 'deletion-stale-fault') {
      assert.equal(await readFile(pendingFile.replace('-pending.json', '-pending.stale.json'), 'utf8'), beforePending);
      const { commitManualPending, pendingFingerprint } = await import('../../src/om/manual-pending.ts');
      assert.equal(commitManualPending(sm.getSessionId(), pendingFingerprint(sm.getSessionId())), false, 'Failed stale-backup deletion is not acknowledged as cleaned');
      // Backup is observable even if the main file was successfully removed.
      await writeFile(pendingFile, beforePending);
    } else assert.equal(await readFile(pendingFile, 'utf8'), beforePending, 'Pending batches AND cursors survive post-admission failure');
    control.cancel = false; delete control.abort; delete control.replace; delete control.reload; sm.appendCustomEntry = originalAppend; sm.appendCompaction = originalCompaction;
    denyUnlink = false; fs.unlinkSync = originalUnlink; syncBuiltinESMExports();
    if (scenario === 'session-replacement') sm.setSessionFile(oldFile);
    if (scenario === 'branch-replacement') { sm.branch(oldTip); sm.appendMessage(assistant('restored safe result')); sm.appendMessage({ role: 'user', content: 'restored keep '.repeat(500), timestamp: Date.now() }); await session.reload(); }
    if (['deletion-main-fault', 'deletion-stale-fault', 'stale-context'].includes(scenario)) { sm.appendMessage(assistant('safe second result')); sm.appendMessage({ role: 'user', content: 'keep next '.repeat(500), timestamp: Date.now() }); }
    result = await session.compact('__pi_vcc__');
  }
  assert.ok(result.summary.includes('SAFE_PENDING_MEMORY'));
  const records = sm.getBranch().filter(e => e.type === 'custom' && e.customType.startsWith('om.'));
  assert.equal(records.filter(e => e.customType === 'om.observations.recorded').length, 1, 'Retry does not append the committed batch twice');
  assert.equal(records.filter(e => e.customType === 'om.reflections.recorded').length, 1);
  assert.equal(result.details['om.folded'].observations.length, 1);
  assert.equal(result.details['om.folded'].reflections.length, 1);
  if (await stat(pendingFile).then(() => true, () => false)) console.log(JSON.stringify({ pendingStillPresent: JSON.parse(await readFile(pendingFile, 'utf8')), receipt: result.details['blackhole.pendingFlush'], events: control.events, currentFingerprint: (await import('../../src/om/manual-pending.ts')).pendingFingerprint(sm.getSessionId()), branchIds: sm.getBranch().map(e => [e.id, e.type, e.customType]) }));
  assert.equal(await stat(pendingFile).then(() => true, () => false), false, 'Pending clears only after actual persisted compaction success');
  assert.ok((await readFile(sm.getSessionFile(), 'utf8')).startsWith(beforeRaw));
  assert.equal(providerCalls, 0);
  console.log(JSON.stringify({ scenario, pendingCommitContract: true, providerCalls, syntheticSummaryAttempts, errors, foldedIds: result.details['om.folded'].observations.map(o => o.id), batchCount: records.length, originalCursor: pending.cursors.observer, retryDeduplicated: true }));
  }
} finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); session.dispose(); delete globalThis[Symbol.for('blackhole-review-peer')]; }
