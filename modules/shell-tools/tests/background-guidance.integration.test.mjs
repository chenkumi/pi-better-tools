import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiFixture } from './helpers/pi-fixture.mjs';

// Actual loader/hooks, no prompts, jobs or provider calls.
test('real Pi background guidance follows selection, forced prompts and reload without activating tools', async () => {
  const fixture = await createPiFixture();
  try {
    for (const tools of [['bash'], ['shell_job_status'], ['shell_job_cancel'], ['read']]) {
      const { session, cwd } = await fixture.createSession({ tools });
      const before = session.agent.state.tools.map(tool => tool.name);
      const enabled = tools.some(name => name !== 'read');
      const emit = () => session.extensionRunner.emitBeforeAgentStart('offline hook probe', undefined, {
        cwd, tools: session.agent.state.tools, skills: [], contextFiles: [], customPrompt: 'KEEP_CUSTOM',
        forceSystemPrompt: 'KEEP_FORCED', sections: { other: 'KEEP_OTHER' },
      });
      const result = await emit();
      assert.equal(Boolean(result.systemPromptOptions.sections.pi_better_tools_background_lifecycle), enabled);
      assert.equal(result.systemPromptOptions.sections.other, 'KEEP_OTHER');
      assert.equal(result.systemPromptOptions.customPrompt, 'KEEP_CUSTOM');
      assert.ok(result.systemPromptOptions.forceSystemPrompt.startsWith('KEEP_FORCED'));
      assert.equal(result.systemPromptOptions.forceSystemPrompt.split('### Background job lifecycle').length - 1, enabled ? 1 : 0);
      assert.deepEqual(session.agent.state.tools.map(tool => tool.name), before);
      await session.reload();
      const after = await emit();
      assert.equal(Boolean(after.systemPromptOptions.sections.pi_better_tools_background_lifecycle), enabled);
      assert.deepEqual(session.agent.state.tools.map(tool => tool.name), before);
    }
  } finally { fixture.cleanup(); }
});
