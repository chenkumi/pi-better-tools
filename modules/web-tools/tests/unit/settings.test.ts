import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { applyPatches, readRaw, writeJsonAtomic } from '../../../pi-runtime/src/settings-panel/index.js';
import { defaults, loadConfig, parseConfig } from '../../src/config.ts';
import { registerWebTools } from '../../src/index.ts';
import { webToolsSettings } from '../../src/settings.ts';

const schema = webToolsSettings('/unused/web-search.json');
const dirtyOf = (...keys: string[]) => new Set(keys);
/** Mirrors what the command does on Save, against a real file. */
function save(path: string, edits: Record<string, string | number | boolean>) {
  const s = webToolsSettings(path), raw = readRaw(path).state === 'invalid' ? {} : (readRaw(path) as { raw: Record<string, unknown> }).raw;
  const current = s.parse(raw), values = { ...s.toValues(current), ...edits };
  const next = applyPatches(raw, s.toPatch(values, dirtyOf(...Object.keys(edits)), current));
  s.parse(next); writeJsonAtomic(path, next);
}
const withDir = (fn: (file: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-web-settings-'));
  try { fn(join(dir, 'web-search.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('defaults round-trip through the panel values and every field key is backed by a value or a secret', () => {
  const values = schema.toValues(defaults());
  for (const f of schema.fields) if (f.type !== 'secret' && f.type !== 'action') assert.ok(f.key in values, `no initial value for ${f.key}`);
  assert.deepEqual(schema.toPatch(values, dirtyOf(), defaults()), [], 'untouched panel writes nothing');
});

test('provider decides which credential fields are visible', () => {
  const visible = (provider: string) => schema.fields.filter(f => !f.visibleWhen || f.visibleWhen({ ...schema.toValues(defaults()), provider })).map(f => f.key);
  assert.ok(visible('brave').includes('brave.source') && !visible('brave').includes('exa.source'));
  assert.ok(visible('openai').includes('openai.captureSources') && !visible('openai').some(k => k.startsWith('brave.')));
  assert.ok(visible('native').includes('google.captureSources'));
  assert.ok(visible('deepseek').includes('deepseek.source') && !visible('deepseek').includes('deepseek.env'));
});

test('saving a provider and env source writes only those keys and keeps untouched ones', () => withDir(file => {
  writeFileSync(file, JSON.stringify({ fetch: { channel: 'chrome' } }));
  save(file, { provider: 'brave', 'brave.source': 'env', 'brave.env': 'MY_BRAVE' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { fetch: { channel: 'chrome' }, provider: 'brave', providers: { brave: { apiKeyEnv: 'MY_BRAVE' } } });
  assert.equal(loadConfig(file).providers.brave.apiKeyEnv, 'MY_BRAVE');
}));

test('a typed API key is written directly and replaces the env name; switching back to env removes the key', () => withDir(file => {
  save(file, { provider: 'exa', 'exa.source': 'key', 'exa.key': '  sk-123  ' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).providers.exa, { apiKey: 'sk-123' });
  assert.equal(loadConfig(file).providers.exa.apiKey, 'sk-123');
  save(file, { 'exa.source': 'env', 'exa.env': 'EXA_KEY' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).providers.exa, { apiKeyEnv: 'EXA_KEY' });
}));

test('key source without a key or env name is refused, and an existing key is kept when none is typed', () => withDir(file => {
  assert.throws(() => save(file, { provider: 'brave', 'brave.source': 'key' }), /API key: type the Brave key/);
  assert.throws(() => save(file, { provider: 'brave', 'brave.source': 'env', 'brave.env': ' ' }), /Enter the environment variable name/);
  writeFileSync(file, JSON.stringify({ providers: { brave: { apiKey: 'OLD' } } }));
  save(file, { 'brave.source': 'key', numResults: 7 });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.providers.brave.apiKey, 'OLD'); assert.equal(saved.numResults, 7);
}));

test('deepseek "pi" source clears explicit credentials', () => withDir(file => {
  writeFileSync(file, JSON.stringify({ provider: 'deepseek', providers: { deepseek: { apiKey: 'OLD' } } }));
  save(file, { 'deepseek.source': 'pi' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.providers, undefined);
  assert.deepEqual(loadConfig(file).providers.deepseek, {});
}));

test('credentials of a provider that is not selected are never written', () => withDir(file => {
  const s = webToolsSettings(file), current = defaults();
  const values = { ...s.toValues(current), provider: 'openai', 'brave.source': 'key', 'brave.key': 'LEAK' };
  assert.deepEqual(s.toPatch(values, dirtyOf('provider', 'brave.source', 'brave.key'), current).map(p => p.path.join('.')), ['provider']);
}));

test('the saved file always passes the module parser', () => withDir(file => {
  save(file, { enabled: false, provider: 'native', 'google.captureSources': true, numResults: 10, searchTimeoutMs: 120000, 'fetch.channel': 'chrome', 'fetch.maxConcurrency': 4 });
  const c = loadConfig(file);
  assert.equal(c.enabled, false); assert.equal(c.providers.google.captureSources, true); assert.equal(c.fetch.maxConcurrency, 4);
  assert.deepEqual(parseConfig(JSON.parse(readFileSync(file, 'utf8'))), c);
}));

test('only /settings:web-tools is added; the bare /settings command is not registered', () => {
  const commands: string[] = [];
  const pi = { getActiveTools: () => [], registerTool() {}, on() {}, registerCommand(name: string) { commands.push(name); }, appendEntry() {} } as unknown as ExtensionAPI;
  registerWebTools(pi, () => defaults(), () => {});
  assert.ok(commands.includes('settings:web-tools') && commands.includes('web-tools'));
  assert.ok(!commands.includes('settings'));
});

import { EventEmitter } from 'node:events';
import { chromiumStatus, installChromium } from '../../src/settings.ts';

function fakeSpawn(behavior: (child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): boolean }) => void) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const children: { killed: boolean }[] = [];
  const spawnChild = ((command: string, args: string[], options: Record<string, unknown>) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { this.killed = true; return true; } });
    calls.push({ command, args, options }); children.push(child); queueMicrotask(() => behavior(child));
    return child;
  }) as never;
  return { spawnChild, calls, children };
}
const invocation = { command: 'node', args: ['playwright-cli.js', 'install', 'chromium', '--no-shell'], cwd: '/work', env: {} as NodeJS.ProcessEnv };

