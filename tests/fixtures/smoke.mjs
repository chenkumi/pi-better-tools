import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertToolRenderers, assertMessageRenderers, assertLiveWidgetHooks } from './renderer-probes.mjs';

const packageRoot = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const expectedExtensions = manifest.pi.extensions.length;
assert.ok(manifest.pi.extensions.includes('./modules/note-tools/src/index.ts'));
assert.ok(manifest.pi.extensions.includes('./modules/pi-runtime/src/index.ts'));
assert.equal(expectedExtensions, 14, 'twelve local entries plus two pinned dependency entries');
assert.ok(manifest.pi.extensions.includes('./modules/monitor/src/index.ts'));
assert.ok(manifest.pi.extensions.includes('./modules/schedule-prompt/src/index.ts'));
assert.ok(!manifest.pi.extensions.some(entry => entry.includes('/goal/')));
const dependencyEntries = {
  'pi-open-tui': { version: '0.3.11', entry: './extensions/open-tui/index.ts' },
  '@ff-labs/pi-fff': { version: '0.11.0', entry: './src/index.ts' },
};
for (const entry of manifest.pi.extensions.filter(entry => entry.startsWith('./modules/'))) assert.match(entry, /^\.\/modules\/[^/]+\/src\/index\.ts$/);
assert.equal(manifest.pi.extensions.filter(entry => entry.startsWith('./modules/')).length, 12);
assert.ok(manifest.pi.extensions.includes('./modules/blackhole/src/index.ts'));
assert.equal(manifest.dependencies['pi-blackhole'], undefined);
for (const [name, expected] of Object.entries(dependencyEntries)) {
  assert.equal(manifest.dependencies[name], expected.version);
  const dependency = JSON.parse(await readFile(join(packageRoot, 'node_modules', name, 'package.json'), 'utf8'));
  assert.equal(dependency.version, expected.version);
  assert.deepEqual(dependency.pi.extensions, [expected.entry]);
  const entry = `./node_modules/${name}/${expected.entry.slice(2)}`;
  assert.ok(manifest.pi.extensions.includes(entry), `exact dependency entry for ${name}`);
  assert.ok((await stat(resolve(packageRoot, entry))).isFile());
}
assert.equal(process.env.PI_BLACKHOLE_PASSIVE, 'true', 'fixture must never run real Blackhole model workers');
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
  const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
  sdk.initTheme('dark', false);
  const readOnly = mode === 'read-only', noTools = mode === 'no-tools';
  const ptyNames = ['pty_spawn', 'pty_read', 'pty_write', 'pty_resize', 'pty_wait_exit', 'pty_kill', 'pty_list'];
  const monitorNames = ['monitor_start', 'monitor_status', 'monitor_stop'];
  const backgroundNames = ['subagent_status', 'subagent_cancel', 'subagent_message', 'shell_job_status', 'shell_job_cancel'];
  const selection = readOnly ? ['read'] : [...monitorNames, ...backgroundNames, 'read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', ...(process.platform === 'win32' ? ['powershell'] : []), 'subagent', 'note', 'schedule_prompt', ...ptyNames, 'fffind', 'ffgrep', 'web_fetch', ...(['brave', 'exa'].includes(mode) ? ['web_search'] : [])];
  const settings = sdk.SettingsManager.inMemory({ defaultTools: selection, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
  loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [packageRoot], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, expectedExtensions);
  assert.deepEqual(loaded.extensions.map(e => resolve(e.path)).sort(), manifest.pi.extensions.map(p => resolve(packageRoot, p)).sort());
  const definitions = loaded.extensions.flatMap(e => [...e.tools.values()].map(t => t.definition));
  const ownedDefinitions = loaded.extensions.filter(e => manifest.pi.extensions.filter(p => p.startsWith('./modules/') && p !== './modules/blackhole/src/index.ts').some(p => resolve(packageRoot, p) === resolve(e.path))).flatMap(e => [...e.tools.values()].map(t => t.definition));
  // Upstream packages (including vendored Blackhole recall) retain their renderer contracts.
  // Existing owned-tool checks are unchanged; Blackhole's plain custom entry renderer is tested separately.
  assertToolRenderers(ownedDefinitions, cwd);
  assertMessageRenderers(loaded.extensions);
  await assertLiveWidgetHooks(loaded.extensions, cwd);
  const names = definitions.map(d => d.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool registration');
  assert.equal(names.includes('goal'), false, 'removed Goal tool must not register');
  assert.equal(loaded.extensions.some(e => e.commands.has('goal')), false, 'removed Goal command must not register');
  for (const name of monitorNames) { assert.ok(names.includes(name)); assert.equal(definitions.find(d => d.name === name).defaultActive, false); }
  for (const name of ptyNames) assert.ok(names.includes(name));
  assert.ok(definitions.find(d => d.name === 'pty_spawn').parameters.properties.target);
  const note = definitions.find(d => d.name === 'note');
  assert.ok(note);
  assert.deepEqual(Object.keys(note.parameters.properties).sort(), ['content', 'type']);
  assert.equal(note.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(note.outputSchema.properties), ['relativePath']);
  assert.equal(note.outputSchema.additionalProperties, false);
  assert.deepEqual(note.parameters.properties.type.enum, ['plan', 'issue', 'research', 'report', 'task']);
  assert.equal(names.includes('web_search'), ['brave', 'exa'].includes(mode));
  assert.deepEqual(loader.getPrompts().prompts.map(p => p.name).sort(), ['implement', 'implement-and-review', 'scout-and-plan']);
  assert.deepEqual(names.filter(name => name.startsWith('schedule_')), ['schedule_prompt'], 'only Schedule Prompt registers schedule_* tools; removed Scheduler tools must not');
  assert.equal(loaded.extensions.some(e => e.commands.has('schedule')), false, 'removed Scheduler command must not register');
  assert.ok(loaded.extensions.some(e => e.commands.has('schedule-prompt')));
  const schedule = definitions.find(d => d.name === 'schedule_prompt');
  assert.deepEqual(schedule.parameters.properties.action.enum, ['add', 'remove', 'list', 'enable', 'disable', 'update', 'cleanup']);
  assert.ok(loaded.extensions.some(e => e.commands.has('web-tools')));
  assert.ok(loaded.extensions.some(e => e.commands.has('open-tui')), 'npm TUI dependency registered');
  assert.ok(loaded.extensions.some(e => e.commands.has('blackhole')), 'vendored Blackhole registered');
  for (const name of ['fffind', 'ffgrep', 'recall']) assert.ok(names.includes(name), `npm dependency tool ${name}`);
  assert.equal(names.includes('fff-multi-grep'), process.env.PI_FFF_MULTIGREP === '1', 'FFF multi-grep remains upstream opt-in');
  const subagent = definitions.find(d => d.name === 'subagent');
  assert.equal(subagent.parameters.properties.resumable, undefined, 'removed persistence switch must not be exposed');
  assert.equal(subagent.parameters.properties.resume, undefined, 'create-only subagent must not expose resume');
  assert.equal(subagent.parameters.properties.background.type, 'boolean');
  for (const name of backgroundNames) assert.ok(names.includes(name), `background tool ${name}`);
  const message = definitions.find(d => d.name === 'subagent_message');
  assert.equal(message.parameters.properties.subagentSessionId.type, 'string');
  assert.deepEqual(message.parameters.properties.mode.enum, ['control', 'query']);
  assert.ok(message.parameters.required.includes('subagentSessionId'));
  assert.ok(message.parameters.required.includes('message'));
  assert.ok(!message.parameters.required.includes('mode'), 'persistent messages default to control');
  assert.equal(message.parameters.properties.jobId, undefined, 'message targets a stable session, not an invocation');
  assert.equal(message.parameters.properties.taskId, undefined);
  assert.equal(message.parameters.properties.title.maxLength, 50);
  assert.match(subagent.description, /Every initial task automatically saves/);
  assert.ok(subagent.promptGuidelines.some(line => line.includes('automatically persisted')));
  const shell = definitions.find(d => d.name === 'bash');
  assert.ok(shell.parameters.properties.timeoutMs); assert.equal(shell.parameters.properties.timeout, undefined);
  assert.equal(shell.defaultActive, false);
  assert.ok(definitions.find(d => d.name === 'read').outputSchema);
  for (const name of ['grep', 'find', 'ls']) {
    assert.ok(names.includes(name));
    assert.equal(definitions.find(d => d.name === name).defaultActive, false);
  }
  assert.equal(shell.parameters.properties.background.type, 'boolean');
  for (const name of ['shell_job_status', 'shell_job_cancel']) assert.equal(definitions.find(d => d.name === name).defaultActive, false);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model,
    sessionManager: sdk.SessionManager.inMemory(cwd), ...(noTools ? { noTools: 'all' } : { tools: selection }),
    ...(mode === 'exclude' ? { excludeTools: ['subagent', 'bash', 'powershell', 'note', 'schedule_prompt', ...ptyNames, ...backgroundNames, ...monitorNames] } : {}) }));
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  assert.ok(session.extensionRunner.getCommand('background-jobs'), 'shared presentation command is available without enabling model tools');
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
  if (!readOnly && !noTools && mode !== 'exclude') for (const name of backgroundNames) {
    assert.ok(active.includes(name), `explicit background activation ${name}`);
    assert.ok(callable.includes(name), `background callable ${name}`);
  }
  if (mode === 'exclude') for (const name of ['subagent', 'bash', 'powershell', 'note', 'schedule_prompt', ...ptyNames, ...backgroundNames, ...monitorNames]) { assert.ok(!active.includes(name)); assert.ok(!callable.includes(name)); }
  const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const execute = async (name, args, signal) => {
    const tool = session.agent.state.tools.find(t => t.name === name); assert.ok(tool, `active tool ${name}`);
    // Direct tool execution bypasses host argument preparation; apply the registered contract explicitly.
    const definition = definitions.find(d => d.name === name);
    const prepared = definition.prepareArguments ? await definition.prepareArguments(args) : args;
    return tool.execute(`smoke-${name}`, prepared, signal ?? AbortSignal.timeout(20000), undefined);
  };
  if (active.includes('subagent')) {
    const removed = await execute('subagent', { resume: '00000000000000000000000000', task: 'REMOVED_RESUME_MUST_NOT_RUN' });
    assert.equal(removed.isError, true, 'removed resume call must be refused before dispatch');
    assert.match(text(removed), /subagent_message/);
  }
  if (active.includes('subagent_message')) {
    const legacy = await execute('subagent_message', { jobId: 'old-job', taskId: 'old-task', mode: 'control', message: 'LEGACY_MESSAGE_MUST_NOT_RUN' });
    assert.equal(legacy.isError, true, 'old invocation-addressed message must be refused');
    assert.match(text(legacy), /subagentSessionId/);
  }
  if (active.includes('pty_spawn')) {
    await assert.rejects(execute('pty_spawn', { target: 'missing', command: 'node' }), /Unknown PTY target/);
    const spawned = await execute('pty_spawn', { command: process.execPath, args: ['-e', "process.stdout.write('PTY_OK');process.exit(7)"] });
    assert.equal(spawned.details.target, 'local'); assert.equal(spawned.details.transport, 'local');
    const { sessionId } = spawned.details;
    let output = '';
    for (let i = 0; i < 15 && !output.includes('PTY_OK'); i++) output += text(await execute('pty_read', { sessionId, timeoutMs: 1000 }));
    assert.match(output, /PTY_OK/);
    assert.equal((await execute('pty_wait_exit', { sessionId, timeoutMs: 10000 })).details.exitCode, 7);
    const listed = (await execute('pty_list', {})).details;
    assert.ok(listed.some(s => s.sessionId === sessionId && s.target === 'local'));
    await execute('pty_kill', { sessionId });
    assert.deepEqual((await execute('pty_list', {})).details, []);
  }
  if (active.includes('note')) {
    await assert.rejects(execute('note', { type: 'task', content: '  ' }), /NOTE_EMPTY/);
    const contents = ['# Plan\nalpha\n', '# Issue\nUTF-8: 中文 😀', '\n# Research\nleading blank line', '# Report\r\nexact', '# Task'];
    for (const [i, type] of ['plan', 'issue', 'research', 'report', 'task'].entries()) {
      const created = await execute('note', { type, content: contents[i] });
      assert.deepEqual(Object.keys(created.details), ['relativePath'], 'note result exposes only the single relative path');
      const file = join(cwd, created.details.relativePath);
      assert.equal(created.details.path, undefined, 'note result carries no absolute path');
      assert.match(created.details.relativePath, new RegExp(`^${type}/${type.toUpperCase()}-\\d{8}T\\d{9}Z(-[^/]+)?\\.md$`));
      assert.equal(await readFile(file, 'utf8'), contents[i]);
      assert.deepEqual(created.structuredContent, created.details);
      assert.ok(text(created).includes(created.details.relativePath)); assert.ok(!text(created).includes(cwd));
      if (type === 'plan') {
        const before = await execute('read', { path: file, offset: null, limit: null });
        await execute('edit', { path: file, expectedHash: before.details.sha256, edits: [{ oldText: 'alpha', newText: 'BETA' }] });
        assert.equal(await readFile(file, 'utf8'), '# Plan\nBETA\n');
        const second = await execute('note', { type, content: 'second plan' });
        assert.notEqual(second.details.relativePath, created.details.relativePath);
        assert.equal(await readFile(file, 'utf8'), '# Plan\nBETA\n');
      }
    }
  } else {
    for (const type of ['plan', 'issue', 'research', 'report', 'task']) await assert.rejects(stat(join(cwd, type)), { code: 'ENOENT' });
  }
  if (active.includes('schedule_prompt')) {
    // session_start created storage under the isolated workspace; a one-hour once-job never fires during the probe and shutdown stops its timer.
    const added = await execute('schedule_prompt', { action: 'add', name: 'smoke-job', type: 'once', schedule: '+1h', prompt: 'SMOKE_SCHEDULED' });
    assert.equal(added.details.action, 'add');
    const stored = JSON.parse(await readFile(join(cwd, '.pi', 'schedule-prompts.json'), 'utf8')).jobs;
    assert.deepEqual(stored.map(job => job.name), ['smoke-job']);
    assert.equal(stored[0].type, 'once'); assert.equal(stored[0].runCount, 0);
    assert.match(text(await execute('schedule_prompt', { action: 'list' })), /smoke-job/);
    await execute('schedule_prompt', { action: 'remove', jobId: stored[0].id });
    assert.deepEqual(JSON.parse(await readFile(join(cwd, '.pi', 'schedule-prompts.json'), 'utf8')).jobs, []);
  } else {
    await assert.rejects(stat(join(cwd, '.pi', 'schedule-prompts.json')), { code: 'ENOENT' });
  }
  if (!readOnly && !noTools) {
    await execute('write', { path: 'test.txt', content: 'alpha\nbeta\n', expectedHash: 'missing' });
    const before = await execute('read', { path: 'test.txt', offset: null, limit: null });
    assert.equal(before.details.sha256.length, 32); assert.match(text(before), /1│alpha/);
    assert.equal(before.structuredContent, text(before));
    assert.match(text(await execute('grep', { pattern: 'alpha', path: null, literal: true, limit: null })), /test\.txt:1: alpha/);
    assert.match(text(await execute('find', { pattern: 'test.txt', path: null, limit: null })), /test\.txt/);
    assert.match(text(await execute('ls', { path: null, limit: null })), /test\.txt/);
    const edits = await Promise.all(['BETA', 'gamma'].map(newText => execute('edit', { path: 'test.txt', expectedHash: before.details.sha256, edits: [{ oldText: 'beta', newText }] }).then(result => ({ result }), error => ({ error }))));
    assert.equal(edits.filter(r => r.result).length, 1); assert.equal(edits.filter(r => r.error).length, 1);
    assert.match(String(edits.find(r => r.error).error), /STALE_FILE/); assert.match(text(edits.find(r => r.result).result), /FILE_EDIT_SUCCESS/);
    if (active.includes('bash') || active.includes('powershell')) {
      const name = process.platform === 'win32' ? 'powershell' : 'bash';
      const result = await execute(name, { command: process.platform === 'win32' ? "Write-Output 'SHELL_OK'" : "printf 'SHELL_OK'", timeoutMs: 20000 });
      assert.match(text(result), /SHELL_OK/); assert.ok(result.structuredContent);
    }
    assert.match(text(await execute('fffind', { pattern: 'test.txt' })), /test\.txt/, 'FFF native finder works in the isolated workspace');
    assert.match(text(await execute('ffgrep', { pattern: 'alpha' })), /test\.txt/, 'FFF native grep works in the isolated workspace');
    await assert.rejects(execute('web_fetch', { url: 'http://127.0.0.1/' }), /NETWORK_BLOCKED/);
    // Real before_agent_start composition, without making a provider request.
    const options = { cwd, tools: definitions, skills: [], contextFiles: [], sections: { fixture: 'KEEP_FIXTURE' } };
    const result = await session.extensionRunner.emitBeforeAgentStart('[[fixture]] smoke', undefined, options);
    assert.equal(result.systemPromptOptions.sections.fixture, 'KEEP_FIXTURE');
    const lifecycle = result.systemPromptOptions.sections.pi_better_tools_background_lifecycle;
    const hasBackgroundTools = active.some(name => ['bash', 'powershell', 'shell_job_status', 'shell_job_cancel', 'subagent', 'subagent_status', 'subagent_cancel', 'subagent_message'].includes(name));
    assert.equal(Boolean(lifecycle), hasBackgroundTools, 'background lifecycle guidance follows active tools');
    if (hasBackgroundTools) {
      assert.match(lifecycle, /log-based provisional conclusion/);
      assert.match(lifecycle, /Cancel owned jobs that are no longer needed/);
      if (result.systemPromptOptions.forceSystemPrompt !== undefined) {
        assert.equal(result.systemPromptOptions.forceSystemPrompt.split('### Background job lifecycle').length - 1, 1, 'catalog forced prompt retains one shared lifecycle section');
      }
    }
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
    assert.ok(session.extensionRunner.getCommand('background-jobs'), 'reload invalidates the old event-bus coordinator and registers a fresh command');
  }
  assert.deepEqual(errors, [], 'extension event failures');
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  console.log(JSON.stringify({ loaded: true, hostVersion: sdk.VERSION, mode, extensions: loaded.extensions.length, tools: names, active, prompts: 3 }));
} finally {
  try { if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } }
  finally { clearInterval(heartbeat); }
}
