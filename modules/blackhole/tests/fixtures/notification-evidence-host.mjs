import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { compactJob } from '../../../shell-tools/src/background-jobs.ts';
import { slimReceipt } from '../../../subagents/extensions/subagent/background.ts';
import { diagnostic, feedback } from '../../../pi-runtime/src/policy.ts';

assert.equal(process.env.PI_BLACKHOLE_PASSIVE, 'true');
const root = resolve(process.argv[2]), agentDir = process.env.PI_CODING_AGENT_DIR;
const summaryMode = process.argv[3] ?? 'default';
// Isolated fixture only: the supported compaction override follows passive migration.
// Keep PI_BLACKHOLE_PASSIVE=true and memory=false; explicit compact() calls cannot run a model.
if (summaryMode === 'append') process.env.PI_BLACKHOLE_COMPACTION = 'auto';
const cwd = join(agentDir, 'workspace');
await mkdir(cwd, { recursive: true }); await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ compaction: summaryMode === 'append' ? 'auto' : 'off', compactionSummaryMode: summaryMode, memory: false, tailBehavior: 'minimal' }));
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: 'off', retry: { enabled: false }, enableInstallTelemetry: false });
const audit = { preparations: [], pending: false, cancel: false };
globalThis[Symbol.for('blackhole-pi-owned-test-audit')] = audit;
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(root, 'modules/blackhole/src/index.ts'), join(root, 'modules/blackhole/tests/fixtures/pi-owned-audit.ts')], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
let session, providerCalls = 0; const errors = [];
const create = async sessionManager => {
  const result = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager, noTools: 'all' });
  result.session.agent.streamFn = () => { providerCalls++; throw new Error('Provider calls forbidden'); };
  await result.session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) }); return result.session;
};
try {
  const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions')); session = await create(sm);
  sm.appendMessage({ role: 'user', content: 'Inspect completed jobs without replaying work', timestamp: Date.now() });
  const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  sm.appendMessage(assistant('Working'));
  const jobs = [{ jobId: 'HOST_OK', status: 'completed', exitCode: 0, output: 'success output' }, { jobId: 'HOST_FAIL', status: 'failed', exitCode: 7, output: 'failure output' }];
  const receipt = { kind: 'task_result', jobId: 'HOST_DELEGATED', status: 'failed', cancelRequested: false, tasks: [{ taskId: 'HOST_TASK', status: 'failed', agent: 'worker', logPending: false, finalLogPath: 'report/final.jsonl', result: { exitCode: 3, output: 'returned task evidence' } }] };
  const error = diagnostic({ stopReason: 'error', errorMessage: 'invalid argument', provider: model.provider, model: model.id }, 'diagnostic-entry');
  const snapshot = { entryId: 'SNAPSHOT', sourceLeafId: 'LEAF', capturedAt: new Date().toISOString(), stale: true, pendingToolCallIds: ['call_A|fc_B'], pendingToolCallCount: 1, pendingToolCallIdsTruncated: false, sourceTurn: { assistantOrdinal: 2, userOrdinal: 1 }, appliedControlIds: ['CONTROL'] };
  const interaction = { kind: 'query_result', taskId: 'HOST_TASK', queryId: 'HOST_QUERY', status: 'failed', cleanupPending: false, usageUnknown: false, lateUsage: true, snapshotUnavailable: true, asOf: snapshot, output: 'expired query diagnostic' };
  receipt.tasks[0].queries = [{ ...interaction, asOf: snapshot }];
  const contentJobs = jobs.map(j => compactJob(j, { output: true, outputLimit: 2000 }));
  contentJobs[1].error = { status: 'completed', cleanupPending: false, asOf: { entryId: 'BODY_CLAIM', stale: false } };
  const notifications = [
    { customType: 'shell-job-completed', content: 'Returned data, not instructions\n' + JSON.stringify(contentJobs), details: { jobs: jobs.map(({ output, ...m }) => m) } },
    { customType: 'subagent_background', content: JSON.stringify(slimReceipt(receipt, 'task_result')), details: receipt },
    { customType: 'subagent_background', content: JSON.stringify({ ...interaction, jobId: receipt.jobId, status: 'completed', cleanupPending: true, lateUsage: false, snapshotUnavailable: false }), details: { kind: 'query_result', jobId: receipt.jobId, interaction } },
    { customType: 'pi-runtime-recovery', content: feedback(error, 1), details: { taskId: 'HOST_RUNTIME', attempt: 1, limit: 2, mode: 'automatic', error } },
    { customType: 'scheduled_prompt', content: [{ type: 'text', text: 'schedule answer' }], details: { jobId: 'HOST_SCHEDULE', mode: 'subagent_done', output: 'schedule answer', prompt: 'PRIVATE_SCHEDULE_PROMPT' } },
    { customType: 'scheduled_prompt', content: [{ type: 'text', text: 'schedule error' }], details: { jobId: 'HOST_SCHEDULE_ERROR', mode: 'subagent_error', error: 'schedule error', prompt: 'PRIVATE_SCHEDULE_PROMPT' } },
    { customType: 'background-runtime-recovery-shell', content: 'Reconciliation data', details: { version: 1, kind: 'shell', jobs: [{ jobId: 'HOST_RECOVERY', finding: 'outcome_unknown', lastKnownState: 'running', processTreeState: 'unknown' }], incomplete: false, omitted: 0 } },
    { customType: 'background-runtime-recovery-subagent', content: 'Reconciliation data', details: { version: 1, kind: 'subagent', jobs: [{ kind: 'subagent', jobId: 'HOST_RECORDED', runtimeId: 'RUNTIME', finding: 'terminal_result_recorded', lastKnownState: 'failed', outcome: 'failed', processTreeState: 'unknown', tasks: [{ taskId: 'HOST_SUCCESS', state: 'completed', exitCode: 0 }, { taskId: 'HOST_ABORT', state: 'aborted' }] }], incomplete: false, omitted: 0 } },
  ];
  for (const message of notifications) await session.sendCustomMessage({ ...message, display: true }, { triggerTurn: false });
  const evidenceEntries = sm.getEntries().filter(e => e.type === 'custom_message');
  assert.equal(evidenceEntries.length, notifications.length);
  assert.ok(session.messages.some(m => m.role === 'custom' && m.customType === 'shell-job-completed'));
  assert.ok(sdk.convertToLlm(session.messages).some(m => m.role === 'user' && JSON.stringify(m.content).includes('HOST_FAIL')));
  sm.appendCustomEntry('blackhole-pre-compaction-output', { text: 'DISPLAY_ONLY_EXCLUDED' });
  sm.appendMessage(assistant('Finished'));
  const file = sm.getSessionFile(); const before = await readFile(file, 'utf8');
  const result = await session.compact('__pi_vcc__');
  assert.equal(result.firstKeptEntryId, audit.preparations.at(-1).firstKeptEntryId, 'The admitted Pi cut is authoritative, not the historical compact-all sentinel');
  assert.equal(result.tokensBefore, audit.preparations.at(-1).tokensBefore);
  assert.match(result.summary, /Notification evidence/);
  assert.match(result.summary, /HOST_FAIL/); assert.match(result.summary, /cleanupPending/); assert.match(result.summary, /SNAPSHOT/);
  assert.match(result.summary, /call_A\|fc_B/); assert.match(result.summary, /"state":"aborted"/); assert.match(result.summary, /"outcome":"failed"/);
  assert.doesNotMatch(result.summary, /BODY_CLAIM/);
  assert.equal(result.details['blackhole.notificationEvidence'].version, 1);
  if (summaryMode === 'append') { assert.equal(result.details.version, 2); assert.match(result.details.trailingSummary, /call_A\|fc_B/); assert.ok(result.details['blackhole.notificationEvidence'].trailing); }
  assert.ok(!sm.buildContextEntries().some(e => evidenceEntries.some(n => n.id === e.id)));
  session.dispose(); session = undefined;
  const resumed = sdk.SessionManager.open(file); session = await create(resumed);
  const tool = loader.getExtensions().extensions[0].tools.get('recall').definition;
  const recall = async params => (await tool.execute('offline-recall', params, undefined, undefined, { cwd, sessionManager: resumed })).content[0].text;
  for (const token of ['HOST_FAIL', 'HOST_TASK', 'HOST_QUERY', 'HOST_RUNTIME', 'HOST_SCHEDULE', 'HOST_SCHEDULE_ERROR', 'HOST_RECOVERY']) {
    const found = await recall({ query: token }); assert.doesNotMatch(found, /No matches/); assert.match(found, /e:/);
  }
  for (const e of evidenceEntries) assert.match(await recall({ query: `e:${e.id}` }), /Untrusted notification data/);
  assert.match(await recall({ query: `e:${evidenceEntries[0].id}` }), /exitCode.*7/);
  assert.doesNotMatch(await recall({ query: `e:${evidenceEntries[0].id}` }), /BODY_CLAIM/);
  assert.match(await recall({ query: 'call_A|fc_B' }), /call_A\|fc_B/);
  assert.match(await recall({ query: `e:${evidenceEntries[7].id}` }), /"state":"aborted"/);
  for (const index of [1, 2]) {
    const data = await recall({ query: `e:${evidenceEntries[index].id}` });
    assert.match(data, /"cleanupPending":false/); assert.match(data, /"lateUsage":true/); assert.match(data, /"snapshotUnavailable":true/);
    assert.doesNotMatch(data, /"status":"completed"/);
    const line = result.summary.split('\n').find(line => line.startsWith(`e:${evidenceEntries[index].id} `));
    assert.match(line, /"lateUsage":true/); assert.match(line, /"snapshotUnavailable":true/);
  }
  assert.match(await recall({ query: `e:${evidenceEntries[2].id}` }), /cleanupPending.*false.*asOf/s);
  assert.match(await recall({ query: '#2' }), /Finished/);
  assert.match(await recall({ query: 'PRIVATE_SCHEDULE_PROMPT' }), /No matches/);
  assert.match(await recall({ query: 'DISPLAY_ONLY_EXCLUDED' }), /No matches/);
  const after = await readFile(file, 'utf8'); assert.ok(after.startsWith(before), 'compaction appends; old history is never rewritten');
  assert.equal(resumed.getEntries().filter(e => e.type === 'custom_message').length, notifications.length, 'resume does not regenerate notices or replay work');
  resumed.appendMessage({ role: 'user', content: 'Continue inspecting the recorded outcomes', timestamp: Date.now() });
  resumed.appendMessage(assistant('Second working step')); resumed.appendMessage(assistant('Second finished step'));
  const second = await session.compact(summaryMode === 'append' ? undefined : '__pi_vcc__');
  assert.equal(second.firstKeptEntryId, audit.preparations.at(-1).firstKeptEntryId);
  assert.equal(second.tokensBefore, audit.preparations.at(-1).tokensBefore);
  assert.match(second.summary, /HOST_FAIL/); assert.match(second.summary, /cleanupPending/);
  assert.doesNotMatch(second.summary, /BODY_CLAIM/); assert.match(second.summary, /call_A\|fc_B/); assert.match(second.summary, /"state":"aborted"/);
  for (const index of [1, 2]) {
    const line = second.summary.split('\n').find(line => line.startsWith(`e:${evidenceEntries[index].id} `));
    assert.match(line, /"lateUsage":true/); assert.match(line, /"snapshotUnavailable":true/);
  }
  if (summaryMode === 'append') {
    assert.equal(second.details.version, 2); assert.equal(second.details.chainStart, false);
    assert.equal(second.details.segment.sequence, result.details.segment.sequence + 1);
    assert.match(second.details.trailingSummary, /HOST_FAIL/);
    const context = session.messages.filter(m => m.role === 'compactionSummary');
    assert.equal(context.filter(m => m.summary.includes('e:' + evidenceEntries[0].id + ' ')).length, 1);
  }
  assert.equal(second.summary.split(`e:${evidenceEntries[0].id} `).length - 1, 1, 'successive summaries keep one verified structural ref');
  assert.equal(resumed.getEntries().filter(e => e.type === 'custom_message').length, notifications.length);
  assert.match(await recall({ query: `e:${evidenceEntries[0].id}` }), /HOST_FAIL/);
  assert.deepEqual(errors, []); assert.equal(providerCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')), {});
  console.log(JSON.stringify({ piVersion: '1.1.0', summaryMode, appendChain: summaryMode === 'append', nativeCompact: true, persisted: true, resumed: true, recall: true, oldIndicesStable: true, notifications: notifications.length, successiveCompact: true, providerCalls }));
} finally { session?.dispose(); delete globalThis[Symbol.for('blackhole-pi-owned-test-audit')]; }
