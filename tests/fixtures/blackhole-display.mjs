import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';

assert.equal(process.env.PI_BLACKHOLE_PASSIVE, 'true');
assert.equal(sdk.VERSION, '1.1.0');
const root = resolve(process.argv[2]);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(agentDir, 'workspace');
await mkdir(cwd, { recursive: true });
await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({
  compaction: 'off', memory: false, showPreCompactionMessage: true,
}));
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({
  packages: [], compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 8 },
  cacheWarming: 'off', retry: { enabled: false }, enableInstallTelemetry: false,
});
const auditKey = Symbol.for('pi-better-tools.blackhole-display-native-audit');
const audit = [];
globalThis[auditKey] = audit;
const modelRuntime = await sdk.ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});
const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
const errors = [];
let session;
const counters = { modelStreamCalls: 0, actualExternalFetchCalls: 0 };
let activeFetchCounters = counters;
const counterSemantics = { modelStreamCalls: 'main-agent-streamFunction-invocations',
  actualExternalFetchCalls: 'global-fetch-attempts', providerCalls: 'compatibility-alias-of-actualExternalFetchCalls' };
const readCounters = counts => ({ ...counts, providerCalls: counts.actualExternalFetchCalls });
const modelFailure = 'OFFLINE_MODEL_STREAM_FORBIDDEN';
// Shared by actual session instances and the public Agent.prompt control. This
// throwing stub is intentional fixture-only fault injection, not a provider implementation.
function installStreamCounter(agent, counts) {
  agent.streamFunction = () => { counts.modelStreamCalls++; throw new Error(modelFailure); };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { activeFetchCounters.actualExternalFetchCalls++; throw new Error('External requests are forbidden in this offline probe'); };
const create = async sessionManager => {
  // Fresh extension runtime per live/resumed session: do not share factory API
  // bindings or mutable Blackhole runtime across separate scenario sessions.
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), 'blackhole-display-audit.ts'),
      join(root, 'modules/blackhole/src/index.ts')],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2, 'one readonly audit and the actual Blackhole factory');
  const result = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings,
    resourceLoader: loader, modelRuntime, model, sessionManager, noTools: 'all' });
  installStreamCounter(result.session.agent, counters);
  await result.session.bindExtensions({ mode: 'json', onError: event => errors.push(event.error) });
  return result.session;
};
const assistant = content => ({ role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  api: model.api, provider: model.provider, model: model.id, stopReason: typeof content === 'string' ? 'stop' : 'toolUse', timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const type = 'blackhole-pre-compaction-output';
const copyEntries = sm => sm.getBranch().filter(entry => entry.type === 'custom' && entry.customType === type);
const currentText = 'CURRENT FINAL ANSWER: the newest task is complete and remains in Pi native context.';
const droppedText = 'FINAL ANSWER: previous task completed successfully.\nEvidence: 本地結果完整保留。\nSecond line: no provider call.';

// Public SDK cut/token helpers are independently checked against the real
// preparation event. These fresh fixtures have no edits/prior compactions/usage;
// assert that precondition instead of applying raw helpers to edited projections.
function expectedNative(sm) {
  const projection = sm.buildSessionProjection();
  const entries = projection.entries.map(entry => entry.sourceEntry);
  assert.ok(entries.every(entry => entry.type !== 'context_edit' && entry.type !== 'compaction'));
  for (const entry of projection.entries) assert.deepEqual(entry.messages, sdk.sessionEntryToContextMessages(entry.sourceEntry));
  const effective = settings.getCompactionSettings(model);
  const cut = sdk.findCutPoint(entries, 0, entries.length, effective.keepRecentTokens);
  const firstKeptEntryId = entries[cut.firstKeptEntryIndex].id;
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const conversation = rows => rows.flatMap(entry => sdk.sessionEntryToContextMessages(entry)).filter(message => message.role !== 'system');
  return { firstKeptEntryId, tokensBefore: projection.messages.reduce((n, message) => n + sdk.estimateTokens(message), 0),
    messagesToSummarize: conversation(entries.slice(0, historyEnd)),
    turnPrefixMessages: cut.isSplitTurn ? conversation(entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex)) : [],
    isSplitTurn: cut.isSplitTurn, settings: effective };
}

const cases = [];
try {
  if (process.argv[3] === '--counter-control') {
    const controls = [];
    for (const wiring of ['fixture-shared-installer', 'intentional-wrong-instance-field']) {
      const counts = { modelStreamCalls: 0, actualExternalFetchCalls: 0 }; activeFetchCounters = counts;
      let constructorBaselineCalls = 0; const baselineFailure = 'OFFLINE_CONSTRUCTOR_BASELINE_FORBIDDEN';
      const agent = new Agent({ initialState: { model, tools: [], thinkingLevel: 'off' },
        streamFn: () => { constructorBaselineCalls++; throw new Error(baselineFailure); } });
      const events = []; const unsubscribe = agent.subscribe(event => { events.push(event.type); });
      const installedCounter = () => { counts.modelStreamCalls++; throw new Error(modelFailure); };
      if (wiring === 'fixture-shared-installer') installStreamCounter(agent, counts);
      else agent.streamFn = installedCounter; // Intentional negative: constructor option is not an instance seam.
      try { await agent.prompt('Offline counter control: reject before any model response.'); await agent.waitForIdle(); }
      finally { unsubscribe(); agent.abort(); }
      const failure = agent.state.messages.filter(message => message.role === 'assistant').at(-1);
      console.error(`[stream-counter-control] ${wiring}: ${JSON.stringify({ ...readCounters(counts), constructorBaselineCalls, errorMessage: agent.state.errorMessage })}`);
      const expectedCalls = wiring === 'fixture-shared-installer' ? 1 : 0;
      assert.equal(counts.modelStreamCalls, expectedCalls, 'public Agent.prompt must use the shared installed counter');
      assert.equal(constructorBaselineCalls, 1 - expectedCalls); assert.equal(counts.actualExternalFetchCalls, 0);
      const expectedFailure = expectedCalls ? modelFailure : baselineFailure;
      assert.equal(agent.state.errorMessage, expectedFailure); assert.equal(failure.stopReason, 'error'); assert.equal(failure.errorMessage, expectedFailure);
      assert.equal(failure.content.map(block => block.type === 'text' ? block.text : '').join(''), '');
      assert.equal(failure.usage.totalTokens, 0); assert.equal(agent.state.isStreaming, false);
      assert.equal(events.filter(type => type === 'agent_start').length, 1); assert.equal(events.filter(type => type === 'agent_end').length, 1);
      controls.push({ wiring, ...readCounters(counts), constructorBaselineCalls, stopReason: failure.stopReason,
        failureReason: failure.errorMessage, modelResponses: 0, publicPrompt: true, idle: true });
    }
    assert.deepEqual(readCounters(counters), { modelStreamCalls: 0, actualExternalFetchCalls: 0, providerCalls: 0 }, 'control counters never contaminate normal A/B counters');
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')), {});
    console.log(JSON.stringify({ contract: 'pi-agent-stream-counter-control-v1', host: sdk.VERSION, counterSemantics, controls }));
  } else {
  for (const scenario of ['retained-final', 'dropped-final']) {
    console.error(`[blackhole-display] Testing Pi 1.1.0 native cut: ${scenario}`);
    audit.length = 0;
    const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions', scenario));
    session = await create(sm);
    sm.appendMessage({ role: 'user', content: 'Complete the previous task using the offline notes.', timestamp: Date.now() });
    let sourceId;
    if (scenario === 'dropped-final') {
      sm.appendMessage(assistant('Working on the previous requested task.'));
      sourceId = sm.appendMessage(assistant(`\u001b[31m${droppedText}\u001b[0m`));
      sm.appendMessage({ role: 'user', content: 'Now complete a newer task using the offline notes.', timestamp: Date.now() });
    }
    // Legal call/result pair in the split prefix, with no assistant text that
    // could accidentally become a newer cosmetic candidate than sourceId.
    const toolCallId = `offline-read-${scenario}`;
    sm.appendMessage(assistant([{ type: 'toolCall', id: toolCallId, name: 'read', arguments: { path: 'offline-notes.txt' } }]));
    sm.appendMessage({ role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text: 'Offline notes validated.' }],
      isError: false, timestamp: Date.now() });
    const currentId = sm.appendMessage(assistant(currentText));
    const rawBefore = structuredClone(sm.getBranch());
    const expected = expectedNative(sm);
    assert.equal(expected.firstKeptEntryId, currentId, 'the actual native budget keeps the latest final, not compact-all');
    assert.equal(expected.isSplitTurn, true);
    assert.equal(expected.turnPrefixMessages.length, 3, 'native split prefix preserves the user/call/result trio');
    const result = await session.compact('__pi_vcc__');
    assert.equal(audit.length, 1, 'one real native preparation; readonly observer does not supply a dummy cut');
    const prepared = audit[0];
    for (const key of ['firstKeptEntryId', 'tokensBefore', 'messagesToSummarize', 'turnPrefixMessages', 'isSplitTurn', 'settings']) {
      assert.deepEqual(prepared[key], expected[key], `exact native preparation ${key}`);
    }
    assert.deepEqual(prepared.branchIds, rawBefore.map(entry => entry.id));
    assert.equal(prepared.reason, 'manual'); assert.equal(prepared.willRetry, false); assert.equal(prepared.customInstructions, '__pi_vcc__');
    const summaryInput = [...prepared.messagesToSummarize, ...prepared.turnPrefixMessages];
    assert.ok(!JSON.stringify(summaryInput).includes(currentText), 'retained final is not duplicated into summary input');
    const call = summaryInput.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === toolCallId));
    const toolResult = summaryInput.find(message => message.role === 'toolResult' && message.toolCallId === toolCallId);
    assert.ok(call && toolResult); assert.ok(summaryInput.indexOf(call) < summaryInput.indexOf(toolResult));
    assert.equal(result.firstKeptEntryId, prepared.firstKeptEntryId);
    assert.equal(result.tokensBefore, prepared.tokensBefore);
    assert.ok(result.tokensBefore > 0);
    const compactions = sm.getBranch().filter(entry => entry.type === 'compaction'); assert.equal(compactions.length, 1);
    const compaction = compactions[0];
    assert.equal(compaction.details.compactor, 'blackhole');
    assert.equal(compaction.firstKeptEntryId, prepared.firstKeptEntryId); assert.equal(compaction.tokensBefore, prepared.tokensBefore);
    assert.equal(compaction.summary, result.summary, 'persisted live summary equals compact result');
    assert.ok(!compaction.summary.includes(currentText), 'kept final is not a summary duplicate');
    for (const entry of rawBefore) assert.deepEqual(sm.getBranch().find(row => row.id === entry.id), entry, 'raw history untouched');
    const expectedCopies = scenario === 'dropped-final' ? 1 : 0;
    assert.equal(copyEntries(sm).length, expectedCopies);
    assert.ok(copyEntries(sm).every(entry => entry.data.sourceEntryId !== currentId), 'never copy the native-retained newest final');
    if (sourceId) {
      const copy = copyEntries(sm)[0];
      assert.equal(copy.data.sourceEntryId, sourceId); assert.equal(copy.data.compactionEntryId, compaction.id);
      assert.equal(copy.data.text, droppedText); assert.equal(copy.data.truncated, false);
      assert.ok(!copy.data.text.includes('\u001b'), 'terminal controls stripped before plain custom persistence');
      assert.ok(JSON.stringify(summaryInput).includes(droppedText.split('\n')[0]), 'previous final really belongs to native summarized input');
    }
    await session.extensionRunner.emit({ type: 'session_compact', compactionEntry: compaction,
      fromExtension: true, reason: 'manual', willRetry: false });
    assert.equal(copyEntries(sm).length, expectedCopies, 'duplicate events never create an extra display copy');
    const sessionFile = sm.getSessionFile();
    const disk = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const entry of rawBefore) {
      const persistedRaw = disk.filter(row => row.id === entry.id);
      assert.equal(persistedRaw.length, 1, 'exactly one disk copy of each original raw entry');
      assert.deepEqual(persistedRaw[0], entry, 'all original raw history is exact on disk');
    }
    const diskCompactions = disk.filter(entry => entry.type === 'compaction'); assert.equal(diskCompactions.length, 1);
    assert.equal(diskCompactions[0].firstKeptEntryId, prepared.firstKeptEntryId); assert.equal(diskCompactions[0].tokensBefore, prepared.tokensBefore);
    assert.equal(diskCompactions[0].summary, compaction.summary);
    // dispose releases session subscriptions; it is not proof of runtime/background shutdown.
    session.dispose(); session = undefined;
    const reopened = sdk.SessionManager.open(sessionFile);
    session = await create(reopened);
    for (const entry of rawBefore) assert.deepEqual(reopened.getBranch().find(row => row.id === entry.id), entry, 'all original raw entries survive reopen exactly');
    const reopenedCompactions = reopened.getBranch().filter(entry => entry.type === 'compaction'); assert.equal(reopenedCompactions.length, 1);
    assert.equal(reopenedCompactions[0].firstKeptEntryId, prepared.firstKeptEntryId); assert.equal(reopenedCompactions[0].tokensBefore, prepared.tokensBefore);
    assert.equal(reopenedCompactions[0].summary, compaction.summary);
    const context = reopened.buildContextEntries();
    const projection = reopened.buildSessionProjection();
    assert.ok(context.some(entry => entry.id === currentId), 'native-retained newest final survives resume');
    assert.equal(projection.messages.filter(message => message.role === 'assistant' && JSON.stringify(message.content).includes(currentText)).length, 1,
      'newest final appears exactly once in model projection');
    assert.equal(copyEntries(reopened).length, expectedCopies);
    assert.ok(copyEntries(reopened).every(entry => projection.entries.find(row => row.sourceEntry.id === entry.id)?.messages.length === 0),
      'every persisted plain custom copy has zero LLM messages');
    let rendered = false;
    if (sourceId) {
      assert.ok(reopened.getBranch().some(entry => entry.id === sourceId), 'previous raw final remains in history');
      assert.ok(!context.some(entry => entry.id === sourceId), 'copied source remains outside compacted visible context');
      const copy = context.find(entry => entry.type === 'custom' && entry.customType === type);
      assert.ok(copy, 'resume visible context includes the persisted plain custom entry');
      assert.equal(copy.data.sourceEntryId, sourceId); assert.equal(copy.data.text, droppedText);
      assert.equal(sdk.sessionEntryToContextMessages(copy).length, 0);
      assert.equal(projection.entries.find(entry => entry.sourceEntry.id === copy.id).messages.length, 0);
      const renderer = session.extensionRunner.getEntryRenderer(type); assert.equal(typeof renderer, 'function');
      const component = renderer(copy, { expanded: true }, { fg: (_color, text) => text });
      const output = component.render(100).join('\n');
      assert.match(output, /Previous output/);
      for (const line of droppedText.split('\n')) assert.ok(output.includes(line), `renderer retains complete text: ${line}`);
      assert.ok(!output.includes(currentText), 'renderer never duplicates the current final');
      rendered = true;
    } else {
      assert.equal(context.filter(entry => entry.customType === type).length, 0, 'retained-only case creates no display copy');
    }
    assert.deepEqual(errors, []); assert.deepEqual(readCounters(counters), { modelStreamCalls: 0, actualExternalFetchCalls: 0, providerCalls: 0 });
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')), {});
    cases.push({ scenario, nativeCut: true, firstKeptEntryId: compaction.firstKeptEntryId,
      expectedFirstKeptEntryId: expected.firstKeptEntryId, tokensBefore: compaction.tokensBefore, expectedTokensBefore: expected.tokensBefore,
      reserveTokens: prepared.settings.reserveTokens, keepRecentTokens: prepared.settings.keepRecentTokens,
      summaryInputExact: true, toolPairsComplete: true, currentFinalRetained: true, currentFinalCopied: false,
      copies: expectedCopies, copiedSourceOutsideContext: Boolean(sourceId), persisted: true, resumed: true,
      rawHistoryDiskExact: true, resumedCompactionExact: true,
      rendered, duplicateSafe: true, displayOnly: true, noModelCopyDuplicate: true, ...readCounters(counters) });
    session.dispose(); session = undefined;
  }
  console.log(JSON.stringify({ contract: 'pi-owned-native-cut-display-v1', host: sdk.VERSION, nativeCut: true,
    persisted: true, resumed: true, rendered: cases[1].rendered, duplicateSafe: true, displayOnly: true,
    noModelCopyDuplicate: true, counterSemantics, ...readCounters(counters), cases }));
  }
} finally {
  session?.dispose(); globalThis.fetch = originalFetch; delete globalThis[auditKey];
}
