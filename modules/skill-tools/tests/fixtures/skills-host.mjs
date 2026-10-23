import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const { createAssistantMessageEventStream } = await import(host ? pathToFileURL(join(host, '../pi-ai/dist/compat.js')).href : '@earendil-works/pi-ai/compat');
assert.equal(sdk.VERSION, '1.4.0');
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(agentDir, 'workspace');
const relocated = join(agentDir, 'relocated-package');
await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await cp(join(root, 'modules/skill-tools/src'), join(relocated, 'src'), { recursive: true });
await cp(join(root, 'modules/skill-tools/skills'), join(relocated, 'skills'), { recursive: true });
await writeFile(join(relocated, 'package.json'), JSON.stringify({ name: 'isolated-skill-package', pi: { extensions: ['./src/index.ts'] } }));
const skillPath = join(relocated, 'skills/create-plan/SKILL.md');
const configSkillPath = join(relocated, 'skills/pi-tools-config/SKILL.md');
const configReference = join(relocated, 'skills/pi-tools-config/references/sql-connector.md');
assert.equal(await readFile(configReference, 'utf8'), await readFile(join(root, 'modules/skill-tools/skills/pi-tools-config/references/sql-connector.md'), 'utf8'));
for (const [name, command] of [['web-tools', 'pi-better-tools browser install'], ['pty-terminal', 'pi-better-tools pty setup']]) {
  const text = await readFile(join(relocated, `skills/pi-tools-config/references/${name}.md`), 'utf8');
  assert.equal(text, await readFile(join(root, `modules/skill-tools/skills/pi-tools-config/references/${name}.md`), 'utf8'));
  assert.ok(text.includes(command));
}
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
      if (!enabled) assert.equal(skills.length, 0);
      assert.equal(session.systemPrompt.includes('Create or revise a software development plan'), enabled && !noTools);
      assert.ok(!session.systemPrompt.includes('Plan Title:'), 'full skill body is not eagerly injected');
      assert.equal(session.systemPrompt.includes('Use when users need to create, change, or troubleshoot configuration'), enabled && !noTools);
      assert.ok(!session.systemPrompt.includes('# Pi Tools 設定索引'), 'configuration index body is loaded lazily');
      assert.ok(!session.systemPrompt.includes('MSSQL SQL Authentication 使用 username/password'), 'reference bodies are not eagerly injected');
      assert.deepEqual(session.getActiveToolNames(), noTools ? [] : ['read'], 'resource provider does not activate tools');
      if (enabled) {
        assert.ok(skills.some(skill => skill.name === 'create-plan'), 'bundled create-plan skill is provided');
        assert.equal(resolve(skills.find(skill => skill.name === 'create-plan').filePath), skillPath);
        const configSkill = skills.find(skill => skill.name === 'pi-tools-config');
        assert.equal(resolve(configSkill.filePath), configSkillPath);
        assert.ok(configSkill.description.includes('required connection configuration is missing or unknown.'));
        assert.ok(configSkill.description.includes('Chromium installation'));
        assert.ok(configSkill.description.includes('PTY native'));
        assert.ok(configSkill.description.includes('setup CLI diagnostics'));
        assert.ok(configSkill.description.endsWith('Do not use for routine operations with already-configured tools or for implementing these features in application code.'));
        if (!noTools) assert.ok(session.systemPrompt.includes(configSkill.description), 'complete folded description reaches the skill catalogue without truncation');
      }
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
    await session.prompt('/skill:pi-tools-config Explain SQL Connector configuration');
    if (enabled) {
      assert.match(expanded, /^<skill name="pi-tools-config" location=/);
      assert.ok(expanded.includes(configSkillPath));
      assert.ok(expanded.includes('references/sql-connector.md'));
      assert.ok(expanded.endsWith('Explain SQL Connector configuration'));
      assert.ok(!expanded.includes('MSSQL SQL Authentication 使用 username/password'), 'command expands index, not all references');
    } else assert.equal(expanded, '/skill:pi-tools-config Explain SQL Connector configuration');
    session.dispose(); session = undefined;
  }
  assert.deepEqual(errors, []);
  assert.equal(streamCalls, 6);
  assert.equal(externalCalls, 0);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, providerCalls: externalCalls,
    cases: ['startup', 'reload', 'relocated', 'lazy-body', 'skill-command', 'extension-filter', 'no-tools'] }));
} finally { session?.dispose(); clearInterval(heartbeat); }
