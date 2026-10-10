// D09: a scheduled subagent run whose child session ends with stopReason "aborted" (not requested by the parent)
// must not be recorded as a successful run.
// Level: real Pi 1.1.0 CLI (rpc); real tool adds a `once` model job; real scheduler runs the real in-process child
// session (createAgentSession) against the offline scripted provider whose child step returns stopReason "aborted".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { log, makeSandbox, readJsonl, readStore, scheduleEntry, startPi, toolCall, waitUntil } from './_harness.mjs';

test('D09: child self-abort is not recorded as success / runCount', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d09');
  try {
    const pi = startPi(sb, { label: 'D09', approve: true, extensions: [scheduleEntry], script: [
      { content: [toolCall('schedule_prompt', { action: 'add', name: 'abort-child', type: 'once', schedule: '+1s', prompt: 'child task', model: 'repro-offline/fixture' }, 'c1')] },
      { content: [{ type: 'text', text: 'scheduled' }] },
      // Request 3 is the child session's only model call: it ends by itself with stopReason "aborted".
      { content: [{ type: 'text', text: 'partial output before abort' }], stopReason: 'aborted' },
    ] });
    await pi.send({ id: 'p1', type: 'prompt', message: 'Schedule the child job.' });
    assert.ok(await pi.waitFor(e => e.type === 'agent_end', 60000, 'parent agent_end'), 'parent turn must finish (harness sanity)');
    // Barrier: the child ran its model call and the scheduler wrote a terminal status (upper bound 40s).
    const terminal = await waitUntil(async () => {
      const j = (await readStore(sb)).jobs.find(x => x.name === 'abort-child');
      return j && j.lastStatus && j.lastStatus !== 'running' ? j : undefined;
    }, 40000, 'terminal lastStatus for abort-child');
    await pi.finish();
    const reqs = await readJsonl(pi.paths.requests);
    log(`provider requests=${reqs.length}; job=${JSON.stringify(terminal && { lastStatus: terminal.lastStatus, runCount: terminal.runCount })}`);
    assert.ok(reqs.length >= 3, 'precondition: the child session really called the provider (request 3)');
    assert.ok(terminal, 'scheduler must record a terminal status');
    assert.notEqual(terminal.lastStatus, 'success', 'child ended with stopReason=aborted without a parent cancel; it must not be recorded as success');
    assert.equal(terminal.runCount ?? 0, 0, 'aborted child must not increment runCount');
  } finally { await sb.cleanup(); }
});
