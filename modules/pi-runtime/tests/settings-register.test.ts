import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSettingsCommand, type SettingsSchema } from '../src/settings-panel/index.js';

function schema(path: string, extra: Partial<SettingsSchema<{ n: number }>> = {}): SettingsSchema<{ n: number }> {
  return {
    id: 'demo', title: 'Demo', path, parse: raw => ({ n: Number((raw as { n?: unknown })?.n ?? 0) }),
    fields: [{ key: 'n', type: 'string', group: 'G', label: 'N' }], toValues: config => ({ n: String(config.n) }),
    toPatch: values => [{ path: ['n'], value: Number(values.n) }], ...extra,
  };
}

/** Runs the command with a fake TUI whose panel reports "saved"; returns what the user was asked and told. */
async function run(source: SettingsSchema<{ n: number }>, answer = false): Promise<string[]> {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerSettingsCommand({ registerCommand: (_name: string, spec: { handler: typeof handler }) => { handler = spec.handler; } } as unknown as ExtensionAPI, source);
  const log: string[] = [];
  await handler!('', {
    hasUI: true, mode: 'tui', reload: async () => { log.push('reload'); },
    ui: { notify: (text: string) => log.push(`notify:${text}`), confirm: async (title: string, text: string) => { log.push(`confirm:${title}:${text}`); return answer; }, custom: async () => true },
  });
  return log;
}

test('by default a saved change asks whether to reload, because most modules read their file when extensions load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-register-'));
  try {
    return run(schema(join(dir, 'a.json'))).then(log => {
      assert.ok(log.some(line => line.startsWith('confirm:Demo settings:Settings are read when extensions load. Reload now?')), log.join('\n'));
      assert.ok(log.includes('notify:Run /reload to apply the new settings.'));
      assert.ok(!log.includes('reload'));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('answering yes reloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-register-'));
  try { assert.ok((await run(schema(join(dir, 'a.json')), true)).includes('reload')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a schema that applies without a reload gets neither the question nor a reload, and still reports the save and its own note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-register-'));
  try {
    const log = await run(schema(join(dir, 'a.json'), { appliesWithoutReload: true, afterSave: 'Applies at once.' }), true);
    assert.deepEqual(log, [`notify:Saved ${join(dir, 'a.json')}. Applies at once.`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the panel is not opened outside the TUI, and the file is never created by registering or refusing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-register-'));
  try {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    registerSettingsCommand({ registerCommand: (_name: string, spec: { handler: typeof handler }) => { handler = spec.handler; } } as unknown as ExtensionAPI, schema(join(dir, 'a.json')));
    const notices: string[] = [];
    await handler!('', { hasUI: true, mode: 'rpc', ui: { notify: (text: string) => notices.push(text) } });
    assert.match(notices.join(''), /needs the interactive TUI/);
    assert.throws(() => readFileSync(join(dir, 'a.json')), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
