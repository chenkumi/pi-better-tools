import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const { createAssistantMessageEventStream } = await import(host ? pathToFileURL(join(host, '../pi-ai/dist/compat.js')).href : '@earendil-works/pi-ai/compat');
assert.equal(sdk.VERSION, '1.1.0');
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(agentDir, 'workspace');
const relocated = join(agentDir, 'relocated-package');
await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await cp(join(root, 'modules/skill-tools/src'), join(relocated, 'src'), { recursive: true });
await cp(join(root, 'modules/skill-tools/skills'), join(relocated, 'skills'), { recursive: true });
await writeFile(join(relocated, 'package.json'), JSON.stringify({ name: 'isolated-skill-package', pi: { extensions: ['./src/index.ts'] } }));
const skillPath = join(relocated, 'skills/create-plan/SKILL.md');
assert.equal(await readFile(skillPath, 'utf8'), await readFile(join(root, 'modules/skill-tools/skills/create-plan/SKILL.md'), 'utf8'));
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('Network forbidden in skill fixture'); };
sdk.initTheme('dark', false);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { ...modelRuntime.getModels()[0], id: 'skill-test', provider: 'offline-skills', api: 'openai-responses' };
const heartbeat = setInterval(() => console.error('[skills] Offline host verification still running...'), 10000);
let session;
const errors = [];
let expanded, streamCalls = 0;
try {
  for (const [enabled, noTools] of [[true, false], [true, true], [false, false]]) {
    const settings = sdk.SettingsManager.inMemory({
      packages: [{ source: relocated, extensions: enabled ? ['src/index.ts'] : [], skills: [] }],
      defaultTools: ['read'], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false,
    });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.on('before_agent_start', event => { expanded = event.prompt; });
        pi.registerProvider(model.provider, { api: model.api, apiKey: 'offline-non-secret', baseUrl: 'https://unused.invalid', models: [model], streamSimple: m => {
          streamCalls++;
          const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
            content: [{ type: 'text', text: 'SKILL_EXPANDED' }], stopReason: 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
          return stream;
        } });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.some(e => resolve(e.path) === join(relocated, 'src/index.ts')), enabled, 'package extension filter selects the expected entry');
    assert.deepEqual(loader.getSkills().skills, [], 'skill is provided only after extension resource discovery');
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager: settings,
      resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd),
      ...(noTools ? { noTools: 'all' } : { tools: ['read'] }) }));
    await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
    const check = () => {
      const { skills, diagnostics } = loader.getSkills();
      assert.deepEqual(diagnostics, []);
      assert.equal(skills.length, enabled ? 1 : 0);
      assert.equal(session.systemPrompt.includes('Create or revise a software development plan'), enabled && !noTools);
      assert.ok(!session.systemPrompt.includes('Plan Title:'), 'full skill body is not eagerly injected');
      assert.deepEqual(session.getActiveToolNames(), noTools ? [] : ['read'], 'resource provider does not activate tools');
      if (enabled) { assert.equal(skills[0].name, 'create-plan'); assert.equal(resolve(skills[0].filePath), skillPath); }
    };
    check();
    await session.reload();
    check();
    await session.prompt('/skill:create-plan Offline acceptance request');
    if (enabled) {
      assert.match(expanded, /^<skill name="create-plan" location=/);
      assert.ok(expanded.includes(skillPath));
      assert.ok(expanded.includes('Plan Title:'));
      assert.ok(expanded.endsWith('Offline acceptance request'));
    } else assert.equal(expanded, '/skill:create-plan Offline acceptance request');
    session.dispose(); session = undefined;
  }
  assert.deepEqual(errors, []);
  assert.equal(streamCalls, 3);
  assert.equal(externalCalls, 0);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, providerCalls: externalCalls,
    cases: ['startup', 'reload', 'relocated', 'lazy-body', 'skill-command', 'extension-filter', 'no-tools'] }));
} finally { session?.dispose(); clearInterval(heartbeat); }
