import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.argv[2]);
const mode = process.argv[3] ?? 'search';
const host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const home = process.cwd(), cwd = join(home, 'workspace'), agentDir = join(home, 'agent');
await mkdir(join(cwd, '.pi', 'agent'), { recursive: true });
await mkdir(agentDir, { recursive: true });
const configPath = join(cwd, '.pi', 'agent', 'sql-connector.json');
const config = {
  mysql: { host: 'unused.invalid', username: 'fixture', password: 'synthetic-only', database: 'fixture' },
  mssql: { host: 'unused.invalid', database: 'fixture', windowsAuth: true },
  pgsql: { host: 'unused.invalid', username: 'fixture', password: 'synthetic-only', database: 'fixture' },
};
if (mode !== 'absent') await writeFile(configPath, mode === 'invalid' ? '{broken JSON' : JSON.stringify(config));
const engineNames = ['mysql', 'mssql', 'pgsql'];
const toolNames = engineNames.flatMap(engine => ['state', 'query', 'update'].map(action => `${engine}_${action}`));
const settingsManager = sdk.SettingsManager.inMemory({ packages: [] }, { projectTrusted: mode !== 'untrusted' });
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  additionalExtensionPaths: [join(packageRoot, 'modules/sql-connector/src/index.ts'), join(packageRoot, 'modules/pi-runtime/src/index.ts')],
  extensionFactories: mode === 'fallback' ? [] : [sdk.createToolSearchExtension()],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
let session;
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network request in offline SQL Connector probe'); };
const heartbeat = setInterval(() => console.error(`[sql-connector] Offline ${mode} probe still running...`), 10000);
try {
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  const errors = [];
  ({ session } = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: modelRuntime.getModels()[0],
    sessionManager: sdk.SessionManager.inMemory(cwd),
    ...(mode === 'read-only' ? { tools: ['read'] } : {}),
    ...(mode === 'no-tools' ? { noTools: 'all' } : {}),
    ...(mode === 'exclude' ? { excludeTools: ['mysql_*', 'mssql_*', 'pgsql_*'] } : {}),
  }));
  await session.bindExtensions({ mode: 'json', onError: error => errors.push(error) });
  const loadedTools = () => session.getAllTools().filter(tool => toolNames.includes(tool.name));
  const hint = async () => {
    const result = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Inspect a database' }, { cwd, selectedTools: session.getActiveToolNames(), sections: { fixture: 'KEEP' } });
    assert.equal(result.systemPromptOptions.sections.fixture, 'KEEP');
    assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined, 'SQL Connector does not replace the system prompt');
    return result.systemPromptOptions.sections.pi_better_tools_deferred_tools;
  };
  const execute = async (name, args = {}) => {
    const tool = session.agent.state.tools.find(tool => tool.name === name);
    assert.ok(tool, `Missing active tool ${name}`);
    return tool.execute(`sql-probe-${name}`, args, undefined);
  };
  if (!['search', 'fallback'].includes(mode)) {
    assert.deepEqual(loadedTools(), []);
    assert.equal(await hint(), undefined);
    assert.ok(!session.getActiveToolNames().some(name => toolNames.includes(name)));
    const search = session.agent.state.tools.find(tool => tool.name === 'tool_search');
    if (search) assert.match(JSON.stringify((await execute('tool_search', { query: 'mysql' })).content), /No matching tools/);
  } else {
    assert.deepEqual(loadedTools().map(tool => tool.name).sort(), [...toolNames].sort());
    for (const tool of loadedTools()) {
      assert.equal(tool.exposure, 'deferred');
      assert.equal(tool.namespace.name, tool.name.split('_')[0]);
      assert.equal(session.getActiveToolNames().includes(tool.name), mode === 'fallback');
    }
    if (mode === 'search') {
      const before = await hint();
      for (const engine of engineNames) assert.ok(before.includes(`query "${engine}"`));
      assert.doesNotMatch(before, /unused\.invalid|synthetic-only|fixture/);
      for (const engine of engineNames) {
        await execute('tool_search', { query: engine, limit: 3 });
        for (const name of toolNames.filter(name => name.startsWith(engine + '_'))) assert.ok(session.getActiveToolNames().includes(name), name);
      }
      assert.equal(await hint(), undefined);
    }
    for (const engine of engineNames) {
      await assert.rejects(execute(`${engine}_query`, { sql: 'DELETE FROM forbidden' }), /read-only/);
      await assert.rejects(execute(`${engine}_update`, { sql: 'DELETE FROM records WHERE id = 1', reason: 'offline refusal probe' }), /interactive confirmation/);
      const guideline = session.getToolDefinition(`${engine}_state`).promptGuidelines.join('\n');
      assert.ok(guideline.includes(`${engine}_query`));
      assert.match(guideline, /Every update requires user confirmation/);
      assert.match(session.getToolDefinition(`${engine}_query`).description, /200/);
    }
    const old = session.getToolDefinition('mysql_query');
    const oldContext = session.extensionRunner.createToolContext('old-runtime', undefined);
    await writeFile(configPath, JSON.stringify({ pgsql: config.pgsql }));
    await session.reload();
    assert.deepEqual(loadedTools().map(tool => tool.name).sort(), ['pgsql_query', 'pgsql_state', 'pgsql_update']);
    await assert.rejects(old.execute('old-runtime', { sql: 'SELECT 1 LIMIT 1' }, undefined, undefined, oldContext), /shutting down/);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { pgsql: config.pgsql });
  }
  assert.ok(session.extensionRunner.getCommand('sql-connector-reload'));
  assert.deepEqual(errors, []);
  assert.equal(networkCalls, 0);
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, mode, providerCalls: 0, networkCalls, databaseConnections: 0 }));
} finally {
  try { if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } }
  finally { clearInterval(heartbeat); globalThis.fetch = originalFetch; }
}
