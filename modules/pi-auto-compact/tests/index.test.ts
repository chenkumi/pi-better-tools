import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piAutoCompact from '../src/index.ts';

function load() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>(), other: string[] = [];
  piAutoCompact({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); },
    registerTool: () => other.push('tool'), registerCommand: () => other.push('command'), sendMessage: () => other.push('message'), sendUserMessage: () => other.push('user-message'),
  } as unknown as ExtensionAPI);
  return { handlers, other };
}

async function withAgentDir<T>(file: string | undefined, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-host-')), previous = process.env.PI_CODING_AGENT_DIR;
  if (file !== undefined) writeFileSync(join(dir, 'auto-compact.json'), file);
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registers exactly one hook and no tools, commands or messages', () => {
  const { handlers, other } = load();
  assert.deepEqual([...handlers.keys()], ['session_before_compact']);
  assert.deepEqual(other, []);
});

test('the skeleton hands compaction back to Pi and stays silent with a valid or missing file', async () => {
  const { handlers } = load(), notices: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
  await withAgentDir(undefined, async () => assert.equal(await handlers.get('session_before_compact')!({}, ctx), undefined));
  await withAgentDir('{ "l1Ratio": 0.4 }', async () => assert.equal(await handlers.get('session_before_compact')!({}, ctx), undefined));
  assert.deepEqual(notices, []);
});

test('an invalid file warns once with a UI, never without one, and still hands compaction back to Pi', async () => {
  const { handlers } = load(), notices: Array<[string, string]> = [];
  const ui = { hasUI: true, ui: { notify: (message: string, type: string) => notices.push([message, type]) } };
  await withAgentDir('{ "enabled": true }', async () => {
    assert.equal(await handlers.get('session_before_compact')!({}, { hasUI: false, ui: ui.ui }), undefined);
    assert.deepEqual(notices, []);
    assert.equal(await handlers.get('session_before_compact')!({}, ui), undefined);
    assert.equal(await handlers.get('session_before_compact')!({}, ui), undefined);
  });
  assert.equal(notices.length, 1);
  assert.equal(notices[0]![1], 'warning');
  assert.match(notices[0]![0], /unknown key: enabled.*left to Pi/);
});
