import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { saveSettings } from '../../../shared/src/settings-panel/index.js';
import { DEFAULT_CONFIG, configPath, loadConfig } from '../src/config.ts';
import { autoCompactSettings, registerAutoCompactSettings } from '../src/settings.ts';

async function withDir<T>(file: string | undefined, run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-settings-')), previous = process.env.PI_CODING_AGENT_DIR;
  if (file !== undefined) writeFileSync(join(dir, 'auto-compact.json'), file);
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return await run(dir); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
}
const onDisk = (dir: string) => JSON.parse(readFileSync(configPath(dir), 'utf8'));

test('there is one field for every key of the settings file, and nothing else (a new key cannot be forgotten)', () => {
  const schema = autoCompactSettings('/unused');
  assert.deepEqual(schema.fields.map(field => field.key).sort(), Object.keys(DEFAULT_CONFIG).sort());
  for (const field of schema.fields) assert.equal(field.type, 'string');
});

test('values show only what the file sets; everything else is blank so the default stays visible as the placeholder', async () => withDir('{ "l3MinChars": 4000, "maxTotalRatio": 0.4 }', dir => {
  const schema = autoCompactSettings(dir);
  const values = schema.toValues(schema.parse(JSON.parse(readFileSync(configPath(dir), 'utf8'))));
  assert.equal(values.l3MinChars, '4000');
  assert.equal(values.maxTotalRatio, '0.4');
  assert.equal(values.l1MinChars, '');
  assert.equal(values.charsPerToken, '');
  for (const field of schema.fields) assert.equal((field as { placeholder?: string }).placeholder, String(DEFAULT_CONFIG[field.key as keyof typeof DEFAULT_CONFIG]), field.key);
}));

test('Save writes only the changed key, keeps the others, and the module loader reads the result', async () => withDir('{ "l1MinChars": 25000 }', async dir => {
  const schema = autoCompactSettings(dir);
  const error = await saveSettings(schema, { ...schema.toValues(schema.parse(onDisk(dir))), l3MinChars: '3000', checkpointRatio: ' 0.25 ' }, new Set(['l3MinChars', 'checkpointRatio']));
  assert.equal(error, undefined);
  assert.deepEqual(onDisk(dir), { l1MinChars: 25000, l3MinChars: 3000, checkpointRatio: 0.25 });
  const loaded = loadConfig(dir);
  assert.ok(loaded.ok);
  assert.equal(loaded.config.l3MinChars, 3000);
  assert.equal(loaded.config.l1MinChars, 25000);
  assert.equal(loaded.config.l2MinChars, DEFAULT_CONFIG.l2MinChars);
}));

test('a blank field puts the default back by removing the key, and the file goes away when nothing is left', async () => withDir('{ "l3MinChars": 3000, "l1MinChars": 25000 }', async dir => {
  const schema = autoCompactSettings(dir);
  const values = schema.toValues(schema.parse(onDisk(dir)));
  assert.equal(await saveSettings(schema, { ...values, l3MinChars: '' }, new Set(['l3MinChars'])), undefined);
  assert.deepEqual(onDisk(dir), { l1MinChars: 25000 });
  assert.equal(await saveSettings(schema, { ...values, l1MinChars: '' }, new Set(['l1MinChars'])), undefined);
  assert.equal(existsSync(configPath(dir)), false, 'no file means all defaults');
  assert.ok(loadConfig(dir).ok);
}));

test('a value the module loader would reject is refused with the rule, nothing is written, and the message never echoes the value', async () => withDir('{ "l1MinChars": 25000 }', async dir => {
  const schema = autoCompactSettings(dir), before = readFileSync(configPath(dir), 'utf8');
  const values = schema.toValues(schema.parse(onDisk(dir)));
  for (const [key, text, expected] of [
    ['l2Ratio', '2', /l2Ratio must be greater than 0 and at most 1/], ['l2Ratio', '0', /l2Ratio/], ['l3MinChars', '12.5', /l3MinChars must be a positive integer/],
    ['l3MinChars', '-5', /l3MinChars/], ['charsPerToken', '9', /charsPerToken must be between 1 and 8/], ['maxTotalRatio', 'abc', /maxTotalRatio must be a number/],
    ['maxTotalRatio', '0x10', /maxTotalRatio must be a number/], ['l4MinChars', '1e999', /l4MinChars/],
  ] as const) {
    const error = await saveSettings(schema, { ...values, [key]: text }, new Set([key]));
    assert.match(error ?? '', expected, `${key}=${text}`);
    assert.ok(!(error ?? '').includes(text) || text.length < 2, 'the typed value is not echoed back');
  }
  assert.equal(readFileSync(configPath(dir), 'utf8'), before, 'the file is untouched after every refusal');
}));

