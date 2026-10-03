import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertToolRenderers } from './renderer-probes.mjs';

const packageRoot = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const expectedExtensions = manifest.pi.extensions.length;
assert.ok(manifest.pi.extensions.includes('./modules/note-tools/src/index.ts'));
assert.ok(manifest.pi.extensions.includes('./modules/goal/src/index.ts'));
for (const entry of manifest.pi.extensions) assert.match(entry, /^\.\/modules\/[^/]+\/src\/index\.ts$/);
const mode = process.argv[3] ?? 'full';
const host = process.env.PI_BETTER_TOOLS_HOST;
const heartbeat = setInterval(() => console.error(`[smoke] ${mode} still running`), 10000);
let session;
let loader;
const errors = [];
try {
  const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  assert.equal(resolve(process.env.PI_CODING_AGENT_DIR), resolve(agentDir));
  await writeFile(join(agentDir, 'auth.json'), '{}');
  const search = mode === 'invalid' ? '{bad-json' : JSON.stringify({ provider: ['brave', 'exa'].includes(mode) ? mode : 'openai' });
  await writeFile(join(agentDir, 'web-search.json'), search);
  process.env.PI_WEB_TOOLS_CONFIG = join(agentDir, 'web-search.json');
  if (mode === 'child') process.env.PI_SCHEDULER_CHILD = '1';
  const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
  sdk.initTheme('dark', false);
  const readOnly = mode === 'read-only', noTools = mode === 'no-tools';
  const selection = readOnly ? ['read'] : ['read', 'write', 'edit', 'bash', ...(process.platform === 'win32' ? ['powershell'] : []), 'subagent', 'note', 'goal', 'web_fetch', 'schedule_create', 'schedule_update', 'schedule_status', 'schedule_cancel', ...(['brave', 'exa'].includes(mode) ? ['web_search'] : [])];
  const settings = sdk.SettingsManager.inMemory({ defaultTools: selection, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
  loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [packageRoot], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, expectedExtensions);
  assert.deepEqual(loaded.extensions.map(e => resolve(e.path)).sort(), manifest.pi.extensions.map(p => resolve(packageRoot, p)).sort());
  const definitions = loaded.extensions.flatMap(e => [...e.tools.values()].map(t => t.definition));
  assertToolRenderers(definitions, cwd);
  const names = definitions.map(d => d.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool registration');
  assert.equal(names.includes('goal'), mode !== 'child');
  assert.equal(loaded.extensions.some(e => e.commands.has('goal')), mode !== 'child');
  const note = definitions.find(d => d.name === 'note');
  assert.ok(note);
  assert.deepEqual(Object.keys(note.parameters.properties).sort(), ['content', 'type']);
  assert.equal(note.parameters.additionalProperties, false);
  assert.deepEqual(note.parameters.properties.type.enum, ['plan', 'issue', 'research', 'report', 'task']);
  assert.equal(names.includes('web_search'), ['brave', 'exa'].includes(mode));
  assert.deepEqual(loader.getPrompts().prompts.map(p => p.name).sort(), ['implement', 'implement-and-review', 'scout-and-plan']);
  assert.ok(loaded.extensions.some(e => e.commands.has('schedule')));
  assert.ok(loaded.extensions.some(e => e.commands.has('web-tools')));
  const subagent = definitions.find(d => d.name === 'subagent');
  assert.equal(subagent.parameters.properties.resumable, undefined, 'removed persistence switch must not be exposed');
  assert.ok(subagent.parameters.properties.resume);
  assert.match(subagent.description, /Every initial task automatically saves/);
  assert.ok(subagent.promptGuidelines.some(line => line.includes('automatically persisted')));
  const shell = definitions.find(d => d.name === 'bash');
  assert.ok(shell.parameters.properties.timeoutMs); assert.equal(shell.parameters.properties.timeout, undefined);
  assert.equal(shell.defaultActive, false);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model,
    sessionManager: sdk.SessionManager.inMemory(cwd), ...(noTools ? { noTools: 'all' } : { tools: selection }),
    ...(mode === 'exclude' ? { excludeTools: ['subagent', 'bash', 'powershell', 'note', 'goal'] } : {}) }));
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  // Real command contexts + request-hook composition, even with no-tools/read-only.
  const speedCommand = async name => {
    const command = session.extensionRunner.getCommand(name); assert.ok(command, `speed command ${name}`);
    await command.handler('', session.extensionRunner.createCommandContext());
  };
  const probeSpeed = async () => session.extensionRunner.emitBeforeProviderRequest({ tools: [], stream: true });
  session.agent.state.model = { ...model, provider: 'openai-codex', id: 'gpt-5.6-sol' };
  await speedCommand('normal');
  const baseline = await probeSpeed();
  await speedCommand('fast'); assert.deepEqual(await probeSpeed(), { ...baseline, service_tier: 'priority' });
  await speedCommand('ultrafast'); assert.deepEqual(await probeSpeed(), { ...baseline, service_tier: 'ultrafast' });
  session.agent.state.model = { ...model, provider: 'openai-codex', id: 'gpt-6-terra' };
  assert.deepEqual(await probeSpeed(), { ...baseline, service_tier: 'priority' });
  session.agent.state.model = { ...model, provider: 'openai-codex', id: 'gpt-5.5-sol' };
  assert.deepEqual(await probeSpeed(), baseline);
  session.agent.state.model = { ...model, provider: 'openai-codex', id: 'gpt-6-astra' };
  assert.deepEqual(await probeSpeed(), { ...baseline, service_tier: 'ultrafast' });
  await speedCommand('normal'); assert.deepEqual(await probeSpeed(), baseline);
  assert.equal(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))['pi-gpt-speed'].mode, 'normal');
  session.agent.state.model = model;
  const active = session.getActiveToolNames(), callable = session.getCallableToolNames();
  if (readOnly || noTools) {
    assert.deepEqual(active, noTools ? [] : ['read']); assert.deepEqual(callable, noTools ? [] : ['read']);
  }
  if (mode === 'exclude') for (const name of ['subagent', 'bash', 'powershell', 'note', 'goal']) { assert.ok(!active.includes(name)); assert.ok(!callable.includes(name)); }
  const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const execute = async (name, args, signal) => {
    const tool = session.agent.state.tools.find(t => t.name === name); assert.ok(tool, `active tool ${name}`);
    // Direct tool execution bypasses host argument preparation; apply the registered contract explicitly.
    const definition = definitions.find(d => d.name === name);
    const prepared = definition.prepareArguments ? await definition.prepareArguments(args) : args;
    return tool.execute(`smoke-${name}`, prepared, signal ?? AbortSignal.timeout(20000), undefined);
  };
  if (active.includes('goal')) {
    const goal = await execute('goal', { action: 'get' });
    assert.equal(goal.details.goal, null); assert.equal(goal.details.diagnostic, null);
    assert.ok(!callable.includes('goal'), 'only the main model may submit outcomes, not nested codemode');
  } else if (mode !== 'child') {
    const command = session.extensionRunner.getCommand('goal');
    await assert.rejects(command.handler('Do not execute this excluded goal', session.extensionRunner.createCommandContext()), /GOAL_TOOL_DISABLED/);
  }
  if (active.includes('note')) {
    const contents = ['# Plan\nalpha\n', '# Issue\nUTF-8: 中文 😀', '', '# Report\r\nexact', '# Task'];
    for (const [i, type] of ['plan', 'issue', 'research', 'report', 'task'].entries()) {
      const created = await execute('note', { type, content: contents[i] });
      assert.equal(created.details.type, type);
      assert.equal(created.details.path, join(cwd, created.details.relativePath));
      assert.match(created.details.relativePath, new RegExp(`^${type}/${type.toUpperCase()}-\\d{8}T\\d{9}Z\\.md$`));
      assert.equal(await readFile(created.details.path, 'utf8'), contents[i]);
      assert.deepEqual(created.structuredContent, created.details);
      assert.ok(text(created).includes(created.details.path));
      if (type === 'plan') {
        const before = await execute('read', { path: created.details.path, offset: null, limit: null });
        await execute('edit', { path: created.details.path, expectedHash: before.details.sha256, edits: [{ oldText: 'alpha', newText: 'BETA' }] });
        assert.equal(await readFile(created.details.path, 'utf8'), '# Plan\nBETA\n');
        const second = await execute('note', { type, content: 'second plan' });
        assert.notEqual(second.details.path, created.details.path);
        assert.equal(await readFile(created.details.path, 'utf8'), '# Plan\nBETA\n');
      }
    }
  } else {
    for (const type of ['plan', 'issue', 'research', 'report', 'task']) await assert.rejects(stat(join(cwd, type)), { code: 'ENOENT' });
  }
  if (!readOnly && !noTools) {
    await execute('write', { path: 'test.txt', content: 'alpha\nbeta\n', expectedHash: 'missing' });
    const before = await execute('read', { path: 'test.txt', offset: null, limit: null });
    assert.equal(before.details.sha256.length, 32); assert.match(text(before), /1│alpha/);
    const edits = await Promise.all(['BETA', 'gamma'].map(newText => execute('edit', { path: 'test.txt', expectedHash: before.details.sha256, edits: [{ oldText: 'beta', newText }] }).then(result => ({ result }), error => ({ error }))));
    assert.equal(edits.filter(r => r.result).length, 1); assert.equal(edits.filter(r => r.error).length, 1);
    assert.match(String(edits.find(r => r.error).error), /STALE_FILE/); assert.match(text(edits.find(r => r.result).result), /FILE_EDIT_SUCCESS/);
    if (active.includes('bash') || active.includes('powershell')) {
      const name = process.platform === 'win32' ? 'powershell' : 'bash';
      const result = await execute(name, { command: process.platform === 'win32' ? "Write-Output 'SHELL_OK'" : "printf 'SHELL_OK'", timeoutMs: 20000 });
      assert.match(text(result), /SHELL_OK/); assert.ok(result.structuredContent);
    }
    const status = await execute('schedule_status', {}); const data = JSON.parse(text(status));
    assert.equal(data.runtime.role, mode === 'child' ? 'child-disabled' : 'host');
    assert.equal(data.schedules.length, 0);
    if (mode === 'child') {
      await assert.rejects(execute('schedule_create', { prompt: 'Never execute', timing: { kind: 'once', expression: '2099-01-01T00:00:00Z', timezone: 'UTC' } }), /host|child|open/i);
    } else {
      const created = JSON.parse(text(await execute('schedule_create', { prompt: 'Offline future job; do not execute', timing: { kind: 'once', expression: '2099-01-01T00:00:00Z', timezone: 'UTC' } })));
      assert.ok(created.schedule.id); await execute('schedule_cancel', { id: created.schedule.id });
    }
    await assert.rejects(execute('web_fetch', { url: 'http://127.0.0.1/' }), /NETWORK_BLOCKED/);
    // Real before_agent_start composition, without making a provider request.
    const options = { cwd, tools: definitions, skills: [], contextFiles: [], sections: { fixture: 'KEEP_FIXTURE' } };
    const result = await session.extensionRunner.emitBeforeAgentStart('[[pi-scheduler:fixture]] smoke', undefined, options);
    assert.equal(result.systemPromptOptions.sections.fixture, 'KEEP_FIXTURE');
    const combined = JSON.stringify(result.systemPromptOptions);
    if (active.includes('subagent')) for (const agent of ['planner', 'reviewer', 'scout', 'worker']) assert.ok(combined.includes(agent), `bundled agent ${agent}`);
    else assert.ok(!combined.includes('### subagent agent catalog'));
    if (!['brave', 'exa', 'invalid'].includes(mode)) {
      session.agent.state.model = { ...model, provider: 'openai' };
      const injected = await session.extensionRunner.emitBeforeProviderRequest({ tools: [] });
      assert.ok(injected.tools.some(t => t.type === 'web_search'));
    }
    await session.reload();
    assert.equal(loader.getExtensions().extensions.length, expectedExtensions);
    assert.equal(JSON.parse(text(await execute('schedule_status', {}))).runtime.role, mode === 'child' ? 'child-disabled' : 'host');
  }
  assert.deepEqual(errors, [], 'extension event failures');
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  if (mode !== 'child') await assert.rejects(stat(join(agentDir, 'pi-scheduler/runner.lock.lock')), { code: 'ENOENT' });
  console.log(JSON.stringify({ loaded: true, hostVersion: sdk.VERSION, mode, extensions: loaded.extensions.length, tools: names, active, prompts: 3 }));
} finally {
  try { if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } }
  finally { clearInterval(heartbeat); }
}
