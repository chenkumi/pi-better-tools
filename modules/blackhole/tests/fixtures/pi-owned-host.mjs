import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
const root = resolve(process.argv[2]), scenario = process.argv[3], withoutBH = process.argv[4] === 'without-blackhole';
const agentDir = process.env.PI_CODING_AGENT_DIR, cwd = join(agentDir, 'workspace');
await mkdir(cwd, { recursive: true }); await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ compaction: 'auto', compactionEngine: 'blackhole',
  compactAfterTokens: 4500, midRunCompaction: 'resume', tailBehavior: 'minimal', memory: false, showPreCompactionMessage: false }));
sdk.initTheme('dark', false);
const disabled = scenario.startsWith('disabled') || scenario === 'manual-projection';
const settings = sdk.SettingsManager.inMemory({ packages: [], cacheWarming: 'off', retry: { enabled: true }, enableInstallTelemetry: false,
  compaction: { enabled: !disabled, reserveTokens: 1024, keepRecentTokens: scenario === 'manual-projection' ? 50 : 0,
    modelOverrides: { 'bh-offline/owned-large': { reserveTokens: 256, keepRecentTokens: 25 } } } });
const audit = { preparations: [], pending: false, cancel: scenario === 'cancel' };
globalThis[Symbol.for('blackhole-pi-owned-test-audit')] = audit;
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  additionalExtensionPaths: [join(root, 'modules/blackhole/tests/fixtures/pi-owned-audit.ts'),
    ...(!withoutBH ? [join(root, 'modules/blackhole/src/index.ts')] : [])], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
let aliasDone;
if (scenario === 'alias' && !withoutBH) {
  // Public loaded command/context only: completion event precedes the command's callback.
  // Wait for that callback before disposing; never equate compaction_end with callback cleanup.
  const command = loader.getExtensions().extensions.find(extension => extension.commands.has('blackhole')).commands.get('blackhole');
  const original = command.handler;
  aliasDone = new Promise((resolve, reject) => {
    command.handler = (args, ctx) => original(args, { ...ctx, compact: options => ctx.compact({ ...options,
      onComplete: () => { try { options.onComplete?.(); resolve(); } catch (error) { reject(error); throw error; } },
      onError: error => { try { options.onError?.(error); } finally { reject(error); } },
    }) });
  });
}
const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider('bh-offline', { api: 'openai-responses', apiKey: 'synthetic', baseUrl: 'https://offline.invalid',
  models: [{ id: 'owned', name: 'Owned', api: 'openai-responses', reasoning: false, input: ['text'],
    contextWindow: disabled ? 1048576 : 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'owned-large', name: 'Large', api: 'openai-responses', reasoning: false, input: ['text'], contextWindow: 16384, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const model = runtime.getModels().find(m => m.provider === 'bh-offline' && m.id === 'owned'); assert.ok(model);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
  model: model.id, usage: structuredClone(usage), stopReason: 'stop', timestamp: Date.now() });
const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
const omitted = sm.appendMessage({ role: 'user', content: 'OMITTED_RAW_NATIVE_SECRET', timestamp: Date.now() });
sm.appendContextEdit(omitted, null);
sm.appendMessage({ role: 'user', content: 'Implement PROJECTED_NATIVE_TASK', timestamp: Date.now() });
sm.appendMessage(response('completed PROJECTED_NATIVE_RESULT'));
sm.appendMessage({ role: 'user', content: 'Preserve native recent task', timestamp: Date.now() });
sm.appendMessage(response('native kept result ' + 'kept '.repeat(100)));
let calls = 0, summaryCalls = 0, tools = 0, previousCalls = 0;
const trace = [], snapshots = [], errors = [], events = [];
const agent = new Agent({ initialState: { model }, convertToLlm: sdk.convertToLlm, prepareRequest: async () => { previousCalls++; },
  streamFn: (_model, context) => {
    const summaryRequest = audit.pending;
    if (summaryRequest) summaryCalls++; else { calls++; snapshots.push(structuredClone(context)); trace.push(`provider:${calls}`); }
    let message = response(summaryRequest ? 'NATIVE_OFFLINE_SUMMARY' : 'FINAL_RESULT\n' + (disabled ? 'synthetic data\n'.repeat(2000) : 'complete'));
    if (!summaryRequest && (scenario === 'disabled-tool' || scenario === 'native-tool') && calls === 1) { message.content = [{ type: 'toolCall', id: 'call_A|fc_B', name: 'pressure', arguments: {} }]; message.stopReason = 'toolUse'; }
    if (!summaryRequest && (scenario === 'auto' || scenario === 'cancel')) { message.usage.input = 7600; message.usage.totalTokens = 7600; }
    if (!summaryRequest && scenario === 'native-tool' && calls === 1) { message.usage.input = 7600; message.usage.totalTokens = 7600; }
    if (!summaryRequest && scenario === 'reload-model') { message.usage.input = 16300; message.usage.totalTokens = 16300; }
    message.model = _model.id;
    if (!summaryRequest && scenario === 'overflow' && calls === 1) { message.content = [{ type: 'text', text: 'OMITTED_OVERFLOW_ATTEMPT' }]; message.stopReason = 'error'; message.errorMessage = 'context length exceeded'; }
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'start', partial: { ...message, stopReason: 'pending' } });
    stream.push(message.stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
  } });
const tool = { name: 'pressure', label: 'Pressure', description: 'Offline pressure', parameters: Type.Object({}), execute: async () => { tools++; return { content: [{ type: 'text', text: 'TOOL_BODY\n' + 'synthetic data\n'.repeat(2000) }], details: {} }; } };
const session = new sdk.AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, modelRuntime: runtime, resourceLoader: loader,
  baseToolsOverride: { pressure: tool }, initialActiveToolNames: ['pressure'] });
