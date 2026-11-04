import assert from 'node:assert/strict';
import test from 'node:test';
import { CROSS_TOOL_SECTION, registerCrossToolGuidance, renderCrossToolRules } from '../src/cross-tool-guidance.ts';

test('the general rules name no module tool and stay small', () => {
  const rules = renderCrossToolRules();
  assert.match(rules, /Run independent tool calls/); assert.match(rules, /When something fails/);
  for (const name of ['bash', 'powershell', 'read', 'edit', 'write', 'web_', 'subagent', 'fork', 'note', 'sqlite', 'monitor_', 'pty_']) assert.ok(!rules.includes(`\`${name}`), name);
  assert.ok(rules.length / 4 < 150, `~${Math.round(rules.length / 4)} tokens`);
});

function host(active: string[]) {
  let handler: ((event: any) => any) | undefined;
  registerCrossToolGuidance({ on: (_e: string, h: any) => { handler = h; }, getActiveTools: () => [...active] } as never);
  return (extra: object = {}) => {
    const options: any = { sections: {}, ...extra };
    return { options, result: handler!({ systemPromptOptions: options, systemPrompt: options.forceSystemPrompt ?? 'base' }) };
  };
}

test('the section is set on every turn regardless of the active tools', () => {
  const run = host([]);
  assert.equal(run().options.sections[CROSS_TOOL_SECTION], renderCrossToolRules());
});

test('a forced system prompt gets the section appended once', () => {
  const run = host(['bash']);
  const first = run({ forceSystemPrompt: 'FORCED' });
  assert.equal(first.result.systemPrompt, `FORCED\n\n${renderCrossToolRules()}`);
  assert.equal(run({ forceSystemPrompt: first.result.systemPrompt }).result, undefined, 'idempotent');
});
