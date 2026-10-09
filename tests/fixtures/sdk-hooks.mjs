import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';

const packageRoot = resolve(process.argv[2]);
const expectedVersion = process.argv[3];
assert.equal(expectedVersion, '1.1.0', 'Only the pinned Pi 1.1.0 host is supported');
const host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const ai = await import(host ? pathToFileURL(join(host, '../pi-ai/dist/index.js')).href : '@earendil-works/pi-ai');
assert.equal(sdk.VERSION, expectedVersion);
sdk.initTheme('dark', false);
// Pi 1.1.0 contract: reload applies defaultTools, restores pending tool names and hides declaration snippets.
const contracts = { reloadDefaults: true, pendingTools: true, hiddenSnippets: true };
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
assert.equal(resolve(process.env.PI_CODING_AGENT_DIR), resolve(agentDir));
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(agentDir, 'web-search.json'), JSON.stringify({ provider: 'openai', providers: { openai: { captureSources: true } } }));
await writeFile(join(cwd, 'fixture.txt'), 'OFFLINE_READ_MARKER\n');
process.env.PI_WEB_TOOLS_CONFIG = join(agentDir, 'web-search.json');
globalThis.fetch = async () => { throw new Error('Network forbidden in SDK hook fixtures'); };
const heartbeat = setInterval(() => console.error('[sdk-hooks] Offline lifecycle or cleanup still running...'), 10000);
const cases = [], observedHooks = new Set();
// Native IDs exercise Web's gate, but the provider is replaced below by a local stream; fetch is forbidden.
const model = { id: 'offline', name: 'Offline', provider: 'openai', api: 'openai-responses', baseUrl: 'https://unused.invalid',
  reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const alternateModel = { ...model, id: 'offline-other', name: 'Offline other' };
const settingsPath = join(agentDir, 'settings.json');
const writeSettings = defaultTools => writeFile(settingsPath, JSON.stringify({ defaultTools, retry: { enabled: false }, compaction: { enabled: false },
  cacheWarming: 'off', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
const tool = name => ({ name, label: name, description: 'Offline delayed registration fixture.', parameters: Type.Object({}), defaultActive: false,
  async execute() { return { content: [{ type: 'text', text: 'OFFLINE_TOOL' }] }; } });
const declaration = name => ({ name, description: 'Offline restored declaration.', parameters: Type.Object({}) });
const baseNames = ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls'];
const selectedBase = session => session.getActiveToolNames().filter(name => baseNames.includes(name)).sort();
// File overrides are extension tools activated on registration; defaultTools is not a read-only allowlist.
const defaultFiles = ['edit', 'read', 'write'];

async function fixture(options = {}) {
  await writeSettings(options.defaults ?? ['read']);
  const settingsManager = await sdk.SettingsManager.create(cwd, agentDir);
  const sessionManager = sdk.SessionManager.inMemory(cwd);

  const errors = [], lifecycle = [], trace = [];
  let api, observedPrompt, resolveThinking, calls = 0, completedStreamEvents = 0, deliveredStreams = 0;
  const observer = pi => {
    api = pi;
    pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-non-secret', models: [model, alternateModel],
      streamSimple(m, _context, streamOptions) {
        const stream = ai.createAssistantMessageEventStream();
        const invocation = ++calls;
        queueMicrotask(async () => {
          const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, responseId: `resp_hooks_${invocation}`, timestamp: Date.now(),
            content: options.withRead && invocation === 1 ? [{ type: 'toolCall', id: 'offline-read', name: 'read', arguments: { path: 'fixture.txt' } }] : [{ type: 'text', text: 'OFFLINE_HOOKS_OK' }],
            stopReason: options.withRead && invocation === 1 ? 'toolUse' : 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          try {
            await streamOptions?.onPayload?.({ model: m.id, tools: [], stream: true }, m);
            await streamOptions?.onProviderStreamEvent?.({ type: 'response.completed', response: { id: message.responseId, status: 'completed', output: [] } }, m);
            assert.equal(deliveredStreams, invocation, 'stream callback must await the async extension handler');
            completedStreamEvents++;
            stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message });
          } catch (error) {
            stream.push({ type: 'error', reason: 'error', error: { ...message, content: [], stopReason: 'error', errorMessage: String(error) } });
          } finally { stream.end(); }
        });
        return stream;
      },
    });
    pi.on('session_start', event => { observedHooks.add(event.type); lifecycle.push(`start:${event.reason}`); });
    pi.on('session_shutdown', event => { observedHooks.add(event.type); lifecycle.push(`shutdown:${event.reason}`); });
    for (const name of ['input', 'before_agent_start', 'agent_start', 'turn_start', 'message_start', 'message_end', 'tool_execution_start',
      'tool_execution_end', 'tool_call', 'turn_end', 'agent_end', 'agent_before_settle', 'agent_settled', 'context', 'before_provider_request', 'provider_stream_event',
      'session_tree', 'model_select', 'thinking_level_select']) {
      pi.on(name, async event => {
        observedHooks.add(event.type);
        trace.push({ type: name, role: event.message?.role, tool: event.toolName, model: event.model, api: event.api, provider: event.provider, durationMs: event.durationMs, aborted: event.aborted });
        if (name === 'thinking_level_select') resolveThinking?.(event);
        if (name === 'before_agent_start') observedPrompt = structuredClone(event.systemPromptOptions);
        if (name === 'provider_stream_event') { await new Promise(resolve => setImmediate(resolve)); deliveredStreams++; }
      });
    }
    if (options.hideDeclarations) pi.registerTool({ ...tool('fixture_orchestrator'), defaultActive: true,
      prepareLoadout() { return { hiddenDeclarations: ['read', 'subagent', 'web_fetch'] }; } });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [packageRoot], extensionFactories: [observer],
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, manifest.pi.extensions.length + 1);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, sessionManager, resourceLoader: loader, modelRuntime, model,
    ...(options.tools ? { tools: options.tools } : {}), ...(options.noTools ? { noTools: options.noTools } : {}),
    ...(options.exclude ? { excludeTools: options.exclude } : {}) });
  try {
    await session.bindExtensions({ mode: 'json', onError: event => errors.push(event.error) });
    const monitor = loader.getExtensions().extensions.find(extension => extension.tools.has('monitor_start')); assert.ok(monitor);
    for (const name of ['monitor_start', 'monitor_status', 'monitor_stop']) { assert.equal(monitor.tools.get(name).definition.defaultActive, false); assert.ok(!session.getActiveToolNames().includes(name)); }
    if (options.restored) {
      // The SDK factory supplies an initial loadout. Exercise transcript restoration through its
      // public tree-navigation API, not private fields or an assumed factory restore path.
      const restoredLeaf = sessionManager.appendMessage({ role: 'system', content: '', sections: { fixture: 'RESTORED_FIXTURE' },
        toolsAdded: options.restored.map(declaration), timestamp: Date.now() });
      sessionManager.appendCustomEntry('fixture-restoration-boundary', {});
      assert.equal((await session.navigateTree(restoredLeaf, { summarize: false })).cancelled, false);
      assert.deepEqual(session.getActiveToolNames().sort(), options.restored.filter(name => name !== 'fixture_late').sort());
      assert.equal(trace.filter(event => event.type === 'session_tree').length, 1);
    }
  } catch (error) {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    finally { session.dispose(); }
    throw error;
  }
  return { session, loader, lifecycle, trace, errors, calls: () => calls, completedStreamEvents: () => completedStreamEvents,
    observedPrompt: () => observedPrompt, registerLate() { api.registerTool(tool('fixture_late')); },
    async selectProfile() {
      const previousLevel = session.thinkingLevel, level = previousLevel === 'high' ? 'low' : 'high';
      const delivered = new Promise(resolve => { resolveThinking = resolve; });
      try {
        session.setThinkingLevel(level);
        assert.deepEqual(await delivered, { type: 'thinking_level_select', level, previousLevel });
        await session.setModel(alternateModel);
        assert.equal(trace.filter(event => event.type === 'model_select').at(-1).model.id, alternateModel.id);
        await session.setModel(model);
        assert.equal(trace.filter(event => event.type === 'model_select').at(-1).model.id, model.id);
      } finally { resolveThinking = undefined; }
    },
    async close() {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { session.dispose(); }
      const final = session.messages.filter(message => message.role === 'assistant').at(-1);
      if (final) assert.equal(final.stopReason, 'stop', final.errorMessage);
      assert.deepEqual(errors, [], 'extension hook errors');
    } };
}
async function check(name, options, action) {
  console.error(`[sdk-hooks] Checking ${name} on Pi ${expectedVersion}`);
  const f = await fixture(options);
  let primary;
  try { await action(f); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await f.close(); }
    catch (error) { if (primary) throw new AggregateError([primary, error], `${name}: assertion and cleanup failed`); throw error; }
  }
  cases.push({ name, status: 'passed' });
}
try {
  await check('defaultTools additions follow the audited release reload contract', {}, async f => {
    assert.deepEqual(selectedBase(f.session), defaultFiles);
    await writeSettings(['read', 'bash', 'monitor_status']); await f.session.reload();
    assert.ok(f.session.getActiveToolNames().includes('monitor_status'));
    assert.deepEqual(selectedBase(f.session), contracts.reloadDefaults ? ['bash', ...defaultFiles] : defaultFiles);
    assert.deepEqual(f.lifecycle, ['start:startup', 'shutdown:reload', 'start:reload']);
    assert.equal(f.calls(), 0);
  });
  await check('unchanged disabled defaults stay disabled and removal is not revocation', { defaults: ['read', 'bash'] }, async f => {
    f.session.setActiveToolsByName(f.session.getActiveToolNames().filter(name => name !== 'bash'));
    await f.session.reload(); assert.deepEqual(selectedBase(f.session), defaultFiles);
    f.session.setActiveToolsByName([...f.session.getActiveToolNames(), 'bash']);
    await writeSettings(['read']); await f.session.reload();
    assert.deepEqual(selectedBase(f.session), ['bash', ...defaultFiles]);
  });
  for (const [name, options, expected] of [
    ['explicit read-only selection survives defaultTools reload', { tools: ['read'] }, ['read']],
    ['noTools all survives defaultTools reload', { noTools: 'all' }, []],
    ['excluded shells and note stay excluded after defaultTools reload', { exclude: ['bash', 'powershell', 'note', 'monitor_start', 'monitor_status', 'monitor_stop'] }, defaultFiles],
  ]) await check(name, options, async f => {
    await writeSettings(['read', 'bash', 'powershell', 'note', 'monitor_start', 'monitor_status', 'monitor_stop']); await f.session.reload();
    assert.deepEqual(selectedBase(f.session), expected);
    for (const toolName of ['bash', 'powershell', 'note', 'monitor_start', 'monitor_status', 'monitor_stop']) assert.ok(!f.session.getActiveToolNames().includes(toolName), toolName);
    if (options.tools || options.noTools) assert.deepEqual(f.session.getCallableToolNames().sort(), expected);
  });
  await check('search overrides are selectable without changing defaults', { tools: ['grep', 'find', 'ls'] }, async f => {
    assert.deepEqual(selectedBase(f.session), ['find', 'grep', 'ls']);
    const fileExtension = f.loader.getExtensions().extensions.find(extension => extension.tools.has('grep'));
    assert.ok(fileExtension);
    for (const name of ['grep', 'find', 'ls']) {
      assert.equal(fileExtension.tools.get(name).definition.defaultActive, false);
      assert.equal(typeof fileExtension.tools.get(name).definition.renderResult, 'function');
    }
    await f.session.reload();
    assert.deepEqual(selectedBase(f.session), ['find', 'grep', 'ls']);
    assert.equal(f.calls(), 0);
  });
  await check('excluded search overrides remain unavailable after reload', { defaults: ['read', 'grep', 'find', 'ls'], exclude: ['grep', 'find', 'ls'] }, async f => {
    assert.deepEqual(selectedBase(f.session), defaultFiles);
    await f.session.reload();
    assert.deepEqual(selectedBase(f.session), defaultFiles);
    for (const name of ['grep', 'find', 'ls']) assert.ok(!f.session.getCallableToolNames().includes(name));
    assert.equal(f.calls(), 0);
  });
  await check('restored delayed tool activates only after registration', { restored: ['read', 'fixture_late'] }, async f => {
    assert.ok(!f.session.getActiveToolNames().includes('fixture_late'));
    f.registerLate(); assert.equal(f.session.getActiveToolNames().includes('fixture_late'), contracts.pendingTools);
  });
  await check('additive selection preserves restored pending tool', { restored: ['read', 'fixture_late'] }, async f => {
    f.session.setActiveToolsByName([...f.session.getActiveToolNames(), 'write']);
    f.registerLate(); assert.equal(f.session.getActiveToolNames().includes('fixture_late'), contracts.pendingTools);
  });
  await check('deactivating a tool drops restored pending names', { restored: ['read', 'write', 'fixture_late'] }, async f => {
    f.session.setActiveToolsByName(['read']); f.registerLate();
    assert.deepEqual(f.session.getActiveToolNames(), ['read']);
  });
  await check('reload preserves an active tool that the new factory registers later', {}, async f => {
    f.registerLate(); f.session.setActiveToolsByName([...f.session.getActiveToolNames(), 'fixture_late']);
    await f.session.reload(); assert.ok(!f.session.getActiveToolNames().includes('fixture_late'));
    f.registerLate(); assert.equal(f.session.getActiveToolNames().includes('fixture_late'), contracts.pendingTools);
  });
  await check('the next agent run drops unresolved restored names', { restored: ['read', 'fixture_late'] }, async f => {
    await f.session.prompt('OFFLINE_CLEAR_PENDING', { expandPromptTemplates: false });
    assert.equal(f.calls(), 1); f.registerLate(); assert.ok(!f.session.getActiveToolNames().includes('fixture_late'));
  });
  await check('hidden declaration snippets stay out without losing prompt-hook sections', { hideDeclarations: true }, async f => {
    f.session.setActiveToolsByName(['read', 'subagent', 'web_fetch', 'fixture_orchestrator']);
    await f.session.prompt('OFFLINE_PROMPT_COMPOSITION', { expandPromptTemplates: false });
    const prompt = f.observedPrompt(); assert.ok(prompt);
    // Pi 1.1 keeps the registry metadata and filters declarations/rules via hiddenTools.
    assert.ok(prompt.toolSnippets.read);
    assert.deepEqual([...prompt.hiddenTools].sort(), ['read', 'subagent', 'web_fetch']);
    assert.doesNotMatch(f.session.systemPrompt, /\n- read: Read file contents/);
    assert.doesNotMatch(f.session.systemPrompt, /When copying oldText from read output/);
    assert.doesNotMatch(f.session.systemPrompt, /\n- subagent: Delegate tasks/);
    assert.doesNotMatch(f.session.systemPrompt, /\n- web_fetch: Retrieve rendered/);
    const serialized = JSON.stringify(prompt);
    assert.match(serialized, /subagent agent catalog/); assert.match(serialized, /OpenAI native web_search/);
    assert.ok(f.session.getCallableToolNames().includes('read')); assert.ok(f.session.getCallableToolNames().includes('subagent'));
    assert.equal(f.calls(), 1);
  });
  await check('real agent read pipeline retains ordering and awaited stream delivery', { tools: ['read'], withRead: true }, async f => {
    await f.selectProfile();
    await f.session.prompt('OFFLINE_READ_PIPELINE', { expandPromptTemplates: false });
    assert.equal(f.calls(), 2); assert.equal(f.completedStreamEvents(), 2);
    const index = (type, predicate = () => true) => f.trace.findIndex(event => event.type === type && predicate(event));
    for (const type of ['input', 'before_agent_start', 'agent_start', 'turn_start', 'message_start', 'message_end', 'tool_execution_start',
      'tool_execution_end', 'tool_call', 'turn_end', 'agent_end', 'agent_before_settle', 'agent_settled', 'context', 'before_provider_request', 'provider_stream_event',
      'model_select', 'thinking_level_select']) assert.ok(index(type) >= 0, `missing ${type}`);
    assert.ok(index('input') < index('before_agent_start')); assert.ok(index('before_agent_start') < index('agent_start'));
    assert.ok(index('agent_start') < index('turn_start')); assert.ok(index('tool_execution_start') < index('tool_call'));
    assert.ok(index('tool_execution_end') < index('message_start', event => event.role === 'toolResult'));
    assert.ok(index('agent_before_settle') < index('agent_settled'));
    const toolEnd = f.trace.find(event => event.type === 'tool_execution_end');
    assert.ok(Number.isFinite(toolEnd.durationMs) && toolEnd.durationMs >= 0);
    assert.equal(f.trace.find(event => event.type === 'agent_settled').aborted, false);
    const streams = f.trace.filter(event => event.type === 'provider_stream_event');
    assert.equal(streams.length, 2); for (const event of streams) assert.deepEqual({ api: event.api, provider: event.provider, model: event.model }, { api: model.api, provider: model.provider, model: model.id });
    assert.ok(f.session.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('OFFLINE_READ_MARKER')));
  });
  assert.deepEqual([...observedHooks].sort(), ['agent_before_settle', 'agent_end', 'agent_settled', 'agent_start', 'before_agent_start', 'before_provider_request',
    'context', 'input', 'message_end', 'message_start', 'model_select', 'provider_stream_event', 'session_shutdown', 'session_start', 'session_tree',
    'thinking_level_select', 'tool_call', 'tool_execution_end', 'tool_execution_start', 'turn_end', 'turn_start']);
  console.log(JSON.stringify({ status: 'passed', hostVersion: sdk.VERSION, cases, hooksObserved: [...observedHooks].sort() }));
} finally { clearInterval(heartbeat); }