const nativePrepare = agent.prepareRequest, nativeStream = agent.streamFunction;
session.subscribe(e => { if (e.type === 'compaction_start' || e.type === 'compaction_end') { events.push(e); trace.push(`${e.type}:${e.reason}`); if (e.type === 'compaction_end') audit.pending = false; } });
try {
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  if (scenario === 'reload-model') {
    await session.reload();
    await session.setModel(runtime.getModels().find(m => m.provider === 'bh-offline' && m.id === 'owned-large'));
  }
  if (scenario === 'manual-projection') await session.compact();
  else if (scenario === 'alias') {
    if (withoutBH) await session.compact('__pi_vcc__');
    else {
      await session.prompt('/blackhole'); await aliasDone;
    }
  } else await session.prompt('Perform native task');
  const compactions = sm.getBranch().filter(e => e.type === 'compaction');
  console.log(JSON.stringify({ scenario, withoutBH, calls, previousCalls, tools, summaryCalls, compactions: compactions.length,
    preparations: audit.preparations.map(p => ({ firstKeptEntryId: p.firstKeptEntryId, reason: p.reason, omitted: p.messages.includes('OMITTED_RAW_NATIVE_SECRET') })), trace, errors }));
  assert.equal(agent.prepareRequest, nativePrepare, 'Blackhole must not wrap public prepareRequest');
  assert.equal(agent.streamFunction, nativeStream, 'Blackhole must not wrap provider stream');
  if (scenario.startsWith('disabled')) { assert.equal(events.length, 0, 'Pi disabled means no BH-owned auto attempts'); assert.equal(compactions.length, 0); assert.equal(calls, scenario === 'disabled-tool' ? 2 : 1); }
  else if (scenario === 'low-pressure') { assert.equal(events.length, 0); assert.equal(compactions.length, 0); assert.equal(calls, 1); }
  else if (scenario === 'cancel') { assert.equal(events.at(-1).reason, 'threshold'); assert.equal(compactions.length, 0); assert.equal(events.at(-1).aborted, true); assert.equal(events.at(-1).willRetry, false); assert.equal(calls, 1); }
  else {
    assert.equal(compactions.length, 1); assert.equal(compactions[0].firstKeptEntryId, audit.preparations[0].firstKeptEntryId);
    assert.equal(compactions[0].tokensBefore, audit.preparations[0].tokensBefore);
    assert.ok(!audit.preparations[0].messages.includes('OMITTED_RAW_NATIVE_SECRET'));
    assert.ok(!compactions[0].summary.includes('OMITTED_RAW_NATIVE_SECRET'), 'Raw omitted message must not reenter summary');
    if (!withoutBH) assert.equal(compactions[0].fromHook, true);
    else assert.equal(summaryCalls, 1 + (audit.preparations[0].prefixCount > 0 ? 1 : 0), 'Baseline native summary plus split-prefix summary use the isolated synthetic provider');
    if (scenario === 'alias') { assert.equal(events.at(-1).reason, 'manual'); assert.equal(calls, 0); }
    if (scenario === 'native-tool') { assert.equal(calls, 2); assert.equal(tools, 1); assert.equal(events.at(-1).reason, 'threshold'); assert.ok(snapshots.at(-1).messages.some(message => typeof message.content === 'string' ? message.content.includes(compactions[0].summary) : message.content?.some(part => part.text?.includes(compactions[0].summary)))); }
    if (scenario === 'reload-model') { assert.equal(audit.preparations[0].settings.reserveTokens, 256); assert.equal(audit.preparations[0].settings.keepRecentTokens, 25); assert.equal(events.at(-1).reason, 'threshold'); assert.equal(calls, 1); }
    if (scenario === 'auto') { assert.equal(events.at(-1).reason, 'threshold'); assert.equal(events.at(-1).willRetry, false); assert.equal(calls, 1); }
    if (scenario === 'overflow') { assert.equal(calls, 2); assert.equal(events.at(-1).reason, 'overflow'); assert.equal(events.at(-1).willRetry, true);
      assert.ok(!compactions[0].summary.includes('OMITTED_OVERFLOW_ATTEMPT')); assert.ok(!JSON.stringify(snapshots.at(-1)).includes('OMITTED_OVERFLOW_ATTEMPT')); }
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ piOwnedContract: true, externalProviderCalls: 0 }));
} finally { session.dispose(); delete globalThis[Symbol.for('blackhole-pi-owned-test-audit')]; }
