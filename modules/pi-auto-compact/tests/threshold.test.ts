import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { compactionThreshold, DEFAULT_RESERVE_TOKENS, resolveCompactionBudget } from '../src/checkpoint/threshold.ts';

const MODEL = { provider: 'vendor', id: 'model-1' };
const KEY = 'vendor/model-1';

/** What Pi itself decides for `manager` and `model`: its resolved settings, or the error it throws for an invalid value. */
const piBudget = (manager: SettingsManager, model: typeof MODEL | undefined) => {
  try { const { enabled, reserveTokens } = manager.getCompactionSettings(model); return { enabled: Boolean(enabled), reserveTokens }; }
  catch { return undefined; }
};
/** What this module decides from the same manager, through the settings an extension sees (`pi.getSettings()`). */
const ourBudget = (manager: SettingsManager, model: typeof MODEL | undefined) => resolveCompactionBudget(manager.getSettings(), model);

const settingsCases: Array<[string, Record<string, unknown>]> = [
  ['no compaction settings', {}],
  ['ordinary reserveTokens', { compaction: { reserveTokens: 5000 } }],
  ['zero is valid', { compaction: { reserveTokens: 0 } }],
  ['a model override wins over the ordinary value', { compaction: { reserveTokens: 5000, modelOverrides: { [KEY]: { reserveTokens: 7000 } } } }],
  ['an override of another model is ignored', { compaction: { reserveTokens: 5000, modelOverrides: { 'vendor/other': { reserveTokens: 7000 } } } }],
  ['an override of keepRecentTokens only falls back to the ordinary value', { compaction: { reserveTokens: 5000, modelOverrides: { [KEY]: { keepRecentTokens: 100 } } } }],
  ['an override without any ordinary value', { compaction: { modelOverrides: { [KEY]: { reserveTokens: 7000 } } } }],
  ['an override of zero', { compaction: { reserveTokens: 5000, modelOverrides: { [KEY]: { reserveTokens: 0 } } } }],
  ['compaction disabled', { compaction: { enabled: false } }],
  ['compaction explicitly enabled', { compaction: { enabled: true, reserveTokens: 3000 } }],
  ['a falsy non-boolean enabled', { compaction: { enabled: 0 } }],
  ['a truthy non-boolean enabled', { compaction: { enabled: 'no' } }],
  ['a negative ordinary value', { compaction: { reserveTokens: -1 } }],
  ['a fractional ordinary value', { compaction: { reserveTokens: 1.5 } }],
  ['a string ordinary value', { compaction: { reserveTokens: '100' } }],
  ['an unsafe integer ordinary value', { compaction: { reserveTokens: 2 ** 60 } }],
  ['a null ordinary value', { compaction: { reserveTokens: null } }],
  ['an invalid ordinary value is an error even when the override is valid', { compaction: { reserveTokens: -5, modelOverrides: { [KEY]: { reserveTokens: 7000 } } } }],
  ['an invalid override is an error even when the ordinary value is valid', { compaction: { reserveTokens: 5000, modelOverrides: { [KEY]: { reserveTokens: 1.5 } } } }],
  ['a number as the model entry', { compaction: { modelOverrides: { [KEY]: 5 } } }],
  ['an array as the model entry', { compaction: { modelOverrides: { [KEY]: [] } } }],
  ['null as the model entry', { compaction: { modelOverrides: { [KEY]: null } } }],
  ['a string as compaction', { compaction: 'on' }],
  ['a number as compaction', { compaction: 5 }],
  ['an array as compaction', { compaction: [] }],
  ['a string as modelOverrides', { compaction: { modelOverrides: 'x' } }],
];

for (const [title, settings] of settingsCases) test(`reserveTokens resolves like Pi: ${title}`, () => {
  const manager = SettingsManager.inMemory(settings);
  for (const model of [MODEL, undefined]) assert.deepEqual(ourBudget(manager, model), piBudget(manager, model), `${title} (${model ? 'with' : 'without'} a model)`);
});

test('reserveTokens resolves like Pi when global and project settings are merged, and a project that is not trusted adds nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-auto-compact-threshold-'));
  try {
    const agentDir = join(root, 'agent'), cwd = join(root, 'work');
    mkdirSync(agentDir, { recursive: true }); mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { reserveTokens: 1000, modelOverrides: { [KEY]: { reserveTokens: 2000 }, 'vendor/other': { reserveTokens: 3000 } } } }));
    // The project overrides one field of the same model entry and adds another model: the merge is deep, so 2000 must survive.
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ compaction: { enabled: false, modelOverrides: { [KEY]: { keepRecentTokens: 5 }, 'vendor/third': { reserveTokens: 4000 } } } }));
    for (const projectTrusted of [true, false]) {
      const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
      for (const model of [MODEL, { provider: 'vendor', id: 'other' }, { provider: 'vendor', id: 'third' }, undefined]) {
        assert.deepEqual(ourBudget(manager, model), piBudget(manager, model), `trusted=${projectTrusted} model=${model?.id}`);
      }
    }
    // Pin the values themselves, so a shared mistake in both resolvers would still be caught.
    assert.deepEqual(ourBudget(SettingsManager.create(cwd, agentDir, { projectTrusted: true }), MODEL), { enabled: false, reserveTokens: 2000 });
    assert.deepEqual(ourBudget(SettingsManager.create(cwd, agentDir, { projectTrusted: false }), { provider: 'vendor', id: 'third' }), { enabled: true, reserveTokens: 1000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the defaults are the ones Pi documents and uses', () => {
  assert.equal(DEFAULT_RESERVE_TOKENS, 16384);
  assert.deepEqual(resolveCompactionBudget({}, MODEL), { enabled: true, reserveTokens: 16384 });
  assert.equal(SettingsManager.inMemory({}).getCompactionSettings(MODEL).reserveTokens, DEFAULT_RESERVE_TOKENS);
});

test('the threshold is the window minus the reserve, and unknown when Pi would not compact or cannot be mirrored', () => {
  assert.equal(compactionThreshold({}, { ...MODEL, contextWindow: 100000 }), 100000 - 16384);
  assert.equal(compactionThreshold({ compaction: { reserveTokens: 5000 } }, { ...MODEL, contextWindow: 100000 }), 95000);
  assert.equal(compactionThreshold({ compaction: { modelOverrides: { [KEY]: { reserveTokens: 7000 } } } }, { ...MODEL, contextWindow: 100000 }), 93000);
  assert.equal(compactionThreshold({ compaction: { enabled: false } }, { ...MODEL, contextWindow: 100000 }), undefined, 'compaction disabled');
  assert.equal(compactionThreshold({ compaction: { reserveTokens: -1 } }, { ...MODEL, contextWindow: 100000 }), undefined, 'invalid value');
  assert.equal(compactionThreshold({}, { ...MODEL, contextWindow: 0 }), undefined, 'unknown window');
  assert.equal(compactionThreshold({}, { ...MODEL }), undefined, 'no window');
  assert.equal(compactionThreshold({}, undefined), undefined, 'no model');
});
