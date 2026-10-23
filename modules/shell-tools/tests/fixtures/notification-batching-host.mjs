import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import shellExtension from '../../extensions/timeout-ms.ts';

const mode = process.argv[2];
assert.ok(['normal', 'queued', 'aborted', 'preflight-failed', 'streaming', 'one-at-a-time'].includes(mode));
assert.equal(sdk.VERSION, '1.4.0');
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
assert.equal(resolve(process.env.PI_CODING_AGENT_DIR), resolve(agentDir));
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
globalThis.fetch = async () => { throw new Error('Network forbidden in notification batching fixture'); };
sdk.initTheme('dark', false);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const gateEntered = deferred(), gateRelease = deferred(), batchReceived = deferred(), batchSettled = deferred();
const terminalWaiters = new Map(), submitted = [], contexts = [], errors = [], trace = [];
const text = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const isBatch = message => text(message).startsWith('Shell background jobs have finished.');
const modelJobs = message => JSON.parse(text(message).slice(text(message).indexOf('\n') + 1));
let calls = 0, queued = false, sawBatch = false;
const model = { id: 'offline-batching', name: 'Offline batching', provider: 'batching-fixture', api: 'openai-completions', baseUrl: 'https://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash', 'batch_gate'], retry: { enabled: false }, compaction: { enabled: false },
  steeringMode: mode === 'one-at-a-time' ? 'one-at-a-time' : 'all', cacheWarming: 'off', enableInstallTelemetry: false, defaultProjectTrust: 'never' });