test('a file with an unknown key is refused instead of being rewritten (the loader is strict); the panel offers to start from defaults', async () => withDir('{ "enabled": true, "l1MinChars": 25000 }', async dir => {
  const schema = autoCompactSettings(dir), before = readFileSync(configPath(dir), 'utf8');
  assert.throws(() => schema.parse(onDisk(dir)), /CONFIG_INVALID: unknown key: enabled/);
  const error = await saveSettings(schema, { l3MinChars: '3000' }, new Set(['l3MinChars']));
  assert.match(error ?? '', /CONFIG_INVALID: unknown key: enabled/);
  assert.equal(readFileSync(configPath(dir), 'utf8'), before);
  assert.equal(await saveSettings(schema, { l3MinChars: '3000' }, new Set(['l3MinChars']), true), undefined, 'starting fresh replaces the file');
  assert.deepEqual(onDisk(dir), { l3MinChars: 3000 });
}));

test('the notice states the budgets that apply now for the current model, and stays short when they cannot be known', async () => {
  await withDir(undefined, dir => {
    assert.match(autoCompactSettings(dir, 200_000).notice ?? '', /Blank = default\. Now, at 200000 tokens: L1 30000 · L2 20000 · L3 6000 · L4 6000 characters\./);
    assert.equal(autoCompactSettings(dir, undefined).notice, 'Blank = default.');
  });
  await withDir('{ "l1Ratio": 0.5, "l2MinChars": 1000 }', dir => assert.match(autoCompactSettings(dir, 200_000).notice ?? '', /L1 100000 · L2 2000 · L3 6000/)); // a ratio can win over the minimum (L1); L2 stays at window × 0.01
  await withDir('{ "nope": 1 }', dir => assert.equal(autoCompactSettings(dir, 200_000).notice, 'Blank = default.', 'an invalid file gives no budgets'));
});

type Handler = (args: string, ctx: unknown) => Promise<void>;
function command() {
  const commands = new Map<string, { description?: string; handler: Handler }>();
  registerAutoCompactSettings({ registerCommand: (name: string, spec: { description?: string; handler: Handler }) => { commands.set(name, spec); } } as unknown as ExtensionAPI);
  return commands;
}

test('/settings:auto-compact is registered, refuses outside the TUI without touching the file, and tells where the file is', async () => withDir(undefined, async dir => {
  const commands = command();
  assert.deepEqual([...commands.keys()], ['settings:auto-compact']);
  const notices: string[] = [];
  await commands.get('settings:auto-compact')!.handler('', { hasUI: true, mode: 'rpc', model: { contextWindow: 200_000 }, ui: { notify: (text: string) => notices.push(text) } });
  assert.match(notices.join('\n'), /needs the interactive TUI/);
  assert.ok(notices.join('\n').includes(configPath(dir)));
  assert.equal(existsSync(configPath(dir)), false);
}));

test('Save in the panel does not ask to reload, because every part reads the file on use', async () => withDir(undefined, async () => {
  const commands = command(), log: string[] = [];
  const ctx = {
    hasUI: true, mode: 'tui', model: { contextWindow: 200_000 }, reload: async () => { log.push('reload'); },
    ui: { notify: (text: string) => log.push(`notify:${text}`), confirm: async (title: string) => { log.push(`confirm:${title}`); return false; }, custom: async () => true },
  };
  await commands.get('settings:auto-compact')!.handler('', ctx);
  assert.equal(log.filter(line => line.startsWith('confirm:')).length, 0, 'no reload question');
  assert.ok(!log.includes('reload'));
  assert.match(log.join('\n'), /Saved .*auto-compact\.json\. Applies from the next compaction; no reload needed\./);
}));
