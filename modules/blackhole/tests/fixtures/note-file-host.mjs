import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
const root = resolve(process.argv[2]), agentDir = process.env.PI_CODING_AGENT_DIR;
assert.equal(process.env.PI_BLACKHOLE_PASSIVE, 'true');
const cwd = join(agentDir, 'workspace'); await mkdir(cwd, { recursive: true }); await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ compaction: 'off', memory: false, tailBehavior: 'minimal' }));
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: 'off', retry: { enabled: false }, enableInstallTelemetry: false });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: ['blackhole', 'note-tools', 'file-tools'].map(n => join(root, `modules/${n}/src/index.ts`)), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const defs = new Map(); for (const ext of loader.getExtensions().extensions) for (const [name, tool] of ext.tools) defs.set(name, tool.definition);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { ...modelRuntime.getModels()[0], id: 'offline-fixture', provider: 'offline-fixture', api: 'openai-responses' };
let session, providerCalls = 0; const errors = [];
const create = async sm => {
  const r = await sdk.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: sm, noTools: 'all' });
  r.session.agent.streamFn = () => { providerCalls++; throw new Error('Provider calls forbidden'); };
  await r.session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) }); return r.session;
};
const assistant = content => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
try {
  const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions')); session = await create(sm);
  sm.appendMessage({ role: 'user', content: 'Save reports and edit source without replaying any work', timestamp: Date.now() });
  const appendCalls = calls => sm.appendMessage(assistant(calls.map(([id, name, arguments_]) => ({ type: 'toolCall', id, name, arguments: arguments_ }))));
  // Direct actual producer executions, persisted with native ToolResultMessage fields;
  // no faux provider/model or background tools execute.
  const run = async (id, name, args, signal) => {
    let r; try { const value = await defs.get(name).execute(id, args, signal, undefined, { cwd }); r = { content: value.content, details: value.details, isError: value.isError === true }; }
    catch (e) { r = { content: [{ type: 'text', text: e.message }], isError: true }; }
    sm.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, ...r, timestamp: Date.now() }); return r;
  };
  const longContent = '# B1_NOTE_MARKER\n' + 'line\n'.repeat(16000) + 'LATE_NOTE_END';
  const noteArgs = { type: 'report', content: longContent }, planArgs = { type: 'plan', content: '# B1_PLAN_MARKER\n' };
  appendCalls([['note1', 'note', noteArgs], ['note2', 'note', planArgs], ['note-error', 'note', { type: 'task', content: ' ' }]]);
  const [note, plan, noteError] = await Promise.all([run('note1', 'note', noteArgs), run('note2', 'note', planArgs), run('note-error', 'note', { type: 'task', content: ' ' })]);
  assert.equal(note.isError, false); assert.equal(plan.isError, false); assert.equal(noteError.isError, true); assert.match(noteError.content[0].text, /NOTE_EMPTY/);
  const sourceArgs = { path: 'src/source.ts', content: 'BEFORE\r\n', expectedHash: 'missing' };
  appendCalls([['write', 'write', sourceArgs]]); const written = await run('write', 'write', sourceArgs); assert.equal(written.details.created, true);
  const readArgs = { path: 'src/source.ts' }; appendCalls([['read', 'read', readArgs]]); const read = await run('read', 'read', readArgs);
  const edits = [{ oldText: 'BEFORE', newText: 'AFTER' }], failedArgs = { path: 'src/source.ts', expectedHash: '0'.repeat(32), edits };
  appendCalls([['edit-error', 'edit', failedArgs]]); const editError = await run('edit-error', 'edit', failedArgs); assert.equal(editError.isError, true);
  const goodArgs = { path: 'src/source.ts', expectedHash: read.details.sha256, edits };
  appendCalls([['edit-success', 'edit', goodArgs]]); const edited = await run('edit-success', 'edit', goodArgs); assert.equal(edited.isError, false); assert.equal(edited.details.changedCount, 1);
  const failedWrite = { path: 'src/never-written.ts', content: 'NO', expectedHash: '0'.repeat(32) };
  appendCalls([['write-error', 'write', failedWrite], ['pending', 'write', { path: 'src/pending.ts', content: 'NO' }]]); assert.equal((await run('write-error', 'write', failedWrite)).isError, true);
  const aborted = new AbortController(); aborted.abort(); appendCalls([['read-cancel', 'read', { path: 'src/cancelled.ts' }]]); assert.equal((await run('read-cancel', 'read', { path: 'src/cancelled.ts' }, aborted.signal)).isError, true);
  // Synthetic malformed/provider-unexecuted persisted records: no producer executes
  // these calls. They test raw compaction authority, not provider agentLoop dispatch.
  const reviewCall = (id, path, name = 'write') => appendCalls([[id, name, name === 'bash' ? { command: `touch ${path}` } : { path, content: 'NOT_EXECUTED' }]]);
  const reviewResult = (id, name = 'write', flag = false) => sm.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name,
    ...(flag === 'missing' ? {} : { isError: flag }), timestamp: Date.now(), content: [{ type: 'text', text: flag === true ? 'Provider request failed; tool call was not executed' : 'ok' }] });
  reviewCall('review-mismatch', 'src/review-bad-mismatch.ts'); reviewResult('review-mismatch', 'bash');
  reviewCall('review-missing', 'src/review-bad-missing.ts'); reviewResult('review-missing', 'bash', 'missing');
  reviewResult('review-before'); reviewCall('review-before', 'src/review-bad-before.ts');
  reviewCall('review-dup-call', 'src/review-bad-dup-call.ts'); reviewCall('review-dup-call', 'src/review-bad-dup-call.ts'); reviewResult('review-dup-call');
  reviewCall('review-dup-result', 'src/review-bad-dup-result.ts'); reviewResult('review-dup-result'); reviewResult('review-dup-result', 'bash');
  reviewCall('review-mixed', 'src/review-bad-mixed.ts'); reviewCall('review-mixed', 'src/review-bad-mixed.ts', 'bash'); reviewResult('review-mixed', 'bash');
  reviewCall('review-unexecuted', 'src/review-bad-unexecuted.ts'); reviewResult('review-unexecuted', 'write', true);
  reviewCall('review-assistant', 'src/review-bad-assistant.ts');
  sm.appendMessage({ ...assistant([{ type: 'text', text: 'Saved and edited; failed attempts remain in history' }]), stopReason: 'stop' });
  const documents = [note.details.relativePath, plan.details.relativePath, 'src/source.ts'];
  const snapshots = new Map(); for (const path of documents) { const bytes = await readFile(join(cwd, path)); snapshots.set(path, { bytes, hash: createHash('sha256').update(bytes).digest('hex') }); }
  const persistedBefore = await readFile(sm.getSessionFile(), 'utf8'); const compact = await session.compact('__pi_vcc__');
  const fileSection = compact.summary.split('[Files And Changes]')[1].split('\n\n')[0];
  assert.match(fileSection, /Created/); for (const path of documents) assert.ok(fileSection.includes(path), path);
  assert.doesNotMatch(fileSection, /never-written|pending|cancelled|review-bad/);
  assert.match(compact.summary, /NOTE_EMPTY/); assert.match(compact.summary, /STALE_FILE/);
  const outstanding = compact.summary.includes('[Outstanding Context]') ? compact.summary.split('[Outstanding Context]')[1].split('\n\n')[0] : '';
  // Only the later unrelated failed write remains STALE_FILE, not the successful edit retry.
  assert.doesNotMatch(outstanding, /\[edit\]/);
  const file = sm.getSessionFile(); session.dispose(); session = undefined; const resumed = sdk.SessionManager.open(file); session = await create(resumed);
  const recall = async params => (await defs.get('recall').execute('recall', params, undefined, undefined, { cwd, sessionManager: resumed })).content[0].text;
  assert.match(await recall({ query: 'B1_NOTE_MARKER', mode: 'file' }), /report\//);
  const touched = await recall({ mode: 'touched' });
  assert.match(touched, new RegExp(note.details.relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(touched, /review-bad/);
  const entries = resumed.getEntries().filter(e => e.type === 'message'), noteIndex = entries.findIndex(e => e.message.role === 'assistant' && e.message.content.some(p => p.id === 'note1'));
  assert.ok(noteIndex >= 0); const body = await recall({ query: `#${noteIndex}:${note.details.relativePath}:full` });
  assert.match(body, /B1_NOTE_MARKER/); assert.ok(body.length <= 48000); assert.doesNotMatch(body, /LATE_NOTE_END/);
  // The default 48K response cap is smaller than the 50KiB file-display cap:
  // verify both independently against the actual resumed native session.
  const { expandEntryFile } = await import('../../src/core/drill-down.ts');
  const fullDisplay = expandEntryFile(file, noteIndex, note.details.relativePath, true);
  assert.match(fullDisplay, /50KB display limit/); assert.match(fullDisplay, /B1_NOTE_MARKER/);
  assert.ok(Buffer.byteLength(fullDisplay.split('\n\n')[1], 'utf8') <= 50 * 1024); assert.doesNotMatch(fullDisplay, /LATE_NOTE_END/);
  assert.match(await recall({ query: `#${noteIndex}:${note.details.relativePath}:16001:2` }), /LATE_NOTE_END/);
  assert.deepEqual(entries[noteIndex].message.content.find(p => p.id === 'note1').arguments, noteArgs);
  assert.ok((await readFile(file, 'utf8')).startsWith(persistedBefore));
  for (const [path, snapshot] of snapshots) { const bytes = await readFile(join(cwd, path)); assert.deepEqual(bytes, snapshot.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), snapshot.hash); }
  assert.deepEqual(errors, []); assert.equal(providerCalls, 0); assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')), {});
  console.log(JSON.stringify({ piVersion: '1.1.0', producerExecuted: true, nativeCompact: true, resumed: true, fileLists: true, malformedFileAttemptsExcluded: true, drilldown: true, originalArguments: true, fixtureBytesAndHashesUnchanged: true, providerCalls }));
} finally { session?.dispose(); }
