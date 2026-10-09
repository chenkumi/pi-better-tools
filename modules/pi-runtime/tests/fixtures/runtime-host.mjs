import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const host = process.env.PI_BETTER_TOOLS_HOST;
const sdk = await import(host ? pathToFileURL(join(host, 'dist/index.js')).href : '@earendil-works/pi-coding-agent');
const { createAssistantMessageEventStream } = await import(host ? pathToFileURL(join(host, '../pi-ai/dist/compat.js')).href : '@earendil-works/pi-ai/compat');
assert.equal(sdk.VERSION, '1.1.0');
const agentDir = process.env.PI_CODING_AGENT_DIR, cwd = join(agentDir, 'workspace');
await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
globalThis.fetch = async () => { throw new Error('Network forbidden in runtime recovery fixture'); };
sdk.initTheme('dark', false);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { ...modelRuntime.getModels()[0], id: 'local', provider: 'offline-runtime', api: 'openai-responses' };
const heartbeat = setInterval(() => console.error('[pi-runtime] Offline host verification still running...'), 10000);
const results = [];
const text = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const state = manager => manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-runtime-state').at(-1)?.data;
const feedbacks = manager => manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'pi-runtime-recovery');
let session, interactive;
// Supported SDK UI integration: real InteractiveMode + injected offline Terminal.
// No fabricated confirm:true and no RPC context relabelled as TUI. The genuine
// ExtensionSelectorComponent receives keyboard input at the dialog-open barrier.
function createOfflineTui(session, onDialog) {
  let ui;
  const terminal = { columns: 100, rows: 30, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    setProgramStatus(status) {
      if (status.state === 'blocked' && status.kind === 'permission') queueMicrotask(() => {
        assert.ok(ui.extensionSelector, 'real host confirmation selector is mounted');
        assert.ok(ui.extensionSelector.render(100).some(line => line.includes('Review bounded API-error recovery?')));
        onDialog(ui.extensionSelector);
      });
    },
  };
  const runtimeHost = new sdk.AgentSessionRuntime(session, {}, async () => { throw new Error('Session replacement forbidden in offline TUI fixture'); });
  ui = new sdk.InteractiveMode(runtimeHost, { terminal, tuiMode: 'regular' });
  return ui;
}
try {
  for (const mode of ['success', 'limit', 'repeat', 'transform', 'template', 'policy', 'cancel', 'reload', 'no-session', 'tree', 'handled', 'preflight', 'withdrawn', 'safety']) {
    let calls = 0, approval = false, confirmations = 0, dialogAction, dialogWork;
    const checks = [];
    const contexts = [], errors = [];
    let manager = mode === 'no-session' ? sdk.SessionManager.inMemory(cwd) : sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
    const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
    const syntheticStream = (m, context) => {
      calls++; contexts.push(structuredClone(context.messages));
      if (mode === 'policy' && calls === 2) {
        assert.equal(state(manager).used, 1, 'reservation exists before the approved model request');
        assert.equal(state(manager).pending, null);
        const branch = manager.getBranch();
        const reservation = branch.findIndex(e => e.type === 'custom' && e.customType === 'pi-runtime-state' && e.data.used === 1);
        const submitted = branch.findIndex(e => e.type === 'custom_message' && e.customType === 'pi-runtime-recovery');
        assert.ok(reservation >= 0 && submitted > reservation, 'reservation precedes host-persisted feedback');
      }
      let errorMessage;
      if (mode === 'safety') errorMessage = 'invalid_request_error: rejected by our safety system; policy refusal: invalid tool arguments. ' + JSON.stringify({ api_key: 'PREFIX"PRIVATE_SUFFIX', access_token: 'PREFIX\\"TOKEN_SUFFIX', authorization: 'Bearer PREFIX"AUTH_SUFFIX' });
      else if (mode === 'policy' && calls === 1) errorMessage = 'cyber_policy: This content was flagged for possible cybersecurity risk.';
      else if (mode === 'repeat' || (mode === 'reload' && calls <= 2)) errorMessage = 'invalid_request_error: repeated invalid argument';
      else if (['limit', 'tree', 'handled', 'preflight', 'withdrawn', 'transform', 'template'].includes(mode) || mode === 'cancel' || mode === 'no-session' || (mode === 'reload' && calls <= 4) || (mode === 'success' && calls === 1)) errorMessage = `invalid_request_error: invalid argument ${calls}`;
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
        content: errorMessage ? [] : [{ type: 'text', text: 'RECOVERED' }], stopReason: errorMessage ? 'error' : 'stop', ...(errorMessage ? { errorMessage } : {}),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push(errorMessage ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    };
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      additionalExtensionPaths: [join(root, 'modules/pi-runtime/src/index.ts')], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      promptsOverride: current => ({ prompts: [...current.prompts, { name: 'owned-review', description: 'Offline review', filePath: join(cwd, 'owned-review.md'), sourceInfo: sdk.createSyntheticSourceInfo(join(cwd, 'owned-review.md'), { source: 'sdk' }), content: 'Expanded owned read-only review of $1' }], diagnostics: current.diagnostics }),
      extensionFactories: [pi => {
        if (mode === 'transform') pi.on('input', event => event.text === 'Transform new task' ? { action: 'transform', text: 'Transformed owned read-only review' } : undefined);
        pi.registerProvider(model.provider, { api: model.api, apiKey: 'offline-non-secret', baseUrl: 'https://unused.invalid', models: [model, { ...model, id: 'local-other' }], streamSimple: syntheticStream });
        if (mode === 'handled') pi.on('input', event => event.text === 'Handled by later extension' ? { action: 'handled' } : undefined);
        if (mode === 'preflight') pi.on('before_agent_start', event => { if (event.prompt === 'Preflight rejection') event.systemPromptOptions.selectedTools = null; });
        if (mode === 'withdrawn') pi.on('agent_before_settle', event => ({ entries: event.entries.filter(e => e.customType !== 'pi-runtime-recovery'), continue: false }));
        if (mode === 'cancel') pi.on('turn_end', (event, ctx) => { if (event.message.stopReason === 'error') ctx.abort(); });
      }],
    });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const create = async () => {
      const result = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager: settings, resourceLoader: loader, sessionManager: manager, noTools: 'all' });
      session = result.session;
      await session.bindExtensions({ mode: 'json', onError: event => errors.push(event.error) });
    };
    await create();
    await session.prompt('Test an owned local application with a read-only authorized objective.');
    assert.equal(session.getActiveToolNames().length, 0, 'the module must not activate tools');
    if (mode === 'success') {
      assert.equal(calls, 2); assert.equal(feedbacks(manager).length, 1); assert.equal(state(manager).used, 1);
      assert.ok(contexts[1].some(m => text(m).includes('Runtime API-error recovery.')));
      assert.match(session.getLastAssistantText(), /RECOVERED/);
    } else if (mode === 'limit') {
      assert.equal(calls, 3); assert.equal(feedbacks(manager).length, 2); assert.equal(state(manager).used, 2);
    } else if (mode === 'repeat') {
      assert.equal(calls, 2); assert.equal(feedbacks(manager).length, 1); assert.equal(state(manager).used, 1);
    } else if (mode === 'transform' || mode === 'template') {
      assert.equal(calls, 3); assert.equal(state(manager).used, 2); const taskId = state(manager).taskId;
      const admission = [];
      const unsubscribe = session.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'user') admission.push(event.message); });
      await session.prompt(mode === 'transform' ? 'Transform new task' : '/owned-review application'); unsubscribe();
      assert.equal(admission.length, 1);
      assert.equal(text(admission[0]), mode === 'transform' ? 'Transformed owned read-only review' : 'Expanded owned read-only review of application');
      const admittedEntry = manager.getBranch().find(e => e.type === 'message' && e.message === admission[0]);
      assert.ok(admittedEntry, 'admitted user object is persisted by the real host');
      assert.notEqual(state(manager).taskId, taskId, 'actual transformed/template user admission creates a new task');
      assert.equal(calls, 6, 'new admitted task must receive its own two-recovery budget'); assert.equal(state(manager).used, 2);
    } else if (mode === 'policy') {
      assert.equal(calls, 1); assert.equal(feedbacks(manager).length, 0); assert.equal(state(manager).used, 0);
      const rpcNotices = [];
      session.extensionRunner.setUIContext({ ...session.extensionRunner.getUIContext(), confirm: async () => { confirmations++; return true; }, notify: message => rpcNotices.push(message) }, 'rpc');
      await session.prompt('/runtime-recover Testing my own local application; read-only authorized scope.');
      await session.waitForIdle();
      assert.equal(calls, 1, 'idle RPC must refuse even an approving client'); assert.equal(confirmations, 0);
      assert.equal(state(manager).used, 0); assert.equal(feedbacks(manager).length, 0);
      assert.match(rpcNotices.join('\n'), /idle TUI.*RPC\/JSON\/print are unsupported/);
      checks.push('idle-RPC-refused-with-zero-dialogs');
      interactive = createOfflineTui(session, selector => {
        dialogWork = (async () => {
          confirmations++;
          if (dialogAction) await dialogAction(selector);
          else selector.handleInput(approval ? '\r' : '\x1b');
        })();
      });
      await session.bindExtensions({ mode: 'tui', uiContext: interactive.createExtensionUIContext(), onError: event => errors.push(event.error) });
      await session.prompt('/runtime-recover Testing my own local application; read-only authorized scope.');
      await session.waitForIdle(); assert.equal(calls, 1, 'TUI cancel must not resume'); assert.equal(state(manager).used, 0);
      checks.push('real-TUI-escape-denied');
      dialogAction = async selector => {
        await session.setModel(modelRuntime.getModel(model.provider, 'local-other'));
        await session.setModel(modelRuntime.getModel(model.provider, model.id));
        assert.equal(interactive.extensionSelector, undefined, 'model change aborts mounted approval UI');
        selector.handleInput('\r'); // a stale UI response cannot approve
      };
      await session.prompt('/runtime-recover Testing my own local application; read-only authorized scope.');
      await dialogWork; await session.waitForIdle(); assert.equal(calls, 1); assert.equal(state(manager).used, 0); assert.equal(confirmations, 2);
      checks.push('real-TUI-model-roundtrip-revokes-late-approval');
      dialogAction = async selector => {
        const leaf = manager.getLeafId();
        const user = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'user');
        await session.navigateTree(user.id, { summarize: false });
        await session.navigateTree(leaf, { summarize: false });
        assert.equal(interactive.extensionSelector, undefined, 'tree change aborts mounted approval UI');
        selector.handleInput('\r');
      };
      await session.prompt('/runtime-recover Testing my own local application; read-only authorized scope.');
      await dialogWork; await session.waitForIdle(); assert.equal(calls, 1); assert.equal(state(manager).used, 0); assert.equal(confirmations, 3);
      checks.push('real-TUI-tree-roundtrip-revokes-late-approval');
      dialogAction = undefined; approval = true;
      await session.prompt('/runtime-recover Testing my own local application; read-only authorized scope.');
      await session.waitForIdle();
      assert.equal(calls, 2); assert.equal(confirmations, 4); assert.equal(feedbacks(manager).length, 1); assert.equal(state(manager).used, 1);
      checks.push('real-TUI-enter-approved-second-model-call', 'reservation-persisted-before-feedback-and-request');
      assert.match(feedbacks(manager)[0].content, /Do not.*evad/i);
    } else if (mode === 'cancel') {
      assert.equal(calls, 1); assert.equal(feedbacks(manager).length, 0); assert.equal(state(manager).used, 0);
    } else if (mode === 'no-session') {
      assert.equal(calls, 1); assert.equal(feedbacks(manager).length, 0); assert.equal(state(manager), undefined);
    } else if (mode === 'safety') {
      assert.equal(calls, 1); assert.equal(state(manager).used, 0); assert.equal(feedbacks(manager).length, 0);
      assert.equal(state(manager).pending.kind, 'policy');
      assert.doesNotMatch(state(manager).pending.message, /PREFIX|PRIVATE_SUFFIX|TOKEN_SUFFIX|AUTH_SUFFIX/);
      const saved = (await readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.doesNotMatch(JSON.stringify(saved.filter(e => e.customType === 'pi-runtime-state')), /PREFIX|PRIVATE_SUFFIX|TOKEN_SUFFIX|AUTH_SUFFIX/);
      assert.ok(saved.some(e => e.type === 'message' && e.message.errorMessage?.includes('PRIVATE_SUFFIX')), 'native original failure is not rewritten');
      checks.push('mixed-policy-refusal-never-auto-continued', 'escaped-JSON-credentials-masked-in-persisted-diagnostics');
    } else if (mode === 'withdrawn') {
      assert.equal(calls, 1); assert.equal(state(manager).used, 1); assert.equal(feedbacks(manager).length, 0);
      await session.sendCustomMessage({ customType: 'offline-continuation', content: 'Continue diagnostic review', display: false }, { triggerTurn: true });
      await session.waitForIdle(); assert.equal(calls, 2); assert.equal(state(manager).used, 2);
      await session.sendCustomMessage({ customType: 'offline-continuation', content: 'Continue diagnostic review', display: false }, { triggerTurn: true });
      await session.waitForIdle(); assert.equal(calls, 3); assert.equal(state(manager).used, 2);
    } else if (['tree', 'handled', 'preflight'].includes(mode)) {
      assert.equal(calls, 3); const taskId = state(manager).taskId;
      if (mode === 'tree') {
        const original = manager.getBranch().find(e => e.type === 'custom' && e.customType === 'pi-runtime-state' && e.data.used === 0);
        await session.navigateTree(original.id, { summarize: false });
        session.dispose(); session = undefined; manager = sdk.SessionManager.open(manager.getSessionFile()); await loader.reload(); await create();
        await session.prompt('Internal continuation after navigation', { source: 'extension' });
      } else {
        if (mode === 'handled') await session.prompt('Handled by later extension');
        else { await assert.rejects(session.prompt('Preflight rejection'), TypeError); assert.equal(calls, 3); assert.equal(session.isIdle, true); errors.length = 0; }
        await session.sendCustomMessage({ customType: 'offline-continuation', content: 'Continue diagnostic review', display: false }, { triggerTurn: true });
        await session.waitForIdle();
      }
      assert.equal(calls, 4); assert.equal(state(manager).taskId, taskId); assert.equal(state(manager).used, 2);
    } else {
      assert.equal(calls, 2); const taskId = state(manager).taskId, file = manager.getSessionFile();
      session.dispose(); session = undefined; manager = sdk.SessionManager.open(file); await loader.reload(); await create();
      await session.prompt('Internal continuation, not a new user task.', { source: 'extension' });
      assert.equal(calls, 4); assert.equal(state(manager).taskId, taskId); assert.equal(state(manager).used, 2); assert.equal(feedbacks(manager).length, 2);
      await session.prompt('A new actual user task.'); assert.equal(calls, 5); assert.notEqual(state(manager).taskId, taskId); assert.equal(state(manager).used, 0);
    }
    const rawErrors = manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.stopReason === 'error');
    assert.ok(rawErrors.length > 0, 'original failed responses remain in native history');
    assert.deepEqual(errors, []);
    if (mode !== 'no-session') {
      const stored = (await readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(stored.filter(e => e.type === 'custom_message' && e.customType === 'pi-runtime-recovery').length, feedbacks(manager).length);
      assert.match(state(manager).taskId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    results.push({ mode, status: 'passed', fixtureModelCalls: calls, recoveries: feedbacks(manager).length, ...(checks.length ? { checks } : {}) });
    interactive?.stop(); interactive = undefined;
    session.dispose(); session = undefined;
  }
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')), {});
  console.log(JSON.stringify({ status: 'passed', host: sdk.VERSION, providerCalls: 0, cases: results }));
} finally { interactive?.stop(); session?.dispose(); await modelRuntime.dispose?.(); clearInterval(heartbeat); }
