// D08: schedule_prompt failures (missing job etc.) must reach the host as isError tool results.
// Level: real Pi 1.1.0 CLI (rpc), real extension runner/tool execution path, offline scripted provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSandbox, scheduleEntry, startPi, toolCall, toolResults, textOf, log } from './_harness.mjs';

test('D08: missing-job remove/enable results are isError through the real host tool path', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d08');
  try {
    const pi = startPi(sb, { label: 'D08', approve: true, extensions: [scheduleEntry], script: [
      { content: [toolCall('schedule_prompt', { action: 'remove', jobId: 'does-not-exist' }, 'c1')] },
      { content: [toolCall('schedule_prompt', { action: 'enable', jobId: 'also-missing' }, 'c2')] },
      { content: [{ type: 'text', text: 'done' }] },
    ] });
    await pi.send({ id: 'p1', type: 'prompt', message: 'Remove a job that does not exist.' });
    const settled = await pi.waitFor(e => e.type === 'agent_end', 60000, 'agent_end');
    assert.ok(settled, 'agent loop must finish (harness sanity)');
    await pi.finish();
    const results = toolResults(pi, 'schedule_prompt');
    log(`tool results: ${JSON.stringify(results.map(r => ({ isError: r.isError, text: textOf(r) })))}`);
    assert.equal(results.length, 2, 'both scripted tool calls executed');
    for (const r of results) {
      assert.match(textOf(r), /not found/i, 'precondition: the tool did report the missing job in text');
      assert.equal(r.isError, true, `missing-job failure must be isError=true for the model/host, got ${r.isError}: ${textOf(r)}`);
    }
  } finally { await sb.cleanup(); }
});
