// D06: the recursion guard must block schedule_prompt add inside a scheduled-prompt turn.
// Level: real Pi 1.1.0 CLI (rpc) with persisted session; real scheduler fires an inline job (sendMessage + sendUserMessage);
// the scripted offline provider then asks the real tool to add a new job. Entry types are read from the persisted session JSONL.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { job, log, makeSandbox, readStore, scheduleEntry, startPi, textOf, toolCall, toolResults, waitUntil, writeStore } from './_harness.mjs';

async function sessionEntries(sb) {
  const all = await readdir(join(sb.agentDir, 'sessions'), { recursive: true }).catch(() => []);
  const out = [];
  for (const f of all.filter(f => f.endsWith('.jsonl'))) out.push(...(await readFile(join(sb.agentDir, 'sessions', f), 'utf8')).trim().split('\n').map(l => JSON.parse(l)));
  return out;
}

test('D06: recursive schedule_prompt add from a scheduled-prompt turn is rejected', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d06');
  try {
    await writeStore(sb, [job({ id: 'seed-job', name: 'seed', intervalMs: 1000, schedule: '1s', prompt: 'SCHEDULED_PROMPT_TEXT' })]);
    const pi = startPi(sb, { label: 'D06', approve: true, extensions: [scheduleEntry], script: [
      { content: [toolCall('schedule_prompt', { action: 'add', name: 'recursive-child', type: 'interval', schedule: '1h', prompt: 'spawned from a scheduled prompt' }, 'c1')] },
      { content: [{ type: 'text', text: 'done' }] },
    ] });
    // Barrier: the real scheduler fire -> prompt -> tool result (upper bound 60s).
    const result = await pi.waitFor(e => e.type === 'message_end' && e.message?.role === 'toolResult' && e.message.toolName === 'schedule_prompt', 60000, 'schedule_prompt tool result');
    assert.ok(result, 'scheduler must have fired the inline job and the model turn must have called the tool (harness sanity)');
    await pi.finish();
    const entries = await sessionEntries(sb);
    const marker = entries.find(e => e.customType === 'scheduled_prompt');
    log(`persisted marker entry type=${marker?.type} customType=${marker?.customType}`);
    assert.ok(marker, 'precondition: scheduler persisted its scheduled_prompt marker');
    const [r] = toolResults(pi, 'schedule_prompt');
    const stored = await readStore(sb);
    log(`tool isError=${r.isError} text=${JSON.stringify(textOf(r))}; stored jobs=${stored.jobs.map(j => j.name)}`);
    assert.ok(r.isError === true || /cannot create scheduled prompts/i.test(textOf(r)),
      `guard must reject add inside a scheduled-prompt turn (marker persisted as entry.type=${marker.type}, guard checks type==="custom"): ${textOf(r)}`);
    assert.ok(!stored.jobs.some(j => j.name === 'recursive-child'), 'no new job may be created from within a scheduled-prompt execution');
  } finally { await sb.cleanup(); }
});
