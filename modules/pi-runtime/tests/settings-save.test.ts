import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SettingsPanel, saveSettings, type Field, type Patch, type SettingsSchema, type Values } from '../src/settings-panel/index.js';

function file(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-settings-save-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'c.json');
}
const schema = (path: string, over: Partial<SettingsSchema<Record<string, unknown>>> = {}): SettingsSchema<Record<string, unknown>> => ({
  id: 'x', title: 'X', path, fields: [], parse: raw => raw as Record<string, unknown>, toValues: () => ({}),
  toPatch: (values): Patch[] => (values.note === undefined ? [] : [{ path: ['note'], value: values.note }]), ...over,
});

test('Save writes the patches, then runs afterWrite with what was edited', async t => {
  const path = file(t);
  const calls: Array<{ edited: unknown; dirty: string[]; fileAtCall: string }> = [];
  const s = schema(path, { afterWrite: (edited, dirty) => { calls.push({ edited: { ...edited }, dirty: [...dirty], fileAtCall: readFileSync(path, 'utf8') }); return undefined; } });
  assert.equal(await saveSettings(s, { note: 'hi' }, new Set(['note'])), undefined);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { note: 'hi' });
  assert.deepEqual(calls.map(c => [c.edited, c.dirty]), [[{ note: 'hi' }, ['note']]]);
  assert.match(calls[0]!.fileAtCall, /"note": "hi"/, 'the file was already written when afterWrite ran');
});

test('an afterWrite failure is reported as the save error, and the written file stays', async t => {
  const path = file(t);
  const s = schema(path, { afterWrite: () => 'The settings were saved, but the extra step failed.' });
  assert.equal(await saveSettings(s, { note: 'kept' }, new Set(['note'])), 'The settings were saved, but the extra step failed.');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { note: 'kept' });
});

test('with no patches the file is left alone (not created, not rewritten), but afterWrite still runs', async t => {
  const path = file(t);
  let ran = 0;
  const s = schema(path, { afterWrite: () => { ran += 1; return undefined; } });
  assert.equal(await saveSettings(s, {}, new Set(['secret'])), undefined);
  assert.equal(existsSync(path), false);
  writeFileSync(path, '{"hand":"edited"}');
  assert.equal(await saveSettings(s, {}, new Set(['secret'])), undefined);
  assert.equal(readFileSync(path, 'utf8'), '{"hand":"edited"}');
  assert.equal(ran, 2);
});

test('a rejected document is not written and afterWrite does not run', async t => {
  const path = file(t);
  let ran = false;
  const s = schema(path, { parse: raw => { if ((raw as { note?: string }).note === 'bad') throw new Error('CONFIG_INVALID: note: nope'); return raw as Record<string, unknown>; }, afterWrite: () => { ran = true; return undefined; } });
  assert.equal(await saveSettings(s, { note: 'bad' }, new Set(['note'])), 'CONFIG_INVALID: note: nope');
  assert.equal(existsSync(path), false);
  assert.equal(ran, false);
});

test('an unusable file blocks Save unless the user chose to start fresh, which writes even without patches', async t => {
  const path = file(t);
  writeFileSync(path, '{ broken');
  assert.match((await saveSettings(schema(path), {}, new Set())) ?? '', /became unusable/);
  assert.equal(await saveSettings(schema(path), {}, new Set(), true), undefined);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

const style = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const settle = () => new Promise(resolve => setImmediate(resolve));
function codePanel(unsaved?: readonly string[]) {
  const fields: Field[] = [{ key: 'code', type: 'code', group: 'G', label: 'Code', generate: () => 'NEW-CODE' }];
  const saves: Array<{ values: Values; dirty: string[] }> = [];
  const panel = new SettingsPanel({
    title: 'T', fields, values: { code: 'OLD-CODE' }, ...(unsaved ? { unsaved } : {}), style, rows: () => 30, requestRender() {},
    async onSave(values, dirty) { saves.push({ values: { ...values }, dirty: [...dirty] }); return undefined; }, onClose() {},
  });
  return { panel, saves, text: () => panel.render(80).join('\n') };
}

test('a code field is read-only, regenerates live on Enter and only counts as changed once it differs', async () => {
  const { panel, saves, text } = codePanel();
  assert.match(text(), /Code\s+OLD-CODE  \(Enter to regenerate\)/);
  panel.handleInput('');
  await settle();
  assert.equal(saves.length, 0, 'untouched: nothing to save');
  panel.handleInput('\r');
  assert.match(text(), /Code\s+NEW-CODE/);
  assert.doesNotMatch(text(), /Enter confirm/, 'Enter regenerates; it never opens a text editor');
  panel.handleInput('');
  await settle();
  assert.deepEqual(saves.map(save => [save.values.code, save.dirty]), [['NEW-CODE', ['code']]]);
});

test('a key listed as unsaved starts out changed, so Save writes a value that is not stored yet', async () => {
  const { panel, saves } = codePanel(['code']);
  panel.handleInput('');
  await settle();
  assert.deepEqual(saves.map(save => [save.values.code, save.dirty]), [['OLD-CODE', ['code']]]);
});
