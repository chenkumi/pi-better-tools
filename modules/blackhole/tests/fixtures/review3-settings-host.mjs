import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ConfigManager } from '../../src/pi-base/config-manager.ts';
const root = resolve(process.argv[2]), scenario = process.argv[3], home = process.env.PI_CODING_AGENT_DIR;
process.env.REVIEW3_SCENARIO = scenario; process.env.PI_REVIEW3_OBSERVE = '7000';
const cwd = join(home, 'work'), key = Symbol.for('pi-blackhole:review3-probe');
await mkdir(cwd, { recursive: true }); await mkdir(join(cwd, '.pi'), { recursive: true });
await mkdir(join(home, 'pi-blackhole'), { recursive: true }); await writeFile(join(home, 'auth.json'), '{}');
const bhPath = join(home, 'pi-blackhole/pi-blackhole-config.json');
await writeFile(bhPath, scenario === 'no-ui-factory' ? '{ CONFIRMED_INVALID_JSON' : JSON.stringify({ memory: false, compaction: 'off' }));
await writeFile(join(home, 'review3-settings-config.json'), JSON.stringify({ compaction: 'manual', model: { provider: 'global', id: 'global' }, observeAfterTokens: 5000 }));
await writeFile(join(cwd, '.pi/review3-settings-config.json'), JSON.stringify({ observeAfterTokens: 6000 }));
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: home, settingsManager: settings, additionalExtensionPaths: [join(root, 'modules/blackhole/src/index.ts'), join(root, 'modules/blackhole/tests/fixtures/review3-settings-peer.ts')], noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await sdk.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
let streams = 0, fetches = 0;
globalThis.fetch = async () => { fetches++; throw Error('OFFLINE_FETCH_FORBIDDEN'); };
const agent = new Agent({ convertToLlm: sdk.convertToLlm, streamFn() { streams++; return createAssistantMessageEventStream(); } });
const sm = sdk.SessionManager.create(cwd, join(home, 'sessions'));
const user = text => sm.appendMessage({ role: 'user', content: text, timestamp: 1 });
user('Prior settings task'); sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Prior settings answer' }], api: 'openai-responses', provider: 'offline', model: 'fixture', stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const session = new sdk.AgentSession({ agent, cwd, resourceLoader: loader, modelRuntime: runtime, settingsManager: settings, sessionManager: sm, baseToolsOverride: {}, initialActiveToolNames: [] });
const errors = [], notifications = []; let modalStages = 0, actualResetCallbacks = 0, displayedReset, resetRecord;
// Identity-color test UI; real scope/body/confirm components and SDK callbacks.
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, inverse: text => text, bold: text => text, italic: text => text, getFgAnsi: () => '' };
const ui = new Proxy({ notify(text, level) { notifications.push({ text: String(text), level }); } }, { get(target, prop) {
  if (prop === 'theme') return theme;
  if (prop === 'custom') return async factory => new Promise(done => {
    const component = factory({ terminal: { rows: 40, columns: 100 }, requestRender() {} }, theme, {}, done);
    modalStages++;
    if (modalStages === 1) { assert.match(component.render(100).join('\n'), /Configure Session settings/); queueMicrotask(() => component.handleInput('4')); }
    else {
      assert.match(component.render(100).join('\n'), /Review3.*Session/);
      const mount = component.mountOverlay.bind(component), setValues = component.setValues.bind(component), dismiss = component.dismissOverlay.bind(component);
      component.mountOverlay = (overlay, title) => { const text = overlay.render(100).join('\n'); if (text.includes('Really reset Session')) actualResetCallbacks++; else assert.match(text, /Really save to Session/); mount(overlay, title); queueMicrotask(() => overlay.handleInput('y')); };
      component.setValues = values => { displayedReset = structuredClone(values); resetRecord = sm.getLeafId(); setValues(values); };
      component.dismissOverlay = () => { dismiss(); queueMicrotask(() => component.handleInput(scenario === 'reset-ui-save' ? '\u0013' : '\u0003')); };
      queueMicrotask(() => { component.handleInput('\t'); component.handleInput('\t'); component.handleInput('\t'); component.handleInput('\r'); });
    }
  });
  if (['select', 'input', 'editor', 'confirm'].includes(prop)) return async () => undefined;
  return target[prop] ?? (() => undefined);
} });
const append = (type, data) => sm.appendCustomEntry(type, data);
const current = () => session.extensionRunner.createContext();
const namespace = 'session-config-review3-settings';
try {
  await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
  let probe = globalThis[key], cm = probe.cm;
  assert.equal(probe.ctx.hasUI, false); assert.equal(typeof probe.ctx.ui.notify, 'function', 'Installed Pi no-UI notify is callable');
  const baseline = cm.layerValues('env', cwd);
  assert.deepEqual(baseline, { memory: false, compaction: 'manual', observeAfterTokens: 7000, model: { provider: 'global', id: 'global' } });
  const desired = { ...baseline, memory: true, compaction: 'auto', observeAfterTokens: 9000, model: { provider: 'session', id: 'session' } };
  const get = (manager = cm, ctx = current(), persist = append) => manager.resolveHostSession(baseline, ctx, persist);
  if (scenario.startsWith('no-ui-')) {
    const warning = scenario === 'no-ui-direct' ? 'DIRECT_REVIEW3_WARNING' : 'has invalid JSON';
    const delivered = () => [...globalThis[Symbol.for('pi-blackhole:settings-warning-dedup')]].filter(k => k.includes(warning));
    assert.equal(delivered().length, 0, 'Real no-UI no-op must never mark a warning delivered');
    await session.reload(); assert.equal(delivered().length, 0, 'No-UI reload remains retryable');
    await session.bindExtensions({ mode: 'json', uiContext: ui, onError: e => errors.push(e.error) });
    assert.equal(notifications.filter(n => n.text.includes(warning)).length, 1, 'Binding a real available UI delivers the same warning once');
    await session.reload(); assert.equal(notifications.filter(n => n.text.includes(warning)).length, 1, 'Normal reload deduplicates after actual delivery');
    if (scenario === 'no-ui-direct') {
      const opts = { id: 'review3-direct-retry', label: 'Retry', defaults: baseline, fields: () => [], configDir: home, diagnostics: () => ['RETRY_WARNING'] };
      const retry = new ConfigManager(opts); let count = 0;
      retry.resolveHostSession(baseline, { ...current(), hasUI: true, ui: {} }, append);
      retry.resolveHostSession(baseline, { ...current(), hasUI: false, ui: { notify() { count++; } } }, append); assert.equal(count, 0);
      retry.resolveHostSession(baseline, { ...current(), hasUI: true, ui: { notify() { throw Error('NOTIFY_REFUSED'); } } }, append);
      retry.resolveHostSession(baseline, { ...current(), hasUI: true, ui: { notify() { count++; } } }, append);
      new ConfigManager(opts).resolveHostSession(baseline, { ...current(), hasUI: true, ui: { notify() { count++; } } }, append); assert.equal(count, 1);
      const warnings = Array.from({ length: 513 }, (_, i) => ({ scope: 'global', message: `REVIEW3_CAP_${i}` })); let caps = 0;
      retry.notifyWarnings({ config: baseline, warnings }, () => caps++); retry.notifyWarnings({ config: baseline, warnings: [warnings[0]] }, () => caps++); assert.equal(caps, 514); assert.equal(retry._notifiedWarnings.size, 512);
      const other = sdk.SessionManager.create(join(home, 'other-cwd'), join(home, 'other-sessions'));
      retry.resolveHostSession(baseline, { ...current(), cwd: other.getCwd(), sessionManager: other, hasUI: true, ui: { notify() { count++; } } }, (t, d) => other.appendCustomEntry(t, d)); assert.equal(count, 2, 'Cwd/owner diagnostics are independent');
    }
  } else if (scenario === 'pending-reset') {
    const empty = sdk.SessionManager.create(cwd, join(home, 'empty-sessions')), pending = probe.make(); let deny = false, appends = 0;
    const persist = (t, d) => { if (deny) throw Error('RESET_APPEND_REFUSED'); appends++; empty.appendCustomEntry(t, d); };
    const context = { ...current(), sessionManager: empty };
    pending.resolveHostSession(baseline, context, persist); pending.save(desired, 'session', cwd);
    assert.deepEqual(pending.resolveHostSession(baseline, context, persist), desired);
    pending.resetScope('session', cwd); assert.deepEqual(pending.resolveHostSession(baseline, context, persist), baseline); assert.equal(appends, 0, 'Pure pending reset does not append');
    pending.save(desired, 'session', cwd);
    const other = sdk.SessionManager.create(cwd, join(home, 'other-empty'));
    pending.resolveHostSession(baseline, { ...context, sessionManager: other }, (t, d) => other.appendCustomEntry(t, d)); pending.resetScope('session', cwd);
    assert.deepEqual(pending.resolveHostSession(baseline, context, persist), desired, 'Another owner reset cannot clear genuine pending');
    empty.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Materialized empty owner' }], api: 'openai-responses', provider: 'offline', model: 'fixture', stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const bytes = await readFile(empty.getSessionFile(), 'utf8'); deny = true;
    assert.throws(() => pending.resetScope('session', cwd), /RESET_APPEND_REFUSED/);
    assert.deepEqual(probe.readPending(empty), desired, 'Reset append refusal preserves genuine pending');
    assert.equal(await readFile(empty.getSessionFile(), 'utf8'), bytes);
    deny = false; pending.resetScope('session', cwd);
    assert.deepEqual(pending.resolveHostSession(baseline, context, persist), baseline); assert.equal(appends, 1);
    assert.deepEqual(empty.getBranch().at(-1).data.config, {}); assert.ok((await readFile(empty.getSessionFile(), 'utf8')).startsWith(bytes));
  } else {
    cm.save({ ...desired, compactAfterPreset: 'default', midRunCompaction: 'off', tailBehavior: 'minimal', retainedToolOutputMaxTokens: 20000, compactAfterTokens: 81000, compactAfterRatio: 0.5, compactReserveTokens: 100 }, 'session', cwd);
    const c = sm.getLeafId(); assert.deepEqual(get(), desired);
    assert.deepEqual(sm.getBranch().at(-1).data.config, desired, 'Actual canonical session save excludes seven ignored controls');
    const bytes = await readFile(sm.getSessionFile(), 'utf8');
    if (scenario.startsWith('reset-ui')) {
      await session.bindExtensions({ mode: 'json', uiContext: ui, onError: e => errors.push(e.error) });
      await session.prompt('/review3-reset'); assert.equal(actualResetCallbacks, 1); assert.equal(modalStages, 2); assert.deepEqual(displayedReset, baseline, 'Real config-flow Reset refreshes exact lower layers');
    } else if (scenario === 'delete-session') cm.deleteScope('session', cwd);
    else {
      const refusing = () => { throw Error('RESET_APPEND_REFUSED'); };
      cm.resolveHostSession(baseline, current(), refusing);
      assert.throws(() => cm.resetScope('session', cwd), /RESET_APPEND_REFUSED/); assert.deepEqual(get(), desired); assert.equal(await readFile(sm.getSessionFile(), 'utf8'), bytes);
      cm.resolveHostSession(baseline, current(), () => {});
      assert.throws(() => cm.resetScope('session', cwd), /append not verified/); assert.deepEqual(get(), desired); assert.equal(await readFile(sm.getSessionFile(), 'utf8'), bytes);
      const failing = new Proxy(sm, { get(target, prop) { if (prop === 'getBranch') return () => { throw Error('LOOKUP_REFUSED'); }; const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value; } });
      cm.resolveHostSession(baseline, { ...current(), sessionManager: failing }, append);
      assert.throws(() => cm.resetScope('session', cwd), /not initialized|unavailable/); assert.equal(await readFile(sm.getSessionFile(), 'utf8'), bytes);
      get(); cm.resetScope('session', cwd);
    }
    if (scenario === 'reset-ui-save') { assert.deepEqual(get(), baseline, 'Save after actual Reset must not restore stale nonempty modal values'); assert.deepEqual(sm.getBranch().at(-1).data.config, baseline); }
    const reset = resetRecord ?? sm.getLeafId(); assert.notEqual(reset, c, 'Reset must append an actual record, not mask the selected old record');
    const record = sm.getBranch().find(e => e.id === reset); assert.equal(record.type, 'custom'); assert.equal(record.customType, namespace); assert.deepEqual(record.data, { leafId: c, config: {} });
    assert.deepEqual(get(), baseline); assert.deepEqual(cm.layerValues('session', cwd), baseline); assert.deepEqual(cm.inspect(cwd).layers.session, scenario === 'reset-ui-save' ? baseline : {});
    assert.ok((await readFile(sm.getSessionFile(), 'utf8')).startsWith(bytes), 'Reset does not rewrite original JSONL prefix');
    await session.reload(); probe = globalThis[key]; cm = probe.cm; assert.deepEqual(get(), baseline); assert.deepEqual(get(probe.make()), baseline);
    await session.navigateTree(c, { summarize: false }); assert.deepEqual(get(), desired, 'Navigating back C restores old override');
    await session.navigateTree(reset, { summarize: false }); assert.deepEqual(get(), baseline, 'Returning reset-record revokes again');
  }
  assert.deepEqual(errors, []); assert.equal(streams, 0); assert.equal(fetches, 0);
  console.log(JSON.stringify({ scenario, settingsContract: true, actualResetCallbacks, modelStreamCalls: streams, actualExternalFetchCalls: fetches, hasUIContract: true }));
} finally { session.dispose(); }
