import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { AUTO_COMPACT_SECTION, registerGuidance } from '../src/guidance.ts';

type Handler = (event: any) => any;
function load() {
  const handlers = new Map<string, Handler>();
  registerGuidance({ on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  return handlers.get('before_agent_start')!;
}
function withAgentDir<T>(file: string | undefined, run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-guidance-')), previous = process.env.PI_CODING_AGENT_DIR;
  if (file !== undefined) writeFileSync(join(dir, 'auto-compact.json'), file);
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return run(); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
}
const event = (options: Record<string, unknown> = {}, systemPrompt = 'BASE') => ({ systemPrompt, systemPromptOptions: { sections: {} as Record<string, string>, ...options } });

test('the section explains the mechanism, how to recall, and the conclusion-first reporting style, in a short fixed text', () => withAgentDir(undefined, () => {
  const e = event();
  assert.equal(load()(e), undefined, 'a normal prompt is built from sections, so nothing is returned');
  const section = e.systemPromptOptions.sections[AUTO_COMPACT_SECTION]!;
  assert.ok(section.length > 200 && section.length < 1500, `${section.length}`);
  for (const needle of ['⟦L', 'session_read', 'tool_search', 'first sentence', 'task notes']) assert.ok(section.includes(needle), needle);
  const again = event();
  load()(again);
  assert.equal(again.systemPromptOptions.sections[AUTO_COMPACT_SECTION], section, 'the same text every time (prompt cache)');
}));

test('with an invalid settings file compaction is left to Pi, so the section is removed instead of describing a mechanism that is not running', () => withAgentDir('{ "enabled": true }', () => {
  const e = event();
  e.systemPromptOptions.sections[AUTO_COMPACT_SECTION] = 'stale';
  load()(e);
  assert.equal(AUTO_COMPACT_SECTION in e.systemPromptOptions.sections, false);
}));

test('a forced prompt gets the section appended once and loses it again when disabled; other sections stay', () => withAgentDir(undefined, () => {
  const handler = load();
  const forced = event({ forceSystemPrompt: 'FORCED' }, 'FORCED');
  forced.systemPromptOptions.sections.other = 'KEEP';
  const out = handler(forced);
  assert.ok(out.systemPrompt.startsWith('FORCED\n\n') && out.systemPrompt.includes('⟦L'));
  const twice = handler({ ...event({ forceSystemPrompt: out.systemPrompt }, out.systemPrompt) });
  assert.equal(twice, undefined, 'already present: nothing to change');
  assert.equal(forced.systemPromptOptions.sections.other, 'KEEP');
  withAgentDir('{ "enabled": true }', () => {
    const off = handler(event({ forceSystemPrompt: out.systemPrompt }, out.systemPrompt));
    assert.equal(off.systemPrompt, 'FORCED');
  });
}));
