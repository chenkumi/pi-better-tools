import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import shellExtension from '../../extensions/timeout-ms.ts';

const mode = process.argv[2];
assert.ok(['normal', 'queued', 'aborted', 'preflight-failed'].includes(mode));
assert.equal(sdk.VERSION, '1.1.0');
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
assert.equal(resolve(process.env.PI_CODING_AGENT_DIR), resolve(agentDir));
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
globalThis.fetch = async () => { throw new Error('Network forbidden in notification batching fixture'); };
sdk.initTheme('dark', false);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const gateEntered = deferred(), gateRelease = deferred(), batchReceived = deferred(), batchSettled = deferred();
const terminalWaiters = new Map(), submitted = [], contexts = [], errors = [];
const text = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const isBatch = message => text(message).startsWith('Shell background jobs have finished.');
let calls = 0, queued = false, sawBatch = false;
const model = { id: 'offline-batching', name: 'Offline batching', provider: 'batching-fixture', api: 'openai-completions', baseUrl: 'https://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash', 'batch_gate'], retry: { enabled: false }, compaction: { enabled: false },
  cacheWarming: 'off', enableInstallTelemetry: false, defaultProjectTrust: 'never' });
const extensionFactories = [pi => {
  // Only observe the public API; the real production factory owns its registry and lifecycle handlers.
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
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
        content: isFirst ? [{ type: 'toolCall', id: 'hold-main', name: 'batch_gate', arguments: {} }] : [{ type: 'text', text: batch ? 'BATCH_RECEIVED' : 'MAIN_FINISHED' }],
        stopReason: isFirst ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
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
  pi.on('before_agent_start', event => { if (mode === 'preflight-failed') event.systemPromptOptions.selectedTools = null; });
  pi.on('agent_end', () => { if (mode === 'queued' && !queued) { queued = true; pi.sendUserMessage('OTHER_QUEUED_WORK', { deliverAs: 'followUp' }); } });
  pi.on('agent_before_settle', event => {
    const count = submitted.filter(item => item.message.customType === 'shell-job-completed').length;
    if (!sawBatch && mode !== 'preflight-failed') assert.equal(count, 0, 'pre-settle boundaries may still continue work: the batch waits for final settlement');
  });
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
  if (mode === 'preflight-failed') {
    manager.appendMessage({ role: 'user', content: 'Durable isolated admission fixture', timestamp: Date.now() });
    await assert.rejects(session.prompt('Fail before the agent run starts'), TypeError);
    assert.equal(calls, 0); assert.equal(session.isIdle, true);
  } else {
    prompt = session.prompt('Begin offline batching test');
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
    // One native event-loop boundary makes the old per-completion sender observable,
    // without fixed sleeps or polling for completion.
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'preflight-failed') {
      assert.equal(submitted.filter(item => item.message.customType === 'shell-job-completed').length, 1, 'a failed preflight with no agent_settled must not strand idle completions');
    } else {
      assert.equal(submitted.filter(item => item.message.customType === 'shell-job-completed').length, 0, 'busy completions are not prequeued separately');
      assert.equal(manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'shell-job-completed').length, 0);
    }
  }
  if (mode !== 'preflight-failed') {
    const denied = await session.extensionRunner.emitBoundary({ type: 'agent_before_settle', outcome: 'aborted' }, () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }));
    assert.equal(denied.continue, false); assert.equal(denied.valid, true); assert.deepEqual(denied.entries, []);
    assert.equal(submitted.filter(item => item.message.customType === 'shell-job-completed').length, 0);
  }
  if (mode === 'aborted') await session.abort(); else gateRelease.resolve();
  if (prompt) await prompt;
  const batch = await batchReceived.promise;
  await batchSettled.promise;
  await session.waitForIdle();
  const completion = submitted.filter(item => item.message.customType === 'shell-job-completed');
  assert.equal(completion.length, 1);
  assert.deepEqual(completion[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.deepEqual(completion[0].message.details.jobs.map(job => job.jobId), receipts.map(receipt => receipt.jobId));
  assert.deepEqual(completion[0].message.details.jobs.map(job => job.exitCode), receipts.map((_receipt, index) => index === 2 ? 7 : 0));
  assert.equal(JSON.parse(text(batch).slice(text(batch).indexOf('\n') + 1)).length, receipts.length);
  const notices = manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'shell-job-completed');
  assert.equal(notices.length, 1, 'one persisted and model-visible batch');
  assert.equal(contexts.filter(messages => messages.some(isBatch)).length, 1);
  if (mode === 'queued') assert.ok(contexts.at(-1).some(message => message.role === 'user' && text(message).includes('OTHER_QUEUED_WORK')));
  assert.equal(session.isIdle, true); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, mode, notifications: completion.length, jobs: receipts.length, fixtureModelCalls: calls, providerCalls: 0 }));
} finally {
  gateRelease.resolve();
  await runtime.dispose();
  if (prompt) await prompt.catch(() => {});
  clearInterval(heartbeat);
}
