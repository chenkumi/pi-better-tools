// Real Pi loader + deterministic provider. Run only under an isolated environment.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.argv[2]);
const host = process.env.PI_BETTER_TOOLS_HOST;
const heartbeat = setInterval(() => console.log('[goal-runtime] Offline lifecycle verification still running...'), 10000);
globalThis.fetch = async () => { throw new Error('Network forbidden in goal runtime tests'); };
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR);
assert.ok(agentDir.startsWith(resolve(homedir())), 'test agentDir must be under isolated home');
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const ai = await import(host ? pathToFileURL(join(dirname(host), 'pi-ai/dist/index.js')).href : '@earendil-works/pi-ai');
const cases = [], cleanups = [];
const stateType = 'pi-better-goal-state', controlType = 'pi-better-goal-control';
const text = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(options = {}) {
  const cwd = await mkdtemp(join(homedir(), 'goal-case-'));
  const provider = `goal-offline-${cases.length}-${Math.random().toString(36).slice(2)}`, api = `${provider}-api`;
  let session, calls = 0, invocations = 0, works = 0, starts = 0, settles = 0, prepared = 0, handled = 0, release, lastMessage;
  const errors = [], contexts = [], releases = [];
  let preflights = 0, firstPrompt;
  let script = options.script ?? 'complete';
  const model = { id: 'fixture', name: 'Goal offline fixture', provider, api, baseUrl: 'http://unused.invalid', reasoning: false,
    input: ['text'], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
  const pre = pi => {
    pi.on('before_agent_start', event => {
      preflights++;
      if (preflights === 1) firstPrompt = event.prompt;
      if (options.gate === 'before' || options.overlap && preflights === 1) return new Promise(r => { release = r; releases.push(r); });
    });
    if (options.transform === 'before') pi.on('input', event => ({ action: 'transform', text: `Wrapper\n${event.text}\nEnd wrapper` }));
    pi.on('agent_before_settle', event => options.compose && calls === 1 ? { entries: [...event.entries, { type: 'custom', customType: 'other-proof', data: 'KEEP' }] } : undefined);
  };
  const post = pi => {
    pi.on('before_agent_start', event => {
      if (options.gate === 'after' || options.overlap && event.prompt !== firstPrompt) return new Promise(r => { release = r; releases.push(r); });
    });
    if (options.transform === 'after') pi.on('input', event => ({ action: 'transform', text: `Wrapper\n${event.text}\nEnd wrapper` }));
    if (options.handled) pi.on('input', event => event.source === 'extension' ? (handled++, { action: 'handled' }) : undefined);
    if (options.veto) pi.on('agent_before_settle', () => ({ continue: false }));
    pi.on('before_agent_start', event => { prepared++; event.systemPromptOptions.sections.fixture = 'KEEP_PROMPT_SECTION'; });
    pi.on('agent_start', () => { starts++; });
    pi.on('agent_settled', () => { settles++; });
    pi.registerTool({ name: 'goal_work', label: 'Offline result', description: 'Create an isolated result for deterministic tests', parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { works++; await writeFile(join(cwd, 'result.txt'), 'RESULT_OK'); return { content: [{ type: 'text', text: 'Verified isolated result: RESULT_OK' }], details: { verified: true } }; } });
    pi.registerProvider(provider, { api, baseUrl: 'http://unused.invalid', apiKey: 'offline-non-secret', models: [model],
      streamSimple(m, context, opts) {
        invocations++;
        const stream = ai.createAssistantMessageEventStream();
        const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, content: [], stopReason: 'stop', timestamp: Date.now(), usage: usage() };
        lastMessage = message;
        const respond = async () => {
          try {
            if (opts?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); return; }
            const nth = ++calls; contexts.push(structuredClone(context.messages));
            assert.ok(nth <= 30, 'offline provider request capacity');
            if (script === 'wait') await new Promise(r => { release = r; opts.signal?.addEventListener('abort', r, { once: true }); });
            if (opts?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); return; }
            const goal = [...session.sessionManager.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === stateType)?.data.goal;
            const complete = () => ({ action: 'complete', goalId: goal.id, runId: goal.runId, summary: 'Acceptance result verified', verification: [{ criterion: 'RESULT_OK outcome', evidence: 'Real isolated tool result, or deterministic fixture acceptance check' }] });
            let toolCalls;
            if (script === 'rounds' && nth === 2) toolCalls = [{ type: 'toolCall', id: `work-${nth}`, name: 'goal_work', arguments: {} }];
            if (script === 'rounds' && nth === 3) { assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'RESULT_OK'); toolCalls = [{ type: 'toolCall', id: 'complete', name: 'goal', arguments: complete() }]; }
            if (['complete', 'post-stop'].includes(script) && nth === 1) toolCalls = [{ type: 'toolCall', id: 'complete', name: 'goal', arguments: complete() }, ...(script === 'post-stop' ? [{ type: 'toolCall', id: 'after-complete', name: 'goal_work', arguments: {} }] : [])];
            if (script === 'blocked' && nth === 1) toolCalls = [{ type: 'toolCall', id: 'blocked', name: 'goal', arguments: { action: 'blocked', goalId: goal.id, runId: goal.runId, reason: 'User permission required', suggestedAction: 'Request explicit permission' } }];
            if (script === 'error') { message.stopReason = 'error'; message.errorMessage = 'deterministic provider failure'; stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); return; }
            if (toolCalls) { message.content = toolCalls; message.stopReason = 'toolUse'; }
            else message.content = script === 'empty' ? [] : [{ type: 'text', text: script === 'rounds' && nth === 1 ? '完成了；計畫已全勾選（沒有 goal outcome）' : 'OFFLINE_SUMMARY' }];
            stream.push({ type: 'start', partial: message });
            for (const [i, block] of message.content.entries()) {
              if (block.type === 'toolCall') { stream.push({ type: 'toolcall_start', contentIndex: i, partial: message }); stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: message }); }
              else { stream.push({ type: 'text_start', contentIndex: i, partial: message }); stream.push({ type: 'text_end', contentIndex: i, content: block.text, partial: message }); }
            }
            stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
          } catch (error) { message.stopReason = 'error'; message.errorMessage = String(error.stack ?? error); stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); }
        };
        setImmediate(respond); return stream;
      },
    });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(packageRoot, 'modules/goal/src/index.ts')],
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: 'Deterministic offline goal fixture.', extensionFactories: [{ name: 'goal-pre', factory: pre }, { name: 'goal-post', factory: post }],
    extensionsOverride: result => ({ ...result, extensions: [result.extensions.find(e => e.path === '<inline:goal-pre>'), ...result.extensions.filter(e => !e.path.startsWith('<inline:')), result.extensions.find(e => e.path === '<inline:goal-post>')] }),
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const manager = sdk.SessionManager.create(cwd, join(cwd, 'sessions'));
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, model, settingsManager: settings, resourceLoader: loader,
    sessionManager: manager, tools: ['goal', 'goal_work'], ...(options.exclude ? { excludeTools: ['goal'] } : {}) }));
  await session.bindExtensions({ mode: 'json', onError: event => errors.push(event.error) });
  const command = args => session.extensionRunner.getCommand('goal').handler(args, session.extensionRunner.createCommandContext());
  const get = async () => {
    const tool = session.agent.state.tools.find(t => t.name === 'goal'); assert.ok(tool);
    const result = await tool.execute('get', { action: 'get' }, undefined, undefined);
    return result.details;
  };
  const state = () => [...manager.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === stateType)?.data.goal;
  const settle = () => until(() => settles > 0 && session.isIdle, `settled; calls=${calls}, errors=${JSON.stringify(errors)}, last=${lastMessage?.errorMessage}`);
  const cleanup = async () => { release?.(); for (const r of releases) r(); await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };
  cleanups.push(cleanup);
  return { session, manager, loader, command, get, state, settle, errors, contexts, cwd,
    calls: () => calls, works: () => works, prepared: () => prepared, starts: () => starts, settles: () => settles, handled: () => handled,
    gated: () => !!release, gates: () => releases.length, releaseAt: i => releases[i]?.(), release: () => release?.(), setScript: v => { script = v; }, invocations: () => invocations };
}
async function check(name, fn) {
  console.log(`[goal-runtime] Checking ${name} on Pi ${sdk.VERSION}...`);
  const start = Date.now();
  try { await fn(); cases.push({ name, status: 'passed', durationMs: Date.now() - start }); }
  finally { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
}
try {
  await check('goal-first multi-round outcome, natural text is not completion, boundary composition', async () => {
    const f = await fixture({ script: 'rounds', compose: true }); const objective = '輸出 RESULT_OK；實際驗證；不要求 plan。\n完整限制 😀';
    await f.command(objective); await f.settle();
    assert.equal(f.state().objective, objective); assert.equal(f.state().status, 'complete'); assert.equal(f.state().autoRequests, 1);
    assert.equal(f.calls(), 4); assert.equal(f.works(), 1); assert.equal(f.prepared(), 1); assert.equal(f.starts(), 2);
    assert.ok(f.manager.getBranch().some(e => e.type === 'custom' && e.customType === 'other-proof' && e.data === 'KEEP'));
    assert.equal(f.contexts[1].filter(m => text(m).includes('Goal extension reminder')).length, 1);
    // Pi persists/replays structured sections with empty content; inspect the
    // section, not only the opaque content field.
    assert.ok(f.contexts[0].some(m => m.role === 'system' && m.sections?.fixture?.includes('KEEP_PROMPT_SECTION')));
    const reopened = sdk.SessionManager.open(f.manager.getSessionFile());
    assert.equal([...reopened.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === stateType).data.goal.status, 'complete');
    assert.deepEqual(f.errors, []);
  });
  await check('complete with no plan, post-stop sibling tool gate and unrelated later user run', async () => {
    const f = await fixture({ script: 'post-stop' }); await f.command('Accept deterministic fixture result'); await f.settle();
    assert.equal(f.state().status, 'complete'); assert.equal(f.works(), 0);
    const denied = f.session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'after-complete'); assert.equal(denied.isError, true); assert.match(text(denied), /GOAL_STOPPED/);
    f.setScript('ordinary'); const before = f.calls(); await f.session.prompt('ordinary user request'); assert.equal(f.calls(), before + 1); assert.equal(f.state().status, 'complete'); assert.deepEqual(f.errors, []);
  });
  await check('blocked persists concrete action and explicit resume rotates run identity', async () => {
    const f = await fixture({ script: 'blocked' }); await f.command('Result needs permission'); await f.settle(); const old = structuredClone(f.state());
    assert.equal(old.status, 'blocked'); assert.equal(old.suggestedAction, 'Request explicit permission'); f.setScript('ordinary');
    await f.command('resume'); await until(() => f.settles() === 2, 'resume settles'); assert.equal(f.state().id, old.id); assert.notEqual(f.state().runId, old.runId); assert.equal(f.state().status, 'paused'); assert.equal(f.state().autoRequests, 20); assert.deepEqual(f.errors, []);
  });
  for (const script of ['empty', 'ordinary', 'error']) await check(`bounded ${script} outcome`, async () => {
    const f = await fixture({ script }); await f.command('Do useful authorized work'); await f.settle();
    assert.equal(f.state().status, 'paused'); assert.equal(f.calls(), script === 'empty' ? 4 : script === 'ordinary' ? 21 : 1);
    assert.equal(f.state().autoRequests, script === 'empty' ? 3 : script === 'ordinary' ? 20 : 0);
    if (script === 'empty') assert.equal(f.state().emptyResponses, 3); assert.deepEqual(f.errors, []);
  });
  for (const gate of ['before', 'after']) for (const action of ['pause', 'clear']) await check(`${action} during ${gate}-goal preflight (BUG-001)`, async () => {
    const f = await fixture({ gate, script: 'rounds' }); await f.command('Do not execute a cancelled goal'); await until(f.gated, 'preflight gate');
    await f.command(action); f.release(); await f.settle(); assert.equal(f.calls(), 0); assert.equal(f.works(), 0);
    assert.equal(f.state()?.status ?? null, action === 'clear' ? null : 'paused'); assert.deepEqual(f.errors, []);
  });
  await check('late cancelled preflight cannot steal or settle a newer ready run', async () => {
    const f = await fixture({ overlap: true }); await f.command('Current full objective'); await until(() => f.gates() === 1, 'old preflight');
    const oldRun = f.state().runId; await f.command('pause'); await f.command('resume'); await until(() => f.gates() === 2, 'new ready preflight');
    const newRun = f.state().runId; assert.notEqual(newRun, oldRun);
    f.releaseAt(0); await until(() => f.settles() === 1, 'old cancellation settles');
    assert.equal((await f.get()).goal.runId, newRun); assert.equal(f.state().status, 'active'); assert.equal(f.calls(), 0);
    f.releaseAt(1); await until(() => f.settles() === 2, 'new run settles'); assert.equal(f.state().status, 'complete'); assert.equal(f.state().runId, newRun); assert.deepEqual(f.errors, []);
  });
  for (const transform of ['before', 'after']) await check(`input transform ${transform} goal preserves correlation and objective`, async () => {
    const f = await fixture({ transform }); await f.command('Original acceptance objective'); await f.settle(); assert.equal(f.state().status, 'complete'); assert.equal(f.state().objective, 'Original acceptance objective'); assert.deepEqual(f.errors, []);
  });
  await check('downstream handled launch never adopts next unrelated prompt (BUG-002)', async () => {
    const f = await fixture({ handled: true, script: 'ordinary' }); await f.command('Original acceptance goal'); await until(() => f.handled() === 1, 'handled input');
    await f.session.prompt('Unrelated request'); assert.equal(f.calls(), 1); assert.equal(f.state().status, 'paused'); assert.equal(f.state().autoRequests, 0); assert.deepEqual(f.errors, []);
  });
  await check('abort a running request stops ownership, no automatic retry', async () => {
    const f = await fixture({ script: 'wait' }); await f.command('Work until cancelled'); await until(f.gated, 'provider gate'); await f.command('pause'); f.release(); await f.settle(); assert.equal(f.state().status, 'paused'); assert.equal(f.state().autoRequests, 0); assert.deepEqual(f.errors, []);
  });
  await check('reload active preflight pauses and fences old launch; tombstone survives reload/tree', async () => {
    const f = await fixture({ gate: 'before' }); await f.command('Preserve full result objective'); await until(f.gated, 'preflight gate'); const startEntry = f.manager.getBranch().find(e => e.type === 'custom' && e.customType === stateType);
    await f.session.reload(); f.release(); await f.settle(); assert.equal((await f.get()).goal.status, 'paused'); assert.equal(f.calls(), 0);
    await f.command('clear'); const clearId = f.manager.getLeafId(); await f.session.reload(); assert.equal((await f.get()).goal, null);
    await f.session.navigateTree(startEntry.id, { summarize: false }); assert.equal((await f.get()).goal.status, 'paused');
    await f.session.navigateTree(clearId, { summarize: false }); assert.equal((await f.get()).goal, null);
    assert.ok(f.errors.every(e => /stale|reload/i.test(e)), `unexpected reload errors: ${f.errors}`);
  });
  await check('excluded goal tool never starts and is never implicitly enabled', async () => {
    const f = await fixture({ exclude: true }); await assert.rejects(f.command('Must not start'), /TOOL_DISABLED/); assert.equal(f.calls(), 0); assert.equal(f.state(), undefined); assert.ok(!f.session.getActiveToolNames().includes('goal')); assert.deepEqual(f.errors, []);
  });
  await check('append fault after memory mutation remains disabled across real reload (BUG-003)', async () => {
    const f = await fixture({ gate: 'after' }); await f.command('Persist before claiming completion'); await until(f.gated, 'preflight');
    const original = f.manager.appendCustomEntry.bind(f.manager);
    f.manager.appendCustomEntry = (type, data) => { const id = original(type, data); if (type === stateType && data.goal?.status === 'complete') throw new Error('Injected post-append storage failure'); return id; };
    f.release(); await f.settle(); assert.equal(f.state().status, 'complete', 'tentative manager outcome exists'); assert.equal((await f.get()).goal, null); assert.match((await f.get()).diagnostic, /STORAGE_FAULT/);
    await f.command('pause'); await f.session.reload(); assert.equal((await f.get()).goal, null); await assert.rejects(f.command('resume'), /STORAGE_FAULT/);
    assert.deepEqual(f.errors, []);
  });
  console.log(JSON.stringify({ hostVersion: sdk.VERSION, status: 'passed', cases, noNetwork: true, noPaidModels: true }));
} finally {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { clearInterval(heartbeat); }
}
