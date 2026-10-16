import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const root = process.cwd(), out = resolve('review-evidence/20261014-fixes');
const home = await fs.mkdtemp(join(tmpdir(), 'pi-review-sdk-'));
process.env.HOME = process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = join(home, 'agent'); process.env.PI_BLACKHOLE_PASSIVE = 'true'; process.env.TEMP = process.env.TMP = home;
await fs.mkdir(process.env.PI_CODING_AGENT_DIR); await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{}'); await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{}');
globalThis.fetch = async () => { throw new Error('Network forbidden in SDK review probe'); };
const sdk = await import('@earendil-works/pi-coding-agent');
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const { ulid } = await import('ulid');
const { CronStorage } = await import('../../modules/schedule-prompt/src/storage.ts');
const { CronScheduler } = await import('../../modules/schedule-prompt/src/scheduler.ts');
const { createCronTool } = await import('../../modules/schedule-prompt/src/tool.ts');
const { analyzeOrphaned } = await import('../../modules/blackhole/src/om/cleanup.ts');
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { ...modelRuntime.getModels()[0], id: 'review', provider: 'review-sdk', api: 'openai-responses' };
const runtimeThird = process.argv.includes('--runtime-third');
const currentGrowth = process.argv.includes('--current-growth');
const resultPath = join(out, currentGrowth ? 'sdk-current-growth-results.json' : runtimeThird ? 'sdk-third-results.json' : 'sdk-g5-results.json');
const results = { host: sdk.VERSION, isolatedHome: home, runtimeThird, currentGrowth, samples: [], cleanup: false };
const { createHash } = await import('node:crypto');
const currentPaths = ['index.ts', 'policy.ts', 'debug-log.ts'];
async function runtimeHashes() { return Object.fromEntries(await Promise.all(currentPaths.map(async name => [name, createHash('sha256').update(await fs.readFile(join(root, 'modules/pi-runtime/src', name))).digest('hex')]))); }
await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
const heartbeat = setInterval(() => console.error('Progress: SDK probes are running offline...'), 10000);
let activeSession, activeScheduler;
const messageText = m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
async function makeSession(cwd, sm, paths, response) {
  const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
  let pi, ctx, calls = 0;
  const contexts = [], errors = [];
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings, additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [api => {
      pi = api;
      api.on('session_start', (_e, context) => ctx = context);
      api.registerProvider(model.provider, { api: model.api, apiKey: 'offline-non-secret', baseUrl: 'https://unused.invalid', models: [model], streamSimple: (m, context, options) => {
        calls++;
        const contextText = context.messages.map(messageText).join('\n');
        contexts.push({ call: calls, hasSafeScheduleMarker: contextText.includes('SAFE_COMMAND_RESULT'), hasChangedCommandMarker: contextText.includes('CHANGED_COMMAND_B'), hasRuntimeFeedback: contextText.includes('Runtime API-error recovery.') });
        const value = response?.(calls, sm) ?? { text: 'offline fixture complete' };
        const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, content: value.error ? [] : [{ type: 'text', text: value.text }], stopReason: value.error ? 'error' : 'stop', timestamp: Date.now(), ...(value.error ? { errorMessage: value.error } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          try {
            await options?.onPayload?.({ fixture: true }, m);
            stream.push({ type: 'start', partial: message });
            if (value.error) stream.push({ type: 'error', reason: 'error', error: message });
            else { stream.push({ type: 'text_start', contentIndex: 0, partial: message }); stream.push({ type: 'text_end', contentIndex: 0, content: value.text, partial: message }); stream.push({ type: 'done', reason: 'stop', message }); }
            stream.end();
          } catch (error) { message.stopReason = 'error'; message.errorMessage = String(error); stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); }
        });
        return stream;
      } });
    }]
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, model, settingsManager: settings, resourceLoader: loader, sessionManager: sm, noTools: 'all' });
  activeSession = session;
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(String(e.error)) });
  return { session, pi, ctx, contexts, errors, calls: () => calls };
}
async function dispose(session) { await new sdk.AgentSessionRuntime(session, {}, async () => { throw new Error('Replacement forbidden in review'); }).dispose(); if (activeSession === session) activeSession = undefined; }
try {
  if (currentGrowth) {
    results.sourceHashesBefore = await runtimeHashes();
    assert(results.sourceHashesBefore['index.ts'].startsWith('e1043fc79a0d571bd4dec5dc1aaef348'), 'runtime changed again before fixed-source recheck');
    await fs.mkdir(join(out, 'current-runtime'), { recursive: true });
    for (const name of currentPaths) await fs.copyFile(join(root, 'modules/pi-runtime/src', name), join(out, 'current-runtime', name));
    await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
  }
  for (let iteration = 1; iteration <= (runtimeThird || currentGrowth ? 0 : 3); iteration++) {
    console.log(`Progress: G5-001 real SDK command context ${iteration}/3`);
    const cwd = join(home, `schedule-${iteration}`); await fs.mkdir(cwd);
    const sm = sdk.SessionManager.create(cwd, join(cwd, 'sessions'));
    const host = await makeSession(cwd, sm, []);
    await host.session.prompt('Create an offline baseline conversation.');
    const ctx = { ...host.ctx, isProjectTrusted: () => true }; // trusted-project input seam only; real API/storage/backend
    const storage = new CronStorage(cwd), scheduler = new CronScheduler(storage, host.pi, ctx); activeScheduler = scheduler;
    const job = { id: ulid().toUpperCase(), name: 'safe result', type: 'interval', schedule: '1h', intervalMs: 3600000, command: "Write-Output 'SAFE_COMMAND_RESULT'", shell: 'powershell', enabled: true, runCount: 0, createdAt: new Date().toISOString(), session: sm.getSessionId() };
    storage.addJob(job);
    assert.equal(await scheduler.fire(job), true);
    await Promise.all([...scheduler.childRuns]);
    await new Promise(r => setImmediate(r));
    const markers = sm.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'scheduled_prompt');
    const idleCallsBeforeNextPrompt = host.calls();
    await host.session.prompt('Inspect the conversation without calling any tool.');
    results.samples.push({ id: 'G5-001', iteration, seam: 'real SDK ExtensionAPI sendMessage/context, CronScheduler/CronStorage and real PowerShell backend; trusted-project context input seam', markerModes: markers.map(e => e.details?.mode), outputPresentInPersistedContent: markers.some(e => messageText(e).includes('SAFE_COMMAND_RESULT')), nextRequestHasCommandOutput: host.contexts.at(-1).hasSafeScheduleMarker, callsBeforeNextPrompt: idleCallsBeforeNextPrompt, callsAfterNextPrompt: host.calls(), commandStatus: storage.getJob(job.id).lastStatus });
    console.log(`Progress: G5-002 two-writer enable confirmation race ${iteration}/3`);
    const a = { ...job, id: ulid().toUpperCase(), name: 'confirm A', enabled: false, command: "Write-Output 'CONFIRMED_COMMAND_A'" };
    storage.addJob(a);
    const peer = new CronStorage(cwd);
    let answer, entered, shown;
    const dialog = new Promise(r => entered = r);
    const approved = new Promise(r => answer = r);
    const tool = createCronTool(() => storage, () => scheduler);
    const pending = tool.execute('enable', { action: 'enable', jobId: a.id }, undefined, undefined, { ...ctx, hasUI: true, ui: { ...ctx.ui, confirm: async (_title, text) => { shown = text; entered(); return approved; } } });
    await dialog;
    peer.updateJob(a.id, { command: "Write-Output 'CHANGED_COMMAND_B'" });
    answer(true);
    const enabled = await pending.catch(error => ({ isError: true, thrown: String(error?.message ?? error) })), fresh = storage.getJob(a.id);
    // Post-fix variant: a refused enable must not run anything; only fire when the stored job is enabled.
    const fired = fresh.enabled ? await scheduler.fire(fresh) : false; await Promise.all([...scheduler.childRuns]); await new Promise(r => setImmediate(r));
    const last = sm.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'scheduled_prompt' && e.details?.mode === 'command_done').at(-1);
    results.samples.push({ id: 'G5-002', iteration, seam: 'product createCronTool, real two CronStorage writers, controlled UI approval barrier; actual scheduler/backend fire', shownCommandA: shown.includes('CONFIRMED_COMMAND_A'), enableRefused: enabled.isError === true || enabled.thrown !== undefined, reportedCommandA: enabled.details?.jobs?.[0]?.command?.includes('CONFIRMED_COMMAND_A') ?? false, persistedCommandB: fresh.command.includes('CHANGED_COMMAND_B'), persistedEnabled: fresh.enabled, fired, changedCommandBOutputObserved: Boolean(last?.details?.output?.includes('CHANGED_COMMAND_B')) });
    scheduler.stop(); const drained = await scheduler.drain(5000); assert.equal(drained.pending, 0); activeScheduler = undefined;
    assert.deepEqual(host.errors, []); await dispose(host.session);
    console.log(`Progress: G5-004 bounded header-only scan measurement ${iteration}/3`);
    const scan = join(home, `scan-${iteration}`); await fs.mkdir(scan);
    const scanFile = join(scan, 'large.jsonl');
    const header = JSON.stringify({ type: 'session', id: ulid().toUpperCase() }) + '\n';
    await fs.writeFile(scanFile, header + 'x'.repeat(2 * 1024 * 1024));
    const originalRead = syncFs.readFileSync; let readBytes = 0;
    syncFs.readFileSync = (...args) => { const value = originalRead(...args); if (String(args[0]) === scanFile) readBytes += Buffer.byteLength(value); return value; };
    syncBuiltinESMExports();
    const start = performance.now(); let report;
    try { report = analyzeOrphaned(process.env.PI_CODING_AGENT_DIR, [scan]); }
    finally { syncFs.readFileSync = originalRead; syncBuiltinESMExports(); }
    results.samples.push({ id: 'G5-004', iteration, fixtureBytes: (await fs.stat(scanFile)).size, headerBytes: Buffer.byteLength(header), bytesActuallyRead: readBytes, elapsedMs: performance.now() - start, scanComplete: report.scanComplete, contractFailureObserved: false });
    await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
  }
  for (let iteration = 1; iteration <= 0; iteration++) {
    for (const variant of (currentGrowth ? ['growth-after-start'] : ['growth-after-start', 'under-bound-control', 'over-bound-at-start-control'])) {
      console.log(`Progress: G6-001 native history bound ${variant} ${iteration}/3`);
      const cwd = join(home, `runtime-${iteration}-${variant}`); await fs.mkdir(cwd);
      const initial = sdk.SessionManager.create(cwd, join(cwd, 'sessions'));
      await fs.mkdir(join(cwd, 'sessions'), { recursive: true });
      const header = initial.getHeader(), file = initial.getSessionFile();
      const count = variant === 'over-bound-at-start-control' ? 100010 : 99980;
      let prev = null; const lines = [JSON.stringify(header)];
      for (let n = 0; n < count - 1; n++) { const id = ulid().toUpperCase(); lines.push(JSON.stringify({ type: 'custom', id, parentId: prev, timestamp: '2026-10-14T05:00:00.000Z', customType: 'review-padding', data: null })); prev = id; }
      lines.push(JSON.stringify({ type: 'custom', id: ulid().toUpperCase(), parentId: prev, timestamp: '2026-10-14T05:00:00.000Z', customType: 'pi-runtime-state', data: { version: 1, taskId: ulid().toUpperCase(), used: 0, enabled: true, handled: [], fingerprints: [], pending: null } }));
      await fs.writeFile(file, lines.join('\n') + '\n'); lines.length = 0;
      const sm = sdk.SessionManager.open(file);
      let entriesAtFirstRequest;
      const host = await makeSession(cwd, sm, [join(root, 'modules/pi-runtime/src/index.ts')], (calls, manager) => {
        if (calls === 1) {
          if (variant === 'growth-after-start') for (let n = 0; n < 30; n++) manager.appendCustomEntry('review-growth', { n });
          entriesAtFirstRequest = manager.getEntries().length;
          return { error: 'invalid_request_error: invalid argument in owned offline fixture' };
        }
        return { text: 'offline recovery complete' };
      });
      await host.session.prompt('Diagnose a local application error with an authorized read-only objective.');
      const entries = sm.getEntries(), feedbacks = entries.filter(e => e.type === 'custom_message' && e.customType === 'pi-runtime-recovery');
      const saved = entries.filter(e => e.type === 'custom' && e.customType === 'pi-runtime-state').at(-1)?.data;
      results.samples.push({ id: 'G6-001', iteration, variant, seam: 'real Pi SDK loader/runtime hooks, native SessionManager seeded with fixture JSONL before bind; public appendCustomEntry growth during synthetic request', initialEntries: count, entriesAtFirstRequest, entriesAfter: entries.length, fixtureModelCalls: host.calls(), recoveries: feedbacks.length, used: saved?.used, contextIncludesRecovery: host.contexts.some(c => c.hasRuntimeFeedback), errors: host.errors });
      assert.deepEqual(host.errors, []); await dispose(host.session);
      await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
    }
  }
} finally {
  if (activeScheduler) { activeScheduler.stop(); await activeScheduler.drain(5000); }
  if (activeSession) await dispose(activeSession);
  await modelRuntime.dispose?.(); clearInterval(heartbeat);
  await fs.rm(home, { recursive: true, force: true }); results.cleanup = true;
  if (currentGrowth) { results.sourceHashesAfter = await runtimeHashes(); results.sourceStable = JSON.stringify(results.sourceHashesBefore) === JSON.stringify(results.sourceHashesAfter); if (!results.sourceStable) process.exitCode = 1; }
  await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
}
console.log(`Progress: SDK probes complete, ${results.samples.length} samples`);
