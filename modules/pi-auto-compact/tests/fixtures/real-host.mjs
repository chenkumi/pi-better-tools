// Real Pi host check for Pi Auto Compact: a real AgentSession, the real compaction pipeline and an offline provider.
// Scenarios: full | invalid-config | unknown-window. The last stdout line is the JSON result.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { canonicalMonitorCwd, publishActiveMonitorBriefs, publishCapability } from '../../../shell-tools/src/monitor-capability.ts';

assert.equal(sdk.VERSION, '1.5.0'); sdk.initTheme('dark', false);
const scenario = process.argv[2] ?? 'full';
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
const workspace = await realpath(cwd);
// L1 is small too: the unused part of L1 is lent to L2, and a default-size L1 would lend more than this whole history.
const SMALL = { l1Ratio: 0.0001, l1MinChars: 3000, l2Ratio: 0.0001, l2MinChars: 1500, l3Ratio: 0.0001, l3MinChars: 1200, l4Ratio: 0.0001, l4MinChars: 1500, maxTotalRatio: 1 };
await writeFile(join(agentDir, 'auto-compact.json'), scenario === 'invalid-config' ? '{ "enabled": true }' : JSON.stringify(SMALL));

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } };
const contextWindow = scenario === 'unknown-window' ? 0 : 32768;
let providerCalls = 0;
const offline = pi => {
  globalThis.fetch = async () => { throw new Error('External service calls are forbidden in the Pi Auto Compact host fixture'); };
  pi.registerProvider('ac-offline', { api: 'ac-offline-api', baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-not-secret',
    models: [{ id: 'fixture', name: 'Offline', reasoning: false, input: ['text'], cost: zero, contextWindow, maxTokens: 2048 }],
    streamSimple(model) {
      providerCalls++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text: 'PI_NATIVE_SUMMARY' }], usage, stopReason: 'stop' };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      });
      return stream;
    } });
};

const sm = sdk.SessionManager.create(workspace, join(home, 'sessions'));
const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(5).trim();
const text = value => [{ type: 'text', text: value }];
const user = value => sm.appendMessage({ role: 'user', content: value, timestamp: Date.now() });
const assistant = (value, calls = []) => sm.appendMessage({ role: 'assistant', content: [...(value ? text(value) : []), ...calls.map(c => ({ type: 'toolCall', ...c }))], api: 'ac-offline-api', provider: 'ac-offline', model: 'fixture', usage: structuredClone(usage), stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now() });
const result = (toolCallId, toolName, value, details) => sm.appendMessage({ role: 'toolResult', toolCallId, toolName, content: text(value), details, isError: false, timestamp: Date.now() });
let turn = 0;
function addTurn() {
  const i = turn++;
  user(`request ${i}: ${filler}`);
  if (i === 2) { assistant(`writing ${i}`, [{ id: `c${i}`, name: 'write', arguments: { path: 'src/parser.ts', content: 'SECRET FILE BODY' } }]); result(`c${i}`, 'write', 'ok', { path: 'src/parser.ts' }); }
  else if (i === 3) { assistant(`committing ${i}`, [{ id: `c${i}`, name: 'bash', arguments: { command: 'git commit -m "add parser"' } }]); result(`c${i}`, 'bash', '[main abc1234] add parser\n 1 file changed'); }
  else { assistant(`answer ${i}: ${filler}`, [{ id: `c${i}`, name: 'bash', arguments: { command: `step ${i}` } }]); result(`c${i}`, 'bash', `output ${i}`); }
  assistant(`done ${i}`);
}
for (let i = 0; i < 14; i++) addTurn();

const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never', compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 600 } });
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, additionalExtensionPaths: [entry], extensionFactories: [offline], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { provider: 'ac-offline', api: 'ac-offline-api', id: 'fixture', name: 'Offline', baseUrl: 'http://127.0.0.1:1/never-contacted', reasoning: false, input: ['text'], contextWindow, maxTokens: 2048, cost: zero };
const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: sm });
const errors = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });

const sessionFile = sm.getSessionFile();
const readEntries = async () => (await readFile(sessionFile, 'utf8')).split('\n').filter(Boolean);
const compactionEntries = async () => (await readEntries()).map(line => JSON.parse(line)).filter(e => e.type === 'compaction');
const out = { status: 'passed', scenario, host: sdk.VERSION };

if (scenario !== 'full') {
  // Pi must keep its own compaction when this extension cannot help: the native summary is produced and persisted.
  const compacted = await session.compact();
  assert.match(compacted.summary, /PI_NATIVE_SUMMARY/);
  assert.ok(providerCalls >= 1, 'Pi generated its own summary');
  const [persisted] = await compactionEntries();
  assert.ok(persisted && persisted.details?.compactor !== 'pi-auto-compact', 'the compaction is not ours');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...out, providerCalls, nativeSummary: true }));
  process.exit(0);
}

