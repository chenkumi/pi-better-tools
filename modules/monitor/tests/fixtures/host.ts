import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as sdk from '@earendil-works/pi-coding-agent';
import monitorExtension from '../../src/index.ts';
import type { MonitorRuntime, Clock } from '../../src/core.ts';
import shellExtension from '../../../shell-tools/src/index.ts';
import { ShellJobs } from '../../../shell-tools/src/background-jobs.ts';
import { BackgroundJobs } from '../../../subagents/extensions/subagent/background.ts';
import { acquireCapability, canonicalMonitorCwd } from '../../../shell-tools/src/monitor-capability.ts';
import subagentExtension from '../../../subagents/extensions/subagent/index.ts';
import offlineProvider from './offline-provider.ts';
class ManualClock implements Clock {
  time = Date.now(); id = 0; tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.time) { this.tasks.delete(id); task.fn(); } }
}
assert.equal(sdk.VERSION, '1.1.0'); sdk.initTheme('dark', false);
const mode = process.argv[2] ?? 'shell-first', home = homedir(), cwd = await import('node:fs/promises').then(fs => fs.realpath(join(home, 'workspace')).catch(async () => { await fs.mkdir(join(home, 'workspace')); return fs.realpath(join(home, 'workspace')); }));
const agentDir = join(home, '.pi/agent'); await mkdir(agentDir, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
const childProvider = fileURLToPath(new URL('./offline-provider.ts', import.meta.url));
const monitorPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
await mkdir(join(cwd, 'config'), { recursive: true }); await writeFile(join(cwd, 'config/auth.json'), '{}');
await writeFile(join(cwd, 'config/settings.json'), JSON.stringify({ extensions: [childProvider, monitorPath], defaultTools: ['barrier'], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never' }));
let runtime!: MonitorRuntime, calls = 0, rejectPreflight = false;
const clock = new ManualClock();
const monitorFactory: sdk.ExtensionFactory = pi => monitorExtension(pi, { clock, onRuntime: r => { runtime = r; } });
const childLauncher = fileURLToPath(new URL('../../../subagents/tests/fixtures/background-child.mjs', import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
const subagentFactory: sdk.ExtensionFactory = pi => subagentExtension(pi, { debugLog: false, sessionRootDir: join(cwd, 'managed'), settingsAgentDir: join(cwd, 'config'), invocation: args => ({ command: process.execPath, args: [childLauncher, cwd, cli, ...args] }) });
const observer: sdk.ExtensionFactory = pi => { offlineProvider(pi); pi.on('before_provider_request', () => { calls++; }); pi.on('before_agent_start', event => { if (rejectPreflight) (event.systemPromptOptions as any).selectedTools = null; }); };
const factories = mode === 'monitor-first' ? [monitorFactory, shellExtension, subagentFactory, observer] : [shellExtension, subagentFactory, monitorFactory, observer];
const names = ['monitor_start', 'monitor_status', 'monitor_stop'];
const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never' });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: factories });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model: any = { provider: 'monitor-fixture', api: 'monitor-fixture-api', id: 'fixture', name: 'Offline Monitor', baseUrl: 'http://127.0.0.1:1/never', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const manager = sdk.SessionManager.create(cwd, join(home, 'sessions'));
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: manager });
const errors: string[] = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
const definitions = () => loader.getExtensions().extensions.flatMap(e => [...e.tools.values()].map(t => t.definition));
const execute = async (name: string, input: any, signal?: AbortSignal) => { const tool = session.agent.state.tools.find(t => t.name === name); assert.ok(tool, `selected ${name}`); return tool.execute('monitor-host-' + name, input, signal, undefined); };
const entryEvents: any[] = [];
session.subscribe(e => { if (e.type === 'message_end' && (e.message as any).customType === 'monitor_event') entryEvents.push(e.message); });
async function fileBarrier(path: string) {
  await new Promise<void>((done, fail) => { let settled = false; const watcher = watch(dirname(path), () => { void access(path).then(() => finish(), () => {}); }); const finish = () => { if (settled) return; settled = true; watcher.close(); done(); }; watcher.once('error', fail); void access(path).then(finish, () => {}); });
}
try {
  console.log(`[monitor-host] Testing ${mode}: default activation, explicit deactivation, real command, readonly jobs and child identity`);
  for (const name of names) { assert.equal(definitions().find(t => t.name === name)?.defaultActive, true); assert.ok(session.getActiveToolNames().includes(name)); assert.ok(session.getCallableToolNames().includes(name)); }
  session.setActiveToolsByName(session.getActiveToolNames().filter(name => !names.includes(name)));
  const definition = definitions().find(t => t.name === 'monitor_start')!;
  const inactive = await definition.execute('inactive', { source: { kind: 'command', tool: 'bash', command: 'MUST_NOT_RUN' } }, undefined, undefined, session.extensionRunner!.createToolContext('monitor-direct', undefined)); assert.equal(inactive.isError, true);
  session.setActiveToolsByName([...names, 'bash', 'shell_job_status', 'subagent', 'subagent_status']);
  await session.prompt('seed durable offline owner');
  await session.extensionRunner!.emit({ type: 'agent_start' });
  const command = await execute('monitor_start', { source: { kind: 'command', tool: 'bash', command: "printf 'one\\ntwo\\n'; printf 'diagnostic' >&2; exit 7" }, wakeAgent: false });
  assert.ok(!command.isError, JSON.stringify(command)); const id = (command.structuredContent as any).monitorId;
  await runtime.settled(id); assert.equal(runtime.status(id).cleanupEvidence.exitCode, 7); assert.equal(entryEvents.length, 0);
  await session.extensionRunner!.emit({ type: 'agent_settled', aborted: false }); clock.advance(0); await new Promise(r => setImmediate(r));
  assert.equal(entryEvents.length, 1); assert.equal(calls, 1, 'wakeAgent:false must not call model');
  assert.deepEqual(entryEvents[0].details.events.filter((e: any) => e.category === 'data').map((e: any) => e.text), ['one', 'two']);
  assert.equal(runtime.status(id).notification.hostAcknowledgment, 'unknown');
  assert.equal((await execute('monitor_status', { monitorId: 'foreign' })).isError, true);
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(wsServer, 'listening');
  wsServer.on('connection', ws => { ws.send('host-', { fin: false }); ws.send('fragment', { fin: true }); ws.close(1000, 'done'); });
  try {
    const wsMon = await execute('monitor_start', { source: { kind: 'websocket', url: `ws://127.0.0.1:${(wsServer.address() as any).port}/?token=hidden`, allowPrivateNetwork: true, allowInsecure: true }, wakeAgent: false });
    assert.ok(!wsMon.isError); const wsId = (wsMon.structuredContent as any).monitorId; await runtime.settled(wsId);
    assert.equal(runtime.status(wsId).counts.adopted, 1); assert.equal(runtime.status(wsId).cleanupEvidence.closeCode, 1000); assert.doesNotMatch(JSON.stringify(runtime.status(wsId)), /hidden|token/);
    clock.advance(30000); await new Promise(r => setImmediate(r));
    assert.ok((manager.getEntries() as any[]).some(e => e.type === 'custom_message' && e.customType === 'monitor_event' && e.details.events.some((x: any) => x.monitorId === wsId && x.text === 'host-fragment')));
  } finally { for (const ws of wsServer.clients) ws.terminate(); await new Promise<void>(r => wsServer.close(() => r())); }
  // Real failed host preflight emits no agent_start/settled. Monitor must remain flushable.
  rejectPreflight = true; await assert.rejects(session.prompt('offline rejected preflight'), TypeError); rejectPreflight = false;
  const afterPreflight = await execute('monitor_start', { source: { kind: 'command', tool: 'bash', command: "printf 'AFTER_PREFLIGHT_BARRIER\\n'" }, wakeAgent: false });
  await runtime.settled((afterPreflight.structuredContent as any).monitorId); clock.advance(30000); await new Promise(r => setImmediate(r));
  assert.ok(entryEvents.some(e => e.details.events.some((x: any) => x.text === 'AFTER_PREFLIGHT_BARRIER'))); assert.equal(calls, 1);
  const shell = await execute('bash', { command: 'printf shell-job', background: true }); assert.ok(!shell.isError); const shellId = (shell.structuredContent as any).jobId;
  const shellMon = await execute('monitor_start', { source: { kind: 'shell_job', jobId: shellId }, wakeAgent: false }); assert.ok(!shellMon.isError, JSON.stringify(shellMon));
  const shellMonId = (shellMon.structuredContent as any).monitorId;
  await execute('monitor_stop', { monitorId: shellMonId }); await runtime.settled(shellMonId);
  // Native completion event is the job barrier; no sleeps/polling and Monitor must not cancel it.
  const shellDone = new Promise<void>(resolve => { if ((manager.getEntries() as any[]).some(e => e.type === 'custom_message' && e.customType === 'shell-job-completed' && e.details.jobs.some((j: any) => j.jobId === shellId))) resolve(); else { const off = session.subscribe(e => { if (e.type === 'message_end' && (e.message as any).customType === 'shell-job-completed' && (e.message as any).details.jobs.some((j: any) => j.jobId === shellId)) { off(); resolve(); } }); } });
  await shellDone; await session.waitForIdle(); const shellStatus = await execute('shell_job_status', { jobId: shellId }); assert.equal((shellStatus.structuredContent as any).cancelRequested, false); assert.equal((shellStatus.structuredContent as any).status, 'completed');
  const child = await execute('subagent', { agent: 'worker', task: 'hold-child', background: true }); assert.ok(!child.isError, JSON.stringify(child)); const jobId = (child.structuredContent as any).jobId;
  await fileBarrier(join(cwd, 'child-ready'));
  const childMon = await execute('monitor_start', { source: { kind: 'subagent_job', jobId }, wakeAgent: false }); assert.ok(!childMon.isError, JSON.stringify(childMon));
  const childMonId = (childMon.structuredContent as any).monitorId;
  await execute('monitor_stop', { monitorId: childMonId }); await runtime.settled(childMonId);
  assert.equal((await execute('subagent_status', { jobId })).structuredContent && ((await execute('subagent_status', { jobId })).structuredContent as any).cancelRequested, false);
  const childTools = JSON.parse(await readFile(join(cwd, 'monitor-child-tools.json'), 'utf8')); assert.ok(!childTools.some((n: string) => n.startsWith('monitor_')));
  const childDone = new Promise<void>(resolve => { const off = session.subscribe(e => { if (e.type === 'message_end' && (e.message as any).customType === 'subagent_background' && (e.message as any).details?.kind === 'task_result' && (e.message as any).details.jobId === jobId) { off(); resolve(); } }); });
  await writeFile(join(cwd, 'release-child'), 'release'); await childDone; await session.waitForIdle();
  const childStatus = (await execute('subagent_status', { jobId })).structuredContent as any; assert.equal(childStatus.status, 'completed'); assert.equal(childStatus.cancelRequested, false);
  const terminal = await execute('monitor_start', { source: { kind: 'subagent_job', jobId }, wakeAgent: false }); const terminalId = (terminal.structuredContent as any).monitorId; await runtime.settled(terminalId); assert.equal(runtime.status(terminalId).state, 'completed');
  // Explicit marker, not RPC/cwd inference; direct saved-definition execution must reject too.
  (globalThis as any).__piSubagentsGuardExpected = { id: 'explicit-child', cwd, startupPath: join(cwd, 'unused'), shellMode: 'foreground-v1' };
  const registered: string[] = []; monitorExtension({ registerTool: (t: any) => registered.push(t.name) } as any); assert.deepEqual(registered, []);
  const forged = await definition.execute('forged', { source: { kind: 'command', tool: 'bash', command: 'MUST_NOT_RUN' } }, undefined, undefined, session.extensionRunner!.createToolContext('monitor-direct', undefined)); assert.equal(forged.isError, true); delete (globalThis as any).__piSubagentsGuardExpected;
  // Hold the actual factory's shutdown awaits BEFORE registry epoch changes. This
  // proves the publisher revokes first, not merely that get() later rejects a job.
  const scope = { sessionId: manager.getSessionId(), cwd: canonicalMonitorCwd(cwd) };
  const shellLease = acquireCapability('shell_job', scope), childLease = acquireCapability('subagent_job', scope);
  assert.equal(shellLease.snapshot(shellId).jobId, shellId); assert.equal(childLease.snapshot(jobId).jobId, jobId);
  const shellShutdown = ShellJobs.prototype.shutdown, childShutdown = BackgroundJobs.prototype.shutdown;
  let enterShell!: () => void, enterChild!: () => void, releaseShell!: () => void, releaseChild!: () => void;
  const shellEntered = new Promise<void>(r => { enterShell = r; }), childEntered = new Promise<void>(r => { enterChild = r; });
  const shellGate = new Promise<void>(r => { releaseShell = r; }), childGate = new Promise<void>(r => { releaseChild = r; });
  ShellJobs.prototype.shutdown = async function (...args) { enterShell(); await shellGate; return shellShutdown.apply(this, args); };
  BackgroundJobs.prototype.shutdown = async function (...args) { enterChild(); await childGate; return childShutdown.apply(this, args); };
  const oldId = id; const reloading = session.reload();
  try {
    await shellEntered; assert.throws(() => shellLease.snapshot(shellId)); releaseShell();
    await childEntered; assert.throws(() => childLease.snapshot(jobId)); releaseChild(); await reloading;
  } finally { releaseShell(); releaseChild(); ShellJobs.prototype.shutdown = shellShutdown; BackgroundJobs.prototype.shutdown = childShutdown; await reloading; }
  assert.deepEqual((await execute('monitor_status', {})).structuredContent, { monitors: [] }); assert.equal((await execute('monitor_status', { monitorId: oldId })).isError, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, mode, sources: ['command', 'websocket', 'shell_job', 'subagent_job'], providerCalls: 0, fixtureModelCalls: calls, childClosed: true, noAck: true }));
} finally { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
