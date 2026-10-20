import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]), mode = process.argv[3] ?? 'files';
const host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const ai = await import(host ? pathToFileURL(join(host, '../pi-ai/dist/index.js')).href : '@earendil-works/pi-ai');
const require = createRequire(host ? join(host, 'package.json') : import.meta.url);
const { Type } = await import(pathToFileURL(require.resolve('typebox')).href);
assert.equal(sdk.VERSION, '1.3.0'); sdk.initTheme('dark', false);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden'); };
const heartbeat = setInterval(() => console.error('[file-audit] Offline host or cleanup still running...'), 10000);
const home = homedir(), cwd = join(home, 'workspace'), agentDir = join(home, '.pi/agent');
await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(cwd, 'existing.txt'), 'initial'); await writeFile(join(cwd, 'fault.txt'), 'fault');
const model = { id: 'offline-audit', name: 'Offline audit', provider: 'offline-audit', api: 'openai-responses', baseUrl: 'https://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let script = [], streamCalls = 0;
const observer = pi => {
  pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-non-secret', models: [model],
    streamSimple(m) {
      streamCalls++; const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = script.shift() ?? [{ type: 'text', text: 'DONE' }];
        const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content,
          stopReason: content.some(x => x.type === 'toolCall') ? 'toolUse' : 'stop',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      });
      return stream;
    } });
  pi.registerTool({ name: 'audit_nested', label: 'Nested test', description: 'Offline nested fixture', parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const note = await ctx.executeTool('note', { type: 'task', content: '# Nested note' });
      const path = note.structuredContent?.relativePath ?? note.details?.relativePath;
      await ctx.executeTool('read', { path });
      return { content: [{ type: 'text', text: 'Nested completed' }], details: { relativePath: path } };
    } });
  pi.on('tool_result', event => {
    if (event.toolName === 'read' && event.input.path === 'fault.txt') return { isError: true };
  });
};
const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
const entry = join(root, 'modules/file-audit/src/index.ts');
const additionalExtensionPaths = mode === 'excluded' ? [] : [entry];
if (mode === 'files') additionalExtensionPaths.push(join(root, 'modules/file-tools/src/index.ts'));
if (mode === 'files' || mode === 'native') additionalExtensionPaths.push(join(root, 'modules/note-tools/src/index.ts'));
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths, extensionFactories: [observer],
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
let session;
const errors = [], cases = [];
try {
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model,
    sessionManager: sdk.SessionManager.create(cwd, join(home, 'sessions')), tools: ['read', 'write', 'edit', 'note', 'audit_nested'] }));
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  const notices = [];
  const command = async args => {
    const registered = session.extensionRunner.getCommand('file-audit'); assert.ok(registered);
    const ctx = session.extensionRunner.createCommandContext();
    // Exercise actual command handler with its SDK context; notification display itself is stubbed, not a human TUI test.
    await registered.handler(args, { ...ctx, mode: 'tui', ui: { ...ctx.ui, notify: text => notices.push(text) } });
    return notices.at(-1);
  };
  let sequence = 0;
  const run = async calls => {
    script = calls.length ? [calls.map(([name, args]) => ({ type: 'toolCall', id: `audit-${++sequence}`, name, arguments: args })), [{ type: 'text', text: 'DONE' }]] : [];
    await session.prompt('Run offline file audit fixture');
    const final = session.messages.filter(x => x.role === 'assistant').at(-1);
    assert.equal(final?.stopReason, 'stop', final?.errorMessage);
  };
  if (mode === 'excluded') {
    assert.equal(session.extensionRunner.getCommand('file-audit'), undefined);
    await run([['read', { path: 'existing.txt' }]]); cases.push('excluded');
  } else if (mode === 'standalone') {
    assert.match(await command('status'), /Candidates: 0/);
    await run([['read', { path: 'existing.txt' }]]);
    assert.match(await command('status'), /Candidates: 1/);
    assert.match(await command('check'), /unavailable/); cases.push('standalone-no-metadata');
  } else {
    await command('limits --window 30');
    await run([['read', { path: 'existing.txt' }], ['read', { path: 'missing.txt' }], ['read', { path: 'fault.txt' }],
      ['write', { path: 'written.txt', content: 'written' }], ['note', { type: 'task', content: ' ' }]]);
    assert.match(await command('status'), /Candidates: 2/); cases.push('success-and-final-errors');
    await run([['note', { type: 'plan', content: '# Actual note' }]]);
    const note = session.messages.findLast(x => x.role === 'toolResult' && x.toolName === 'note');
    assert.equal(note.isError, false);
    const path = note.structuredContent?.relativePath ?? note.details?.relativePath;
    assert.ok(path?.startsWith('plans/PLAN-')); assert.equal(await readFile(join(cwd, path), 'utf8'), '# Actual note');
    const replacement = { oldText: '# Actual note', newText: '# Updated note' };
    await run([['read', { path }], ['edit', mode === 'files' ? { path, edits: [replacement] } : { path, ...replacement }]]);
    assert.equal(await readFile(join(cwd, path), 'utf8'), '# Updated note');
    assert.match(await command('status'), /Candidates: 3/); cases.push('note-read-edit-dedup');
    await run([['audit_nested', {}]]);
    assert.match(await command('status'), /Candidates: 4/); cases.push('nested-note-and-read');
    await mkdir(join(cwd, 'docs'), { recursive: true });
    const hash = text => createHash('sha256').update(text).digest('hex');
    await writeFile(join(cwd, 'docs/sources.json'), JSON.stringify({ modules: [] }));
    await writeFile(join(cwd, 'docs/native-modules.json'), JSON.stringify({ modules: [] }));
    await writeFile(join(cwd, 'docs/adaptations.json'), JSON.stringify({ files: [], addedFiles: [],
      localSourceSuiteFinalIntegration: { rootFiles: [{ path: 'existing.txt', sha256: hash('initial') }, { path: 'written.txt', sha256: hash('written') }] } }));
    const checked = await command('check');
    assert.match(checked, /matched=2/); assert.match(checked, /untracked=2/); cases.push('manual-check');
    await command('limits --window 1'); await run([]); assert.match(await command('status'), /Candidates: 0/); cases.push('window');
    await run([['read', { path: 'existing.txt' }]]); assert.match(await command('status'), /Candidates: 1/);
    const savedFile = session.sessionFile;
    await session.reload(); assert.match(await command('status'), /Candidates: 0/); cases.push('reload');
    await run([['read', { path: 'existing.txt' }]]);
    const target = session.sessionManager.getBranch().find(x => x.type === 'message' && x.message.role === 'user');
    assert.ok(target); await session.navigateTree(target.id, { summarize: false });
    assert.match(await command('status'), /Candidates: 0/); cases.push('tree');
    for (const reason of ['new', 'resume']) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'switch' }); session.dispose();
      await loader.reload();
      const manager = reason === 'new' ? sdk.SessionManager.create(cwd, join(home, 'sessions')) : sdk.SessionManager.open(savedFile);
      ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model,
        sessionManager: manager, sessionStartEvent: { type: 'session_start', reason, previousSessionFile: savedFile },
        tools: ['read', 'write', 'edit', 'note', 'audit_nested'] }));
      await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
      assert.match(await command('status'), /Candidates: 0/);
    }
    cases.push('new-and-resume');
  }
  assert.deepEqual(errors, []);
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, mode, cases, providerCalls: networkCalls, networkCalls, streamCalls }));
} finally {
  try { session?.dispose(); } finally { clearInterval(heartbeat); }
}
