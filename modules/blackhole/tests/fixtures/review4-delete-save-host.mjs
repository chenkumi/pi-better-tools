import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ConfigManager } from '../../src/pi-base/config-manager.ts';
import { setProjectTrustForTests } from '../../src/core/project-trust.ts';
import { canonicalPersistedSettings, IGNORED_CONTROL_KEYS } from '../../src/core/pi-owned-settings.ts';

const root = resolve(process.argv[2]), scenario = process.argv[3], home = process.env.PI_CODING_AGENT_DIR;
const [scope, action] = scenario.split(':');
assert.ok(['global', 'project'].includes(scope));
const cwd = join(home, 'work'), filename = 'review4-delete-save-config.json';
await mkdir(join(cwd, '.pi'), { recursive: true });
setProjectTrustForTests(cwd, true); // Project scope is exercised as a trusted project (D01).
await mkdir(join(home, 'pi-blackhole'), { recursive: true });
await writeFile(join(home, 'auth.json'), '{}');
await writeFile(join(home, 'pi-blackhole/pi-blackhole-config.json'), JSON.stringify({ memory: false, compaction: 'off' }));
const defaults = { memory: true, debug: false, observeAfterTokens: 4000, profileLabel: 'default-profile', model: { provider: 'default', id: 'default' } };
const lowerGlobal = { memory: false, debug: false, observeAfterTokens: 5000, profileLabel: 'lower-global-profile', model: { provider: 'lower', id: 'global' } };
const ignored = { compactAfterPreset: 'default', compactAfterTokens: 81000, compactAfterRatio: 0.5, compactReserveTokens: 100, midRunCompaction: 'off', tailBehavior: 'minimal', retainedToolOutputMaxTokens: 20000 };
const targetValues = { memory: scope === 'project', debug: true, observeAfterTokens: 9000, profileLabel: 'stale-scope-profile', model: { provider: 'stale', id: scope }, ...ignored, deletedUnknown: 'OLD_SCOPE_ONLY' };
const globalPath = join(home, filename), projectPath = join(cwd, '.pi', filename), targetPath = scope === 'global' ? globalPath : projectPath;
await writeFile(globalPath, JSON.stringify(scope === 'global' ? targetValues : lowerGlobal));
if (scope === 'project') await writeFile(projectPath, JSON.stringify(targetValues));
const beforeBytes = await readFile(targetPath, 'utf8'), lowerGlobalBytes = await readFile(globalPath, 'utf8');
const defaultsOptions = {
  id: 'review4-delete-save', label: 'Review4', configDir: home, defaults,
  canonicalizePersisted: canonicalPersistedSettings,
  fields: values => [
    { key: 'memory', type: 'boolean', label: 'Memory', value: values.memory },
    { key: 'debug', type: 'boolean', label: 'Debug', value: values.debug },
    { key: 'observeAfterTokens', type: 'number', label: 'Observe', value: values.observeAfterTokens },
    { key: 'profileLabel', type: 'readonly', label: 'Profile', value: values.profileLabel },
  ],
};
const cm = new ConfigManager(defaultsOptions), lower = scope === 'global' ? defaults : { ...defaults, ...lowerGlobal };
const initial = cm.layerValues(scope, cwd), afterEdited = { ...initial, debug: false };
assert.equal(initial.memory, targetValues.memory); assert.notEqual(initial.memory, lower.memory);
const savePayloads = [], onSaved = [], errors = [], notifications = [], refreshes = [], changes = [];
const save = cm.save.bind(cm), deleteScope = cm.deleteScope.bind(cm);
let deleteCalls = 0, deleteSettled, saveFailed, stages = 0, actualConfirms = 0, dismisses = 0, component, frameBefore;
const deleted = new Promise(resolve => { deleteSettled = resolve; });
const failedSave = new Promise(resolve => { saveFailed = resolve; });
cm.save = (values, selected, ...args) => { assert.equal(selected, scope); savePayloads.push(structuredClone(values)); return save(values, selected, ...args); };
cm.deleteScope = async (...args) => { deleteCalls++; if (action === 'refusal') throw Error('DELETE_CALLBACK_REFUSED'); return deleteScope(...args); };
const originalRm = fs.rmSync, originalWrite = fs.writeFileSync;
let unlinkDenied = action === 'unlink-fault', writeDenied = action === 'write-fault', unlinkAttempts = 0, writeAttempts = 0;
fs.rmSync = (path, ...args) => { if (unlinkDenied && resolve(String(path)) === targetPath) { unlinkAttempts++; throw Object.assign(Error('DELETE_UNLINK_EROFS'), { code: 'EROFS' }); } return originalRm(path, ...args); };
fs.writeFileSync = (path, ...args) => { if (writeDenied && resolve(String(path)) === targetPath) { writeAttempts++; throw Object.assign(Error('SAVE_WRITE_EROFS'), { code: 'EROFS' }); } return originalWrite(path, ...args); };
syncBuiltinESMExports();
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, inverse: text => text, bold: text => text, italic: text => text, getFgAnsi: () => '' };
const render = () => component.render(160).join('\n');
const assertRows = (values, dirty) => {
  const frame = render();
  for (const field of ['memory', 'debug']) {
    const line = frame.split('\n').find(line => line.includes(field === 'memory' ? 'Memory' : 'Debug'));
    assert.ok(line?.includes(values[field] ? '[✓] on' : '[ ] off'), `Actual ${field} row matches expected value`);
  }
  assert.ok(frame.includes(String(values.observeAfterTokens))); assert.ok(frame.includes(values.profileLabel));
  assert.equal(frame.includes('● Unsaved'), dirty, 'Actual body dirty indicator matches expected state');
};
let rawDismiss;
const ui = new Proxy({ notify(text, level) {
  notifications.push({ text: String(text), level });
  if (level === 'error') { deleteSettled('error'); saveFailed('error'); }
} }, { get(target, prop) {
  if (prop === 'theme') return theme;
  if (prop === 'custom') return async factory => new Promise(done => {
    const body = factory({ terminal: { rows: 55, columns: 160 }, requestRender() {} }, theme, {}, done);
    stages++;
    if (stages === 1) {
      assert.match(body.render(160).join('\n'), /Configure Global settings/);
      queueMicrotask(() => body.handleInput(scope === 'global' ? '2' : '3')); return;
    }
    component = body; assert.match(render(), scope === 'global' ? /Review4.*Global/ : /Review4.*Project Local/);
    const mount = component.mountOverlay.bind(component), set = component.setValues.bind(component);
    rawDismiss = component.dismissOverlay.bind(component);
    component.setValues = values => { refreshes.push(structuredClone(values)); set(values); };
    component.dismissOverlay = () => { dismisses++; rawDismiss(); deleteSettled('dismiss'); };
    component.mountOverlay = (overlay, title) => {
      const text = overlay.render(160).join('\n');
      assert.match(text, /Really delete the .*config file|Really save to /); actualConfirms++;
      mount(overlay, title); queueMicrotask(() => overlay.handleInput(text.includes('Really delete') && ['cancel', 'write-fault'].includes(action) ? 'n' : 'y'));
    };
    queueMicrotask(() => {
      assertRows(initial, false);
      if (['cancel', 'refusal', 'unlink-fault', 'write-fault'].includes(action)) {
        component.handleInput('\u001b[B'); component.handleInput('\r'); assertRows(afterEdited, true);
      }
      for (let i = 0; i < 4; i++) component.handleInput('\t');
      frameBefore = render(); component.handleInput('\r');
    });
  });
  if (['select', 'input', 'editor', 'confirm'].includes(prop)) return async () => undefined;
  return target[prop] ?? (() => undefined);
} });
sdk.initTheme('dark', false);
const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: home, settingsManager: settings, additionalExtensionPaths: [join(root, 'modules/blackhole/src/index.ts')], noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await sdk.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
let streams = 0, fetches = 0;
globalThis.fetch = async () => { fetches++; throw Error('OFFLINE_FETCH_FORBIDDEN'); };
const agent = new Agent({ convertToLlm: sdk.convertToLlm, streamFn() { streams++; return createAssistantMessageEventStream(); } });
const sm = sdk.SessionManager.create(cwd, join(home, 'sessions'));
sm.appendMessage({ role: 'user', content: 'Isolated settings task', timestamp: 1 });
const session = new sdk.AgentSession({ agent, cwd, resourceLoader: loader, modelRuntime: runtime, settingsManager: settings, sessionManager: sm, baseToolsOverride: {}, initialActiveToolNames: [] });
try {
  await session.bindExtensions({ mode: 'json', uiContext: ui, onError: e => errors.push(e.error) });
  const ctx = session.extensionRunner.createContext(); assert.equal(ctx.hasUI, true);
  const pending = cm.openSettings(ctx, cwd, values => onSaved.push(structuredClone(values)), home, (key, value) => changes.push({ key, value }));
  const result = await deleted;
  let expected;
  if (['save', 'edit-save'].includes(action)) {
    assert.equal(result, 'dismiss'); assert.equal(deleteCalls, 1); assert.equal(fs.existsSync(targetPath), false);
    assert.deepEqual(refreshes, [lower]); assert.deepEqual(cm.layerValues(scope, cwd), lower); assert.deepEqual(cm.inspect(cwd).layers[scope], {});
    assertRows(lower, false);
    const memoryRow = render().split('\n').find(line => line.includes('Memory'));
    assert.ok(memoryRow.includes(scope === 'global' ? '(from default)' : '(from Global)'), 'Actual inspection notes refresh with the displayed lower layer');
    expected = structuredClone(lower);
    if (action === 'edit-save') { component.handleInput('\u001b[B'); component.handleInput('\r'); expected.debug = !lower.debug; assertRows(expected, true); }
  } else {
    assert.equal(await readFile(targetPath, 'utf8'), beforeBytes, 'Refused/cancelled/failed Delete preserves exact bytes');
    assert.equal(refreshes.length, 0, 'Failed Delete must not refresh or clear actual dirty edits');
    assert.equal(deleteCalls, ['cancel', 'write-fault'].includes(action) ? 0 : 1);
    if (action === 'refusal' || action === 'unlink-fault') { assert.equal(result, 'error'); assert.equal(dismisses, 0); rawDismiss(); }
    assert.equal(render(), frameBefore, 'Actual display and dirty values remain unchanged after unsuccessful Delete');
    assertRows(afterEdited, true); expected = afterEdited;
    assert.deepEqual(cm.layerValues(scope, cwd), initial); assert.deepEqual(cm.inspect(cwd).layers[scope], targetValues);
    if (action === 'unlink-fault') assert.equal(unlinkAttempts, 1);
  }
  unlinkDenied = false;
  component.handleInput('\u0013');
  if (action === 'write-fault') {
    await failedSave; assert.equal(writeAttempts, 1); assert.equal(await readFile(targetPath, 'utf8'), beforeBytes);
    rawDismiss(); assertRows(expected, true); assert.deepEqual(savePayloads, [expected]); assert.deepEqual(onSaved, []);
    writeDenied = false; component.handleInput('\u0013');
  }
  await pending;
  assert.deepEqual(savePayloads, action === 'write-fault' ? [expected, expected] : [expected], 'Real save receives the exact displayed current buffer, including untouched fields');
  assert.deepEqual(onSaved, [expected]);
  const saved = JSON.parse(await readFile(targetPath, 'utf8'));
  assert.deepEqual(saved, canonicalPersistedSettings(expected), 'New/updated JSON exactly matches displayed buffer after explicit canonical Save');
  for (const key of IGNORED_CONTROL_KEYS) assert.equal(Object.hasOwn(saved, key), false);
  assert.deepEqual(new ConfigManager(defaultsOptions).layerValues(scope, cwd), canonicalPersistedSettings(expected));
  await session.reload(); assert.deepEqual(new ConfigManager(defaultsOptions).layerValues(scope, cwd), canonicalPersistedSettings(expected));
  assert.equal(stages, 2); assert.equal(actualConfirms, action === 'write-fault' ? 3 : 2);
  assert.deepEqual(errors, []); assert.equal(streams, 0); assert.equal(fetches, 0);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')), {});
  if (scope === 'project') assert.equal(await readFile(globalPath, 'utf8'), lowerGlobalBytes, 'Project operations preserve exact global lower-layer bytes');
  console.log(JSON.stringify({ scenario, deleteSaveContract: true, actualConfirms, deleteCalls, unlinkAttempts, writeAttempts, dirtyFailurePreserved: !['save', 'edit-save'].includes(action), modelStreamCalls: streams, actualExternalFetchCalls: fetches }));
} finally { unlinkDenied = writeDenied = false; fs.rmSync = originalRm; fs.writeFileSync = originalWrite; syncBuiltinESMExports(); session.dispose(); }
