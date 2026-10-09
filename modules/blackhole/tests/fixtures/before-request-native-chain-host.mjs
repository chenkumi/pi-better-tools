// Readonly installed-host diagnostic: public cancellation inside Pi's existing request projection.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { classifyError } from '../../../pi-runtime/src/policy.ts';

const root = resolve(process.argv[2]);
const variant = process.argv[3] ?? 'virtual-selected';
assert.ok(['virtual-selected', 'delegate-switch'].includes(variant));
const agentDir = process.env.PI_CODING_AGENT_DIR;
assert.ok(agentDir);
const cwd = join(agentDir, 'workspace');
await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 0 },
  cacheWarming: 'off', retry: { enabled: true }, enableInstallTelemetry: false });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  additionalExtensionPaths: [join(root, 'modules/blackhole/tests/fixtures/before-request-threshold-cancel-extension.ts')],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
  allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider('bh-offline', { api: 'openai-responses', apiKey: 'synthetic-key', baseUrl: 'https://offline.invalid',
  models: [{ id: 'physical-small', name: 'Physical small', api: 'openai-responses', reasoning: false,
    input: ['text'], contextWindow: 4096, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'physical-large', name: 'Physical large', api: 'openai-responses', reasoning: false,
      input: ['text'], contextWindow: 1048576, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const physical = runtime.getModels().find(m => m.provider === 'bh-offline' && m.id === 'physical-small');
assert.ok(physical);
let routes = 0, previousCalls = 0, outerCalls = 0, guardCalls = 0, providerInvocations = 0;
const trace = [], errors = [], events = [];
runtime.registerVirtualModel({ provider: 'bh-offline', id: 'virtual-selection', name: 'Virtual selection', contextWindow: 1048576, maxTokens: 256,
  route: async request => { routes++; trace.push('route'); return { model: physical, thinkingLevel: 'off', state: { routes, prior: request.state ?? null } }; } });
const virtual = runtime.getModels().find(m => m.provider === 'bh-offline' && m.id === 'virtual-selection');
assert.ok(virtual);
const selected = variant === 'delegate-switch' ? runtime.getModels().find(m => m.provider === 'bh-offline' && m.id === 'physical-large') : virtual;
assert.ok(selected);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
sm.appendMessage({ role: 'user', content: 'Earlier work', timestamp: Date.now() });
sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'seeded historical text\n'.repeat(2000) }],
  api: physical.api, provider: physical.provider, model: physical.id, usage, stopReason: 'stop', timestamp: Date.now() });
sm.appendModelChange(selected.provider, selected.id);
let guardedPhysical;
const originalProvider = (model) => {
  providerInvocations++;
  const message = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic original response' }], api: model.api,
    provider: model.provider, model: model.id, usage: structuredClone(usage), stopReason: 'stop', timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
};
const agent = new Agent({ initialState: { model: selected }, convertToLlm: sdk.convertToLlm,
  prepareRequest: async () => {
    previousCalls++; trace.push(`previous:${previousCalls}`);
    return variant === 'delegate-switch' ? { model: virtual } : undefined;
  }, streamFn: originalProvider });
const session = new sdk.AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, modelRuntime: runtime,
  resourceLoader: loader, baseToolsOverride: {}, initialActiveToolNames: [] });
// Same approved public boundaries; no SDK/private method patch or settings rewrite.
const previousPrepare = agent.prepareRequest;
assert.equal(typeof previousPrepare, 'function');
agent.prepareRequest = async (...args) => {
  outerCalls++; trace.push('outer:start');
  const prepared = await previousPrepare(...args);
  trace.push('outer:return');
  return prepared;
};
agent.streamFunction = (model) => {
  guardCalls++; trace.push('guard:local-refusal');
  guardedPhysical = model.id;
  const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: structuredClone(usage), stopReason: 'error', errorMessage: 'Blackhole safety policy: local request admission refusal (diagnostic only)', timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: { ...message, stopReason: 'pending' } });
  stream.push({ type: 'error', reason: 'error', error: message });
  stream.end(message);
  return stream;
};
session.subscribe(e => {
  if (e.type === 'compaction_start' || e.type === 'compaction_end' || e.type.startsWith('auto_retry')) {
    events.push(e); trace.push(`${e.type}:${e.reason ?? ''}`);
  }
});
try {
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  await session.prompt('Continue this task');
  const final = sm.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).message;
  const compactEnds = events.filter(e => e.type === 'compaction_end');
  console.log(JSON.stringify({ variant, selectedModel: selected.id, guardedPhysical, outerCalls, previousCalls, routes, guardCalls, providerInvocations, trace,
    compactEnds: compactEnds.map(e => ({ reason: e.reason, aborted: e.aborted, willRetry: e.willRetry, errorMessage: e.errorMessage })),
    runtimeClassification: classifyError(final), nativeCompactions: sm.getBranch().filter(e => e.type === 'compaction').length,
    retryEvents: events.filter(e => e.type.startsWith('auto_retry')).length, errors }));
  assert.equal(outerCalls, 1);
  assert.equal(routes, 1, 'No external routing replacement');
  assert.equal(previousCalls, 2, 'Diagnostic must reproduce Pi replaying the previous callback after cancelled physical-model threshold');
  assert.equal(guardCalls, 1);
  assert.equal(guardedPhysical, physical.id);
  assert.equal(providerInvocations, 0);
  assert.equal(compactEnds.length, 1);
  assert.equal(compactEnds[0].reason, 'threshold');
  assert.equal(compactEnds[0].aborted, true);
  assert.equal(compactEnds[0].willRetry, false);
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 0);
  assert.equal(events.filter(e => e.type.startsWith('auto_retry')).length, 0);
  assert.equal(classifyError(final), 'policy');
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')), {});
  console.log(JSON.stringify({ nativeChainReplayReproduced: true, providerInvocations: 0, privatePatches: 0 }));
} finally { session.dispose(); }
