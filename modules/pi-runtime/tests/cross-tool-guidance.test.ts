import assert from 'node:assert/strict';
import test from 'node:test';
import { CROSS_TOOL_SECTION, registerCrossToolGuidance, renderCrossToolRules } from '../src/cross-tool-guidance.ts';

const rules = (...tools: string[]) => renderCrossToolRules(new Set(tools));

test('the general rules always appear; blocks follow the active tools', () => {
  const bare = rules('read');
  assert.match(bare, /^### Cross-tool rules/); assert.match(bare, /When something fails/);
  for (const absent of [/Files and shell/, /Delegate deliberately/, /Verify before claiming/]) assert.doesNotMatch(bare, absent);
  const shell = rules('powershell', 'edit');
  assert.match(shell, /Files and shell/); assert.match(shell, /Verify before claiming/); assert.doesNotMatch(shell, /Delegate/);
  assert.doesNotMatch(rules('bash'), /Files and shell/, 'needs edit or write');
});

test('editing a file from the shell is stated as a rule violation, not just discouraged', () => {
  for (const shell of [rules('bash', 'write'), rules('powershell', 'edit', 'subagent', 'fork')]) {
    assert.match(shell, /never through shell redirection, `sed`, or one-off scripts \(`node -e`, `perl -i`\)/);
    assert.match(shell, /is a rule violation/);
    assert.match(shell, /Use the shell for builds, tests, git and pipelines/);
  }
});

test('delegation text names only the active delegation tools', () => {
  const both = rules('subagent', 'fork'); assert.match(both, /`subagent` for self-contained/); assert.match(both, /`fork` for long work/);
  const sub = rules('subagent'); assert.doesNotMatch(sub, /fork/);
  const fork = rules('fork'); assert.doesNotMatch(fork, /`subagent`/); assert.match(fork, /`fork` for long work/);
});

test('the section stays within the token budget and avoids single-module tool names', () => {
  const all = rules('bash', 'edit', 'subagent', 'fork');
  assert.ok(all.length / 4 < 400, `~${Math.round(all.length / 4)} tokens`);
  for (const name of ['note', 'web_', 'sqlite', 'monitor_', 'schedule_prompt', 'recall', 'pty_']) assert.ok(!all.includes(name), name);
});

function host(active: string[]) {
  let handler: ((event: any) => any) | undefined, current = [...active];
  registerCrossToolGuidance({ on: (_e: string, h: any) => { handler = h; }, getActiveTools: () => [...current] } as never);
  return { setActive: (n: string[]) => { current = n; },
    run: (extra: object = {}) => { const options: any = { sections: {}, ...extra }; return { options, result: handler!({ systemPromptOptions: options, systemPrompt: options.forceSystemPrompt ?? 'base' }) }; } };
}

test('the section is set on every turn and tracks the active tools', () => {
  const h = host(['read']);
  assert.doesNotMatch(h.run().options.sections[CROSS_TOOL_SECTION], /Delegate/);
  h.setActive(['read', 'subagent']);
  assert.match(h.run().options.sections[CROSS_TOOL_SECTION], /Delegate/);
});

test('a forced system prompt gets the section appended once and replaced when the tools change', () => {
  const h = host(['subagent']);
  const first = h.run({ forceSystemPrompt: 'FORCED' });
  assert.match(first.result.systemPrompt, /^FORCED\n\n### Cross-tool rules/);
  assert.equal(h.run({ forceSystemPrompt: first.result.systemPrompt }).result, undefined, 'idempotent');
  h.setActive(['bash', 'edit']);
  const next = h.run({ forceSystemPrompt: first.result.systemPrompt }).result.systemPrompt;
  assert.match(next, /^FORCED\n\n### Cross-tool rules/); assert.doesNotMatch(next, /Delegate/); assert.match(next, /Files and shell/);
  assert.equal((next.match(/### Cross-tool rules/g) ?? []).length, 1);
});