// A live shell job and monitor for the same session, published the way Shell and Monitor do.
const scope = { sessionId: sm.getSessionId(), cwd: canonicalMonitorCwd(workspace) };
const revokes = [
  publishCapability('shell_job', scope, 1, () => ({}), () => true, undefined, () => [{ kind: 'shell_job', jobId: 'SH-LIVE', status: 'running' }]),
  publishActiveMonitorBriefs(scope, () => [{ monitorId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', source: 'file', state: 'running', target: 'src/parser.ts', remainingMs: 240000 }]),
];

// 1. Real compaction: persisted, Pi's cut kept, no model call.
const first = await session.compact();
assert.equal(providerCalls, 0, 'compaction must not call the model');
assert.ok(first.summary.startsWith(`Session ${sm.getSessionId()}`), first.summary.slice(0, 120));
const [firstEntry] = await compactionEntries();
assert.equal(firstEntry.details.compactor, 'pi-auto-compact');
assert.equal(firstEntry.summary, first.summary);
assert.equal(firstEntry.firstKeptEntryId, first.firstKeptEntryId);
assert.ok(first.tokensBefore > 0);
const lines = await readEntries();
const parsed = lines.map(line => JSON.parse(line));
const keptIndex = parsed.findIndex(e => e.id === first.firstKeptEntryId);
assert.ok(keptIndex > 1, 'the cut is a real entry in the middle of the history');

// 2. Every reference in the summary points at the entry it names.
const refs = [...first.summary.matchAll(/⟦L(\d+):([0-9a-f]{8})/g)].map(m => [Number(m[1]), m[2]]);
assert.ok(refs.length >= 5, `references: ${refs.length}`);
for (const [line, id] of refs) assert.equal(JSON.parse(lines[line - 1]).id, id, `line ${line} holds ${id}`);

// 3. Resume: a fresh load sees the summary followed by exactly the entries Pi kept.
const resumed = sdk.SessionManager.open(sessionFile);
const context = resumed.buildSessionContext();
const keptMessages = parsed.slice(keptIndex).filter(e => e.type === 'message').map(e => e.message);
assert.equal(context.messages.length, 1 + keptMessages.length, 'summary plus the kept tail, nothing doubled or missing');
assert.equal(context.messages[0].role, 'compactionSummary');
assert.equal(context.messages[0].summary, first.summary);
assert.deepEqual(context.messages.slice(1).map(m => m.role), keptMessages.map(m => m.role));
assert.equal(JSON.stringify(context.messages.slice(1).at(-1).content), JSON.stringify(keptMessages.at(-1).content));

// The summary body: ordering, state, volatile blocks, and nothing the model must not get.
const at = needle => first.summary.indexOf(needle);
assert.ok(at('## State at compaction') > 0 && at('src/parser.ts (write)') > at('## State at compaction'));
assert.ok(first.summary.includes('abc1234 add parser'));
assert.ok(at('[Background Jobs') > at('## State at compaction') && first.summary.includes('- Shell Job: SH-LIVE (running)'));
assert.ok(at('[Active Monitors') > at('[Background Jobs'));
assert.ok(!first.summary.includes('SECRET FILE BODY'));

// 4. A second compaction keeps the window start while the slack has room, and its beginning is byte-identical.
for (let i = 0; i < 2; i++) addTurn();
const second = await session.compact();
const [, secondEntry] = await compactionEntries();
assert.equal(secondEntry.details.compactor, 'pi-auto-compact');
assert.equal(secondEntry.details.stats.windowStartKept, true, JSON.stringify(secondEntry.details.stats));
assert.equal(secondEntry.details.windowStart.entryId, firstEntry.details.windowStart.entryId);
const stable = first.summary.slice(0, first.summary.indexOf('\n\n## Recent activity'));
assert.ok(second.summary.startsWith(stable), 'the earlier conversation stayed byte-identical');
assert.equal(providerCalls, 0);

// 6. The session tools load in the real host and read what was compacted away.
const names = ['session_read', 'session_window', 'session_grep'];
session.setActiveToolsByName([...session.getActiveToolNames(), ...names]);
const run = async (name, params) => { const tool = session.agent.state.tools.find(t => t.name === name); assert.ok(tool, `${name} is active`); return (await tool.execute(`t-${name}`, params, undefined, undefined)).content.map(c => c.text ?? '').join('\n'); };
const grep = await run('session_grep', { pattern: 'request 0:' });
assert.match(grep, /request 0:/);
const [grepLine, grepId] = /⟦L(\d+):([0-9a-f]{8})/.exec(grep).slice(1);
assert.match(await run('session_read', { line: Number(grepLine), id: grepId }), /request 0:/);
assert.match(await run('session_window', { from: 2, to: 12 }), /request 0:/);

assert.deepEqual(errors, []);
for (const revoke of revokes) revoke();
console.log(JSON.stringify({ ...out, providerCalls, compactions: 2, refs: refs.length, summaryChars: first.summary.length, windowStartKept: true }));
process.exit(0);