test('installChromium: browser-only command, piped output (never inherited), progress, success', async () => {
  const { spawnChild, calls } = fakeSpawn(child => { child.stdout.emit('data', Buffer.from('Downloading Chromium\r|■■■| 40% of 150 MiB\n')); child.emit('close', 0); });
  const seen: string[] = [];
  const result = await installChromium({ signal: new AbortController().signal, progress: t => seen.push(t) }, spawnChild, invocation);
  assert.equal(result, 'Chromium installed.');
  assert.deepEqual(calls[0]!.args, invocation.args);
  assert.deepEqual((calls[0]!.options as { stdio: unknown }).stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal((calls[0]!.options as { shell: unknown }).shell, false);
  assert.ok(!calls[0]!.args.includes('install-deps') && !calls[0]!.args.includes('--with-deps'), 'no OS dependency install');
  assert.ok(seen.length >= 1);
});

test('installChromium: a failing installer reports its exit code and last line; control characters are stripped', async () => {
  const { spawnChild } = fakeSpawn(child => { child.stderr.emit('data', Buffer.from('boom\x1b[31m: network down\n')); child.emit('close', 1); });
  await assert.rejects(installChromium({ signal: new AbortController().signal, progress() {} }, spawnChild, invocation), (e: Error) => /exit 1/.test(e.message) && /network down/.test(e.message) && !/\x1b/.test(e.message));
});

test('installChromium: abort kills the installer and rejects; an already-aborted signal never leaves it running', async () => {
  const abort = new AbortController();
  const live = fakeSpawn(() => {});
  const pending = installChromium({ signal: abort.signal, progress() {} }, live.spawnChild, invocation);
  await new Promise(r => setImmediate(r));
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(live.children[0]!.killed, true);
  const pre = new AbortController(); pre.abort();
  const early = fakeSpawn(() => {});
  await assert.rejects(installChromium({ signal: pre.signal, progress() {} }, early.spawnChild, invocation), /cancelled/);
  assert.equal(early.children[0]!.killed, true);
});

test('chromiumStatus only inspects presence and returns a plain label', () => {
  assert.ok(['installed', 'not installed', 'unknown'].includes(chromiumStatus()));
});
