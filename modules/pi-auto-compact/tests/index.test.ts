import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piAutoCompact from '../src/index.ts';

function load() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>(), other: string[] = [], commands: string[] = [], tools: Array<{ name: string; exposure?: string; namespace?: { name: string } }> = [];
  piAutoCompact({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); },
    registerTool: (tool: { name: string; exposure?: string; namespace?: { name: string } }) => tools.push(tool), registerCommand: (name: string) => commands.push(name), sendMessage: () => other.push('message'), sendUserMessage: () => other.push('user-message'),
  } as unknown as ExtensionAPI);
  return { handlers, other, tools, commands };
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

test('registers the compaction and checkpoint hooks, the three deferred read-only session tools and the anchor tool, the one settings command and no messages', () => {
  const { handlers, other, tools, commands } = load();
  assert.deepEqual([...handlers.keys()].sort(), ['agent_before_settle', 'before_agent_start', 'context', 'session_before_compact', 'session_compact', 'session_start', 'turn_end']);
  assert.deepEqual(other, []);
  assert.deepEqual(commands, ['settings:auto-compact'], 'the panel command only; a bare /settings belongs to Pi');
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['progress_checkpoint', 'session_grep', 'session_read', 'session_window']);
  for (const tool of tools.filter(tool => tool.name !== 'progress_checkpoint')) { assert.equal(tool.exposure, 'deferred'); assert.equal(tool.namespace?.name, 'session'); }
  assert.notEqual(tools.find(tool => tool.name === 'progress_checkpoint')!.exposure, 'deferred');
});

test('a valid or missing file stays silent, and an event Pi cannot be helped with goes back to Pi', async () => {
  const { handlers } = load(), notices: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) }, model: undefined, sessionManager: { getSessionFile: () => undefined, getSessionId: () => 's' } };
  const event = { preparation: { firstKeptEntryId: 'x', tokensBefore: 1 }, branchEntries: [] };
  await withAgentDir(undefined, async () => assert.equal(await handlers.get('session_before_compact')!(event, ctx), undefined));
  await withAgentDir('{ "l1Ratio": 0.4 }', async () => assert.equal(await handlers.get('session_before_compact')!(event, ctx), undefined));
  assert.deepEqual(notices, []);
});

test('an unexpected failure warns once and hands compaction back to Pi', async () => {
  const { handlers } = load(), notices: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) }, model: { contextWindow: 1000 }, sessionManager: { getSessionFile: () => undefined, getSessionId: () => 's' } };
  const broken = { preparation: { firstKeptEntryId: 'x', tokensBefore: 1 }, get branchEntries(): never { throw new Error('boom'); } };
  await withAgentDir(undefined, async () => {
    assert.equal(await handlers.get('session_before_compact')!(broken, ctx), undefined);
    assert.equal(await handlers.get('session_before_compact')!(broken, ctx), undefined);
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /boom.*left to Pi/);
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