const extensionFactories = [pi => {
  // Observe the public API; the production factory owns its registry and delivery policy.
  shellExtension({ ...pi,
    appendEntry(type, data) { pi.appendEntry(type, data); if (data?.terminal && data.kind === 'shell') terminalWaiters.get(data.toolCallId)?.resolve(data); },
    sendMessage(message, options) { submitted.push({ message, options }); pi.sendMessage(message, options); },
  });
}, pi => {
  pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-non-secret', models: [model],
    streamSimple(m, context) {
      calls++; contexts.push(structuredClone(context.messages));
      const batch = context.messages.find(isBatch);
      if (batch) { sawBatch = true; batchReceived.resolve(batch); }
      const isFirst = calls === 1 && mode !== 'preflight-failed';
      const usesTool = isFirst && mode !== 'streaming';
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
        content: usesTool ? [{ type: 'toolCall', id: 'hold-main', name: 'batch_gate', arguments: {} }] : [{ type: 'text', text: batch ? 'BATCH_RECEIVED' : 'MAIN_FINISHED' }],
        stopReason: usesTool ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        stream.push({ type: 'start', partial: message });
        if (isFirst && mode === 'streaming') { gateEntered.resolve(); await gateRelease.promise; }
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  pi.registerTool({ name: 'batch_gate', label: 'Batch gate', description: 'Offline event barrier.', parameters: Type.Object({}), defaultActive: false,
    async execute(_id, _input, signal) {
      gateEntered.resolve();
      if (mode === 'aborted') await new Promise(r => { if (signal?.aborted) r(); else signal?.addEventListener('abort', r, { once: true }); });
      else await gateRelease.promise;
      return { content: [{ type: 'text', text: 'Gate released' }], details: undefined };
    },
  });
  // Only the first run fails before it starts. Every later run must still reach the model: the fixture
  // asserts one model call after the failure, so failing each run would deadlock on the batch promise.
  let preflightFailures = 0;
  pi.on('before_agent_start', event => { if (mode === 'preflight-failed' && preflightFailures++ === 0) event.systemPromptOptions.selectedTools = null; });
  pi.on('agent_end', () => { if (mode === 'queued' && !queued) { queued = true; pi.sendUserMessage('OTHER_QUEUED_WORK', { deliverAs: 'followUp' }); } });
  pi.on('agent_settled', () => { if (sawBatch) batchSettled.resolve(); });
}];
const manager = sdk.SessionManager.create(cwd, join(home, 'sessions'));
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const runtime = await sdk.createAgentSessionRuntime(async options => {
  const services = await sdk.createAgentSessionServices({ cwd: options.cwd, agentDir, settingsManager, modelRuntime,
    resourceLoaderOptions: { extensionFactories, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model })), services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: manager });
const session = runtime.session;
const heartbeat = setInterval(() => console.error('[batching-host] Offline lifecycle verification still running...'), 10000);
let prompt;
try {
  await session.bindExtensions({ mode: 'json', onError: event => errors.push(event.error) });
  session.subscribe(event => { if (event.type === 'message_end') trace.push(event.message); });
  if (mode === 'preflight-failed') {
    manager.appendMessage({ role: 'user', content: 'Durable isolated admission fixture', timestamp: Date.now() });
    await assert.rejects(session.prompt('Fail before the agent run starts'), TypeError);
    assert.equal(calls, 0); assert.equal(session.isIdle, true);
  } else {
    prompt = session.prompt('Begin offline steering test');
    await gateEntered.promise;
    assert.equal(session.isIdle, false);
  }
  const receipts = [];
  const bash = session.agent.state.tools.find(tool => tool.name === 'bash');
  assert.ok(bash);
  for (let index = 0; index < (mode === 'preflight-failed' ? 1 : 5); index++) {
    const callId = `background-${index}`, terminal = deferred(); terminalWaiters.set(callId, terminal);
    const result = await bash.execute(callId, { command: `printf 'BATCH_${index}'${index === 2 ? '; exit 7' : ''}`, background: true }, undefined, undefined);
    receipts.push(result.structuredContent);
    const outcome = await terminal.promise;
    assert.equal(outcome.state, index === 2 ? 'failed' : 'completed');
    // A native event-loop boundary observes submission without sleeps or polling.
    await new Promise(resolve => setImmediate(resolve));
    const completion = submitted.filter(item => item.message.customType === 'shell-job-completed');
    assert.equal(completion.length, index + 1, 'terminal results submit before the main tool/stream finishes');
    assert.deepEqual(completion.at(-1).options, { triggerTurn: true, deliverAs: 'steer' });
    if (mode !== 'preflight-failed') assert.equal(manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'shell-job-completed').length, 0, 'queued submission is not persistence and cannot split a tool batch');
  }
  if (mode === 'aborted') {
    await session.abort(); await prompt;
    assert.equal(sawBatch, false, 'abort is not permission to force another model request');
    assert.equal(manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'shell-job-completed').length, receipts.length, 'host may persist steering at the aborted tool boundary without issuing a model request');
    prompt = session.prompt('Explicitly resume after abort to read the completed results');
  } else gateRelease.resolve();
  if (prompt) await prompt;
  await batchReceived.promise; await batchSettled.promise; await session.waitForIdle();
  const completion = submitted.filter(item => item.message.customType === 'shell-job-completed');
  assert.equal(completion.length, receipts.length);
  const jobs = completion.flatMap(item => item.message.details.jobs);
  assert.deepEqual(jobs.map(job => job.jobId), receipts.map(receipt => receipt.jobId));
  assert.deepEqual(jobs.map(job => job.exitCode), receipts.map((_receipt, index) => index === 2 ? 7 : 0));
  const notices = manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'shell-job-completed');
  assert.equal(notices.length, receipts.length, 'each result is persisted exactly once in this fixture');
  const deliveredIds = notices.flatMap(modelJobs).map(job => job.jobId);
  assert.deepEqual(deliveredIds, receipts.map(receipt => receipt.jobId));
  if (mode !== 'preflight-failed') {
    assert.ok(contexts[1].some(isBatch), 'the first request after the busy boundary sees the completion');
    const firstNotice = trace.findIndex(isBatch);
    if (mode === 'streaming') {
      assert.equal(trace[firstNotice - 1].role, 'assistant');
      assert.equal(text(trace[firstNotice - 1]), 'MAIN_FINISHED', 'an in-flight provider answer cannot retroactively see results');
    } else {
      assert.equal(trace.slice(0, firstNotice).filter(m => m.role === 'toolResult' && m.toolName === 'batch_gate').length, 1, 'tool pairing precedes insertion');
      assert.equal(trace.slice(0, firstNotice).some(m => m.role === 'assistant' && text(m) === 'MAIN_FINISHED'), false, 'no result-blind final answer before insertion');
    }
  }
  if (mode === 'one-at-a-time') assert.deepEqual(contexts.slice(1).map(messages => messages.filter(isBatch).length), [1, 2, 3, 4, 5], 'respect host one-at-a-time queue policy');
  if (mode === 'queued') assert.ok(contexts.at(-1).some(message => message.role === 'user' && text(message).includes('OTHER_QUEUED_WORK')));
  assert.equal(session.isIdle, true); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, mode, notifications: completion.length, jobs: receipts.length, fixtureModelCalls: calls, providerCalls: 0 }));
} finally {
  gateRelease.resolve();
  await runtime.dispose();
  if (prompt) await prompt.catch(() => {});
  clearInterval(heartbeat);
}
