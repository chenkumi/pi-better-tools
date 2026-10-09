import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';

const root = resolve(process.argv[2]);
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
const heartbeat = setInterval(() => console.error('[schedule-deadline] Host probe still running'), 10000);
let session;
const errors = [];
try {
  assert.equal(sdk.VERSION, '1.1.0');
  assert.equal(resolve(process.env.PI_CODING_AGENT_DIR), resolve(agentDir));
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), '{}');
  const path = join(cwd, '.pi/schedule-prompts.json');
  const past = new Date(Date.now() - 3600000).toISOString();
  const future = new Date(Date.now() + 7200000).toISOString();
  await writeFile(path, JSON.stringify({ version: 1, jobs: [{ id: 'past', name: 'past', enabled: true,
    type: 'interval', schedule: '1h', intervalMs: 3600000, prompt: 'MUST_NOT_RUN', runCount: 0, createdAt: past, endAt: past }] }));
  sdk.initTheme('dark', false);
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['schedule_prompt'], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    additionalExtensionPaths: [join(root, 'modules/schedule-prompt/src/index.ts')],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model,
    sessionManager: sdk.SessionManager.inMemory(cwd), tools: ['schedule_prompt'] }));
  await session.bindExtensions({ mode: 'json', onError: (e) => errors.push(e.error) });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).jobs[0].enabled, false, 'startup expires a persisted deadline without any waiting or provider call');
  const definition = [...resourceLoader.getExtensions().extensions[0].tools.values()].find((t) => t.definition.name === 'schedule_prompt').definition;
  assert.ok(definition.parameters.properties.endAt.anyOf.some((s) => s.type === 'null'));
  const tool = session.agent.state.tools.find((t) => t.name === 'schedule_prompt');
  const execute = async (args) => {
    const prepared = validateToolArguments(tool, { type: 'toolCall', id: 'deadline-probe', name: tool.name, arguments: args });
    return tool.execute('deadline-probe', prepared, AbortSignal.timeout(10000), undefined);
  };
  console.error('[schedule-deadline] Testing live registered tool and nullable schema');
  const added = await execute({ action: 'add', name: 'future', type: 'interval', schedule: '1h', prompt: 'MUST_NOT_RUN', endAt: future });
  assert.equal(added.details.error, undefined);
  const id = added.details.jobId;
  assert.equal(added.details.jobs[0].endAt, future);
  const rejected = await execute({ action: 'enable', jobId: 'past' });
  assert.match(rejected.details.error, /expired/);
  await execute({ action: 'disable', jobId: id });
  const cleared = await execute({ action: 'update', jobId: id, endAt: null });
  assert.equal(cleared.details.error, undefined);
  assert.equal(cleared.details.jobs[0].enabled, false);
  assert.equal(cleared.details.jobs[0].endAt, undefined);
  assert.ok(!Object.hasOwn(JSON.parse(await readFile(path, 'utf8')).jobs.find((j) => j.id === id), 'endAt'));
  await execute({ action: 'update', jobId: id, endAt: future });
  await execute({ action: 'enable', jobId: id });
  const beforeReload = JSON.parse(await readFile(path, 'utf8'));
  beforeReload.jobs.find((j) => j.id === id).endAt = past;
  await writeFile(path, JSON.stringify(beforeReload));
  await session.extensionRunner.emit({ type: 'session_start' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).jobs.find((j) => j.id === id).enabled, false);
  assert.deepEqual(errors, []);
  assert.equal(session.messages.length, 0, 'no scheduled prompts were delivered or model work started');
  await execute({ action: 'remove', jobId: id });
  await execute({ action: 'remove', jobId: 'past' });
  console.log(JSON.stringify({ passed: true, hostVersion: sdk.VERSION, checks: ['startup', 'schema-null', 'add', 'update', 'enable', 'session-reinitialize', 'no-provider'] }));
} finally {
  try {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
  } finally { clearInterval(heartbeat); }
}
