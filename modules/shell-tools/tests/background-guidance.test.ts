import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBackgroundLifecycleGuidance, BACKGROUND_LIFECYCLE_SECTION } from '../src/background-guidance.js';

function fixture(active: string[]) {
  const handlers: Array<(event: any) => any> = [];
  const pi = { on(name: string, handler: any) { assert.equal(name, 'before_agent_start'); handlers.push(handler); }, getActiveTools() { return active; } };
  registerBackgroundLifecycleGuidance(pi as never);
  registerBackgroundLifecycleGuidance(pi as never);
  const event: any = { systemPrompt: 'USER PROMPT', systemPromptOptions: { sections: { other: 'KEEP' }, customPrompt: 'USER PROMPT' } };
  function run() { for (const handler of handlers) { const result = handler(event); if (result?.systemPrompt) { event.systemPrompt = result.systemPrompt; event.systemPromptOptions.forceSystemPrompt = result.systemPrompt; } } }
  return { event, run };
}

test('background lifecycle section is shared, idempotent and removed when tools are inactive', () => {
  const active = ['bash', 'subagent', 'shell_job_cancel', 'subagent_cancel'];
  const { event, run } = fixture(active);
  run(); run();
  const section = event.systemPromptOptions.sections[BACKGROUND_LIFECYCLE_SECTION];
  assert.match(section, /notification.*order/i);
  assert.match(section, /provisional/i);
  assert.match(section, /cancel.*no longer needed/i);
  assert.match(section, /cleanup/i);
  assert.match(section, /does not.*process tree/i);
  assert.match(section, /do not.*poll/i);
  assert.equal(event.systemPromptOptions.sections.other, 'KEEP');
  assert.equal(event.systemPromptOptions.customPrompt, 'USER PROMPT');
  assert.deepEqual(active, ['bash', 'subagent', 'shell_job_cancel', 'subagent_cancel']);
  assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ['other', BACKGROUND_LIFECYCLE_SECTION]);
  active.splice(0, active.length, 'read'); run();
  assert.equal(event.systemPromptOptions.sections[BACKGROUND_LIFECYCLE_SECTION], undefined);
  assert.equal(event.systemPromptOptions.sections.other, 'KEEP');
});

test('management-only loadouts receive guidance without enabling creation tools', () => {
  for (const tool of ['powershell', 'shell_job_status', 'shell_job_cancel', 'subagent_status', 'subagent_cancel', 'subagent_message']) {
    const { event, run } = fixture([tool]); run();
    assert.ok(event.systemPromptOptions.sections[BACKGROUND_LIFECYCLE_SECTION]);
  }
});

test('forced prompts preserve other text, avoid duplicates and remove only owned guidance', () => {
  const active = ['subagent_status'];
  const { event, run } = fixture(active);
  event.systemPromptOptions.forceSystemPrompt = 'FORCED KEEP';
  run(); run();
  assert.ok(event.systemPrompt.startsWith('FORCED KEEP'));
  assert.equal(event.systemPrompt.split('### Background job lifecycle').length - 1, 1);
  active.length = 0; run();
  assert.equal(event.systemPrompt, 'FORCED KEEP');
  assert.equal(event.systemPromptOptions.sections.other, 'KEEP');
});
