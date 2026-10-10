import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
const { prepareCompaction } = await import(new URL('./core/compaction/compaction.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
const root = resolve(process.argv[2]), scenario = process.argv[3], agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(agentDir, 'workspace'); await mkdir(cwd, { recursive: true }); await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
process.env.PI_BLACKHOLE_COMPACTION = scenario === 'settings-session' ? 'manual' : 'auto'; process.env.PI_BLACKHOLE_MEMORY = scenario.startsWith('memory-') ? 'true' : 'false';
await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ compaction: scenario === 'settings-session' ? 'manual' : 'auto', memory: scenario.startsWith('memory-'), fullFoldAlways: true, compactionSummaryMode: 'append', observeAfterTokens: 100000000, reflectAfterTokens: 100000000, showPreCompactionMessage: true }));
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 100 }, cacheWarming: 'off', retry: { enabled: false }, enableInstallTelemetry: false });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(root, 'modules/blackhole/src/index.ts')], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
modelRuntime.registerProvider('bh-review-offline', { api: 'openai-responses', apiKey: 'synthetic', baseUrl: 'https://offline.invalid', models: [{ id: 'review', name: 'Review', api: 'openai-responses', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const model = modelRuntime.getModels().find(m => m.provider === 'bh-review-offline' && m.id === 'review'); assert.ok(model);
const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
let summaryCalls = 0;
const syntheticStream = () => { summaryCalls++; const stream = createAssistantMessageEventStream(); const message = assistant('Safe offline native fallback summary'); queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); }); return stream; };
const agent = new Agent({ initialState: { model }, convertToLlm: sdk.convertToLlm, streamFn: syntheticStream });
const session = new sdk.AgentSession({ agent, cwd, settingsManager: settings, resourceLoader: loader, modelRuntime, sessionManager: sm, baseToolsOverride: {}, initialActiveToolNames: [] });
const errors = [], notifications = []; let cancelledModals = 0;
const uiContext = new Proxy({ notify: text => notifications.push(String(text)) }, { get(target, key) {
  if (key === 'theme') return sdk.theme;
  if (key === 'custom') return async factory => new Promise(resolveModal => {
    const component = factory({ terminal: { rows: 40, columns: 100 }, requestRender() {} }, sdk.theme, {}, resolveModal);
    component.handleInput('\u001b'); cancelledModals++;
  });
  if (['select', 'input', 'editor', 'confirm'].includes(key)) return async () => undefined;
  return target[key] ?? (() => undefined);
} });
// settings-session drives a simulated TUI selector; /blackhole settings only opens custom UI in mode 'tui' (D20).
await session.bindExtensions({ mode: scenario === 'settings-session' ? 'tui' : 'json', uiContext, onError: e => errors.push(e.error) });
const normalMemory = ['memory-normal', 'settings-session'].includes(scenario);
const notice = id => sm.appendCustomMessageEntry('shell-job-completed', 'job', false, { jobs: [{ jobId: id, status: 'completed', exitCode: 0 }] });
const user = text => sm.appendMessage({ role: 'user', content: text, timestamp: 1 });
let source, output, omittedNotice, retainedNotice;
try {
  if (scenario === 'boundary-null') {
    user('old safe task'); sm.appendMessage(assistant('old result')); omittedNotice = notice('OMITTED'); sm.appendContextEdit(omittedNotice, null); user('keep '.repeat(500)); retainedNotice = notice('RETAINED');
  } else if (scenario.startsWith('display-')) {
    user('old safe task'); output = sm.appendMessage(assistant('PRIVATE_OUTPUT_SENTINEL'));
    if (scenario === 'display-null') sm.appendContextEdit(output, null);
    if (scenario === 'display-replaced') sm.appendContextEdit(output, { content: 'SAFE_EDITED_OUTPUT' });
    notice('VISIBLE_SEPARATOR'); user('keep '.repeat(500));
  } else {
    source = user(normalMemory ? 'safe original source' : 'PRIVATE_OM_SENTINEL'); output = sm.appendMessage(assistant('safe result'));
    sm.appendCustomEntry('om.observations.recorded', { coversUpToId: source, observations: [{ id: 'aaaaaaaaaaaa', content: normalMemory ? 'SAFE_NORMAL_MEMORY' : 'PRIVATE_OM_SENTINEL', timestamp: '2026-10-09', relevance: 'high', sourceEntryIds: [source], tokenCount: 10 }] });
    sm.appendCustomEntry('om.reflections.recorded', { coversUpToId: source, reflections: [{ id: 'bbbbbbbbbbbb', content: normalMemory ? 'SAFE_NORMAL_REFLECTION' : 'PRIVATE_OM_SENTINEL', supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: 10 }] });
    if (!normalMemory) sm.appendContextEdit(source, scenario === 'memory-replaced' ? { content: 'SAFE_REPLACEMENT' } : null);
    if (scenario === 'memory-empty') { sm.appendContextEdit(output, null); notice('SAFE_NATIVE_FALLBACK_INPUT'); }
    else { user('safe intermediate task'); sm.appendMessage(assistant('safe intermediate result')); }
    user('keep '.repeat(500));
  }
  if (scenario === 'settings-session') {
    const leafId = sm.getLeafId(); sm.appendCustomEntry('session-config-pi-blackhole', { leafId, config: { compaction: 'auto', memory: true, midRunCompaction: 'off', compactAfterTokens: 81000 } });
    console.log('Starting first isolated settings reload...'); await session.reload(); console.log('First settings reload completed.');
    assert.ok(notifications.some(text => text.includes('Pi owns compaction')), 'Direct persisted session diagnostics are wired');
    const warningCount = notifications.filter(text => text.includes('Pi owns compaction')).length;
    console.log('Starting second isolated settings reload...'); await session.reload();
    const configBytes = await readFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), 'utf8');
    const sessionOverrides = JSON.stringify(sm.getEntries().filter(e => e.type === 'custom' && e.customType === 'session-config-pi-blackhole'));
    console.log('Starting cancelled settings modal...'); await session.prompt('/blackhole settings'); console.log('Cancelled settings modal completed.');
    assert.equal(cancelledModals, 1, 'Actual settings selector cancelled through Escape');
    assert.equal(await readFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), 'utf8'), configBytes, 'Cancelled modal does not rewrite global config');
    assert.equal(JSON.stringify(sm.getEntries().filter(e => e.type === 'custom' && e.customType === 'session-config-pi-blackhole')), sessionOverrides, 'Cancelled modal does not change persisted session overrides');
    assert.equal(notifications.filter(text => text.includes('Pi owns compaction')).length, warningCount, 'Reload and cancelled settings modal do not replay diagnostics');
    assert.equal(summaryCalls, 0, 'Settings and reload never query a model');
  }
  const before = await readFile(sm.getSessionFile(), 'utf8');
  const p = prepareCompaction(sm.getBranch(), settings.getCompactionSettings(model)); assert.ok(p);
  if (scenario === 'boundary-null') assert.equal(p.firstKeptEntryId, omittedNotice, 'Actual invisible-backtrack cut');
  const result = await session.compact(); assert.equal(result.firstKeptEntryId, p.firstKeptEntryId); assert.equal(result.tokensBefore, p.tokensBefore);
  if (scenario === 'boundary-null') { assert.ok(!result.summary.includes(`e:${retainedNotice}`)); assert.ok(!result.summary.includes(`e:${omittedNotice}`)); }
  const copies = () => sm.getBranch().filter(e => e.type === 'custom' && e.customType === 'blackhole-pre-compaction-output');
  if (scenario === 'display-null') assert.equal(copies().filter(e => e.data.sourceEntryId === output).length, 0);
  if (scenario === 'display-replaced') { assert.equal(copies().length, 1); assert.equal(copies()[0].data.text, 'SAFE_EDITED_OUTPUT'); assert.ok(!JSON.stringify(copies()).includes('PRIVATE_OUTPUT_SENTINEL')); }
  if (scenario === 'display-normal') { assert.equal(copies().length, 1); assert.equal(copies()[0].data.sourceEntryId, output); }
  if (scenario.startsWith('display-')) assert.ok(!JSON.stringify(sm.buildSessionProjection().messages).includes('blackhole-pre-compaction-output'), 'Display state never creates model messages');
  if (scenario.startsWith('memory-') && scenario !== 'memory-normal') assert.ok(!JSON.stringify(result).includes('PRIVATE_OM_SENTINEL'), 'No active derived body/reflection/trailing/segment leak');
  if (normalMemory) { assert.equal(result.details?.compactor, 'blackhole', 'Explicit session auto participates despite PASSIVE/manual environment'); assert.equal(result.details['om.folded'].observations[0].sourceEntryIds[0], source); assert.ok(result.summary.includes('SAFE_NORMAL_MEMORY')); }
  if (scenario === 'memory-empty') { assert.ok(summaryCalls > 0, 'Empty VCC delegates to actual native summarizer'); assert.equal(result.details?.compactor, undefined); assert.ok(sm.getBranch().some(e => e.type === 'custom' && e.customType === 'blackhole-om-source-invalidation'), 'Native fallback carries a checkpoint-bound state-only invalidation'); }
  if (['memory-checkpoint', 'memory-empty', 'memory-normal'].includes(scenario)) {
    sm.appendMessage(assistant('second safe result')); user('next keep '.repeat(500));
    const next = await session.compact();
    if (scenario === 'memory-normal') { assert.ok(next.summary.includes('SAFE_NORMAL_MEMORY')); assert.equal(next.details['om.folded'].observations[0].sourceEntryIds[0], source); }
    else assert.ok(!JSON.stringify(next).includes('PRIVATE_OM_SENTINEL'), 'Invalidation survives checkpoint window advancement');
  }
  assert.ok((await readFile(sm.getSessionFile(), 'utf8')).startsWith(before), 'Raw JSONL prefix unchanged');
  assert.equal(new Set(copies().map(e => e.data.sourceEntryId)).size, copies().length);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ scenario, projectionContract: true, externalProviderCalls: 0, nativeSummaryCalls: summaryCalls, nativeCut: result.firstKeptEntryId, displayCopies: copies().length, rawHistoryUnchanged: true }));
} finally { session.dispose(); }
