import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
const packageRoot = resolve(process.argv[2]), host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const { WebSocketServer } = await import(pathToFileURL(join(packageRoot, 'node_modules/ws/wrapper.mjs')).href);
assert.equal(sdk.VERSION, '1.1.0'); sdk.initTheme('dark', false);
globalThis.fetch = async () => { throw new Error('Production Monitor provider/network calls forbidden'); };
const home = homedir(), agentDir = join(home, '.pi/agent'), workspace = join(home, 'workspace');
await mkdir(workspace, { recursive: true }); const cwd = await realpath(workspace); await mkdir(agentDir, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
const names = ['monitor_start', 'monitor_status', 'monitor_stop'];
const settings = sdk.SettingsManager.inMemory({ defaultTools: names, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never' });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  additionalExtensionPaths: ['shell-tools', 'subagents', 'monitor'].map(name => join(packageRoot, `modules/${name}/src/index.ts`)) });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []); assert.equal(loader.getExtensions().extensions.length, 3);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const manager = sdk.SessionManager.create(cwd, join(home, 'sessions'));
const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, sessionManager: manager, resourceLoader: loader, modelRuntime, model, tools: names });
const errors = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
const observations = [], waiters = new Map();
session.subscribe(e => { if (e.type !== 'message_end' || e.message.customType !== 'monitor_event') return; observations.push(e.message); for (const row of e.message.details.monitors) if (row.cleanupEvidence.sourceClosed === true && !row.cleanupPending && row.state === 'completed') { waiters.get(row.monitorId)?.(); waiters.delete(row.monitorId); } });
const execute = async (name, args) => { const tool = session.agent.state.tools.find(t => t.name === name); assert.ok(tool); return tool.execute(`production-${name}`, args, undefined, undefined); };
const terminal = id => observations.some(e => e.details.monitors.some(m => m.monitorId === id && m.state === 'completed' && !m.cleanupPending)) ? Promise.resolve() : new Promise(r => waiters.set(id, r));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
server.on('connection', ws => { ws.send('production-', { fin: false }); ws.send('ws', { fin: true }); ws.close(1000, 'done'); });
const heartbeat = setInterval(() => console.log('[monitor-production] Waiting for native notification/close barriers...'), 10000);
try {
  for (const kind of ['shell_job', 'subagent_job']) { const rejected = await execute('monitor_start', { source: { kind, jobId: 'missing-production-job' }, wakeAgent: false }); assert.equal(rejected.isError, true); assert.doesNotMatch(JSON.stringify(rejected), /provider.*unavailable|capability.*unavailable/i); }
  const command = await execute('monitor_start', { source: { kind: 'command', tool: 'bash', command: "printf 'production-command\\n'" }, wakeAgent: false });
  const websocket = await execute('monitor_start', { source: { kind: 'websocket', url: `ws://127.0.0.1:${server.address().port}/?token=MONITOR_PRODUCTION_SECRET_A9F7`, allowPrivateNetwork: true, allowInsecure: true }, wakeAgent: false });
  assert.ok(!command.isError && !websocket.isError, JSON.stringify({ command, websocket }));
  const ids = [command.structuredContent.monitorId, websocket.structuredContent.monitorId]; await Promise.all(ids.map(terminal));
  for (const id of ids) { const status = (await execute('monitor_status', { monitorId: id })).structuredContent; assert.equal(status.state, 'completed'); assert.equal(status.cleanupPending, false); assert.equal(status.notification.hostAcknowledgment, 'unknown'); assert.doesNotMatch(JSON.stringify(status), /MONITOR_PRODUCTION_SECRET_A9F7|token/); if (status.source === 'websocket') assert.doesNotMatch(status.sourcePreview, /[?#]/); }
  const texts = observations.flatMap(e => e.details.events).filter(e => e.category === 'data').map(e => e.text);
  assert.ok(texts.includes('production-command')); assert.ok(texts.includes('production-ws'));
  assert.ok(manager.getEntries().some(e => e.type === 'custom_message' && e.customType === 'monitor_event')); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, sources: ['command', 'websocket'], readonlyProvidersLoaded: ['shell_job', 'subagent_job'], providerCalls: 0, noAck: true, sourceCloseObserved: true }));
} finally { clearInterval(heartbeat); for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(() => r())); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
