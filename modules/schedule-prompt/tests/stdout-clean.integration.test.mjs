// D07: attempt to confirm or refute "Schedule Prompt console.log pollutes machine-readable stdout" on the real Pi 1.1.0 CLI.
// Static claim sites: scheduler.ts console.log("Executing scheduled prompt: ...") and index.ts console.log("Auto-cleanup: ...").
// Level: real CLI in `-p --mode json`, `-p` (text) and `--mode rpc`; offline scripted provider. The tests assert the CORRECT behavior:
// every stdout line is protocol JSON (or, for text mode, stdout is just the answer) and none of the extension's diagnostics appears on stdout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { job, log, makeSandbox, readStore, scheduleEntry, startPi, waitUntil, writeStore } from './_harness.mjs';

const DIAG = /Auto-cleanup|Executing scheduled prompt/;
const answer = [{ content: [{ type: 'text', text: 'FINAL_ANSWER' }] }];

test('D07a: -p --mode json: Auto-cleanup diagnostics do not reach JSONL stdout', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d07a');
  try {
    // A disabled job is swept on session_shutdown (index.ts autoCleanupDisabledJobs -> console.log).
    await writeStore(sb, [job({ id: 'disabled-job', name: 'sweep-me', enabled: false })]);
    const pi = startPi(sb, { label: 'D07a', mode: 'json', approve: true, extensions: [scheduleEntry], script: answer });
    await pi.finish(60000);
    const swept = (await readStore(sb)).jobs.length === 0;
    log(`exit=${pi.code} sweptDisabledJob=${swept} stdoutLines=${pi.events.length} nonJsonLines=${JSON.stringify(pi.badLines)} diagOnStderr=${DIAG.test(pi.stderr)}`);
    assert.ok(swept, 'precondition: the disabled job was swept at shutdown, so the console.log path executed');
    assert.deepEqual(pi.badLines, [], 'every stdout line must be a JSON event');
    assert.ok(!DIAG.test(pi.stdout), 'extension diagnostics must not be written to stdout');
  } finally { await sb.cleanup(); }
});

test('D07b: -p (text): stdout is only the assistant answer', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d07b');
  try {
    await writeStore(sb, [job({ id: 'disabled-job', name: 'sweep-me', enabled: false })]);
    const pi = startPi(sb, { label: 'D07b', mode: 'text', approve: true, extensions: [scheduleEntry], script: answer });
    await pi.finish(60000);
    const swept = (await readStore(sb)).jobs.length === 0;
    log(`exit=${pi.code} sweptDisabledJob=${swept} stdout=${JSON.stringify(pi.stdout.slice(0, 200))} stderr=${JSON.stringify(pi.stderr.slice(0, 200))}`);
    assert.ok(swept, 'precondition: the console.log path executed');
    assert.ok(!DIAG.test(pi.stdout), 'extension diagnostics must not be written to stdout');
    assert.match(pi.stdout, /FINAL_ANSWER/);
  } finally { await sb.cleanup(); }
});

test('D07c: --mode rpc: a firing job and shutdown cleanup leave stdout as pure JSONL', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d07c');
  try {
    await writeStore(sb, [job({ id: 'fire-job', name: 'fires', type: 'interval', schedule: '1s', intervalMs: 1000 }), job({ id: 'disabled-job', name: 'sweep-me', enabled: false })]);
    const pi = startPi(sb, { label: 'D07c', mode: 'rpc', approve: true, extensions: [scheduleEntry], script: answer });
    // Barrier: the real scheduler fired the job (console.log "Executing scheduled prompt" path) and the agent settled.
    const fired = await pi.waitFor(e => e.type === 'agent_end', 60000, 'agent_end after scheduled fire');
    assert.ok(fired, 'precondition: scheduled job fired through the real host');
    await pi.finish(30000);
    const swept = !(await readStore(sb)).jobs.some(j => j.id === 'disabled-job');
    log(`sweptDisabledJob=${swept} nonJsonLines=${JSON.stringify(pi.badLines)} diagOnStderr=${DIAG.test(pi.stderr)}`);
    assert.deepEqual(pi.badLines, [], 'every rpc stdout line must be a JSON record');
    assert.ok(!DIAG.test(pi.stdout), 'extension diagnostics must not be written to stdout');
  } finally { await sb.cleanup(); }
});
