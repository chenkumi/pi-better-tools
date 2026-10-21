// Foreground auto-background safety net: a foreground command without timeoutMs is adopted by a background job
// after autoBackgroundMs (default 180000). Real extension + real host bash definition, fake process backend,
// event-driven (no waiting for the real threshold).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { root } from '../../../tests/helpers/regression/run-cli.mjs';

const exec = promisify(execFile);
let observed;
async function childResult() {
  if (observed) return observed;
  const dir = await mkdtemp(join(tmpdir(), 'auto-bg-'));
  try {
    console.error('[auto-bg] running child (fake process backend)...');
    const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(new URL('./fixtures/auto-background-host.mjs', import.meta.url)), dir],
      { cwd: root, env: isolatedEnv(dir), timeout: 100000 });
    observed = JSON.parse(stdout.split('\n').find(line => line.startsWith('AUTO_BG_RESULT ')).slice('AUTO_BG_RESULT '.length));
    console.error(`[auto-bg] ${JSON.stringify(observed)}`);
    return observed;
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
}

test('a command that finishes before the threshold stays an ordinary foreground result', { timeout: 120000 }, async () => {
  const { fast } = await childResult();
  assert.equal(fast.threw, false); assert.match(fast.text, /fast/); assert.equal(fast.receipt, undefined);
});

test('a still-running command is adopted by a background job and keeps its output across the handoff', { timeout: 120000 }, async () => {
  const { slowReceipt, slowFinal } = await childResult();
  assert.equal(slowReceipt.hasReceipt, true);
  assert.match(slowReceipt.text, /moved to a background job automatically/);
  assert.match(slowReceipt.text, /the same process keeps running/);
  assert.equal(slowFinal.status, 'completed'); assert.equal(slowFinal.exitCode, 0);
  assert.match(slowFinal.output, /early/, 'output produced before the handoff is replayed into the job');
  assert.match(slowFinal.output, /late/, 'output produced after the handoff reaches the job');
});

test('turn abort after the handoff does not kill the adopted process', { timeout: 120000 }, async () => {
  const { turnAbortAfterHandoff } = await childResult();
  assert.equal(turnAbortAfterHandoff.processAborted, false);
  assert.equal(turnAbortAfterHandoff.status, 'completed');
});

test('shell_job_cancel stops the adopted process', { timeout: 120000 }, async () => {
  const { jobCancel } = await childResult();
  assert.equal(jobCancel.processAborted, true);
  assert.equal(jobCancel.status, 'cancelled');
});

test('turn abort before the threshold still kills the foreground command and creates no job', { timeout: 120000 }, async () => {
  const { abortBeforeHandoff } = await childResult();
  assert.equal(abortBeforeHandoff.threw, true); assert.equal(abortBeforeHandoff.aborted, true); assert.equal(abortBeforeHandoff.newJobs, 0);
});

test('the detach shortcut moves a running foreground command to a background job without restarting it', { timeout: 120000 }, async () => {
  const { manualDetach } = await childResult();
  assert.equal(manualDetach.key, 'alt+j');
  assert.match(manualDetach.idleNotice, /No running foreground/);
  assert.match(manualDetach.statusWhileRunning, /Alt\+J/);
  assert.equal(manualDetach.statusAfter, undefined, 'the hint is cleared once the command is detached');
  assert.match(manualDetach.notice, /Moving 1 running foreground/);
  assert.equal(manualDetach.hasReceipt, true);
  assert.match(manualDetach.text, /at the user's request/);
  assert.equal(manualDetach.status, 'completed');
  assert.match(manualDetach.output, /early/); assert.match(manualDetach.output, /after/);
});
