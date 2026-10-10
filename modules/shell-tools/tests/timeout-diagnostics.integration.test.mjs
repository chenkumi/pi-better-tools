// Regression D17: shell-tools rewrites the FIRST "Command timed out after N seconds" anywhere in a host error into an idle-timeout message,
// and classifies background job terminal state from the error tail.
// Levels:
//   A. real Pi 1.1.0 CLI + real bash: a genuinely failing command (exit 3, no timeout) whose OUTPUT contains the phrase.
//   B. degraded (child process, mock.module): real extension + real host bash definition, only the process backend is faked so a host
//      `timeout:N` error and fake output can be produced instantly (no idle waiting). Covers real-timeout and background classification.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { makeSandbox, root, runCli } from '../../../tests/helpers/regression/run-cli.mjs';

const exec = promisify(execFile);
const IDLE = '(timeoutMs idle timeout)';

test('D17-A real CLI (control): host reports a non-zero exit as a result, not a thrown error, so output containing the phrase stays intact', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('d17-a');
  try {
    const command = `node -e "console.log('Command timed out after 1 seconds'); process.exit(3)"`;
    const script = [{ content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command, timeoutMs: 30000 } }] }, { content: [{ type: 'text', text: 'done' }] }];
    const run = await runCli(sb, { script, label: 'D17-A', extensions: [join(root, 'modules/shell-tools/src/index.ts')], args: ['--tools', 'bash'] });
    assert.equal(run.requests.length, 2, `stderr=${run.stderr}`);
    const result = run.requests[1].messages.find(m => m.role === 'toolResult' && m.toolName === 'bash');
    const text = result.content.map(b => b.text ?? '').join('');
    console.error(`[D17-A] isError=${result.isError} text=${JSON.stringify(text)}`);
    assert.equal(result.isError, true);
    assert.match(text, /Command exited with code 3/, 'real failure status must be preserved');
    assert.match(text, /^Command timed out after 1 seconds/m, 'command output must be preserved verbatim');
    assert.ok(!text.includes(IDLE), 'a command that exited with code 3 must not be reported as an idle timeout');
  } finally { await sb.cleanup(); }
});

let observed;
async function childResult() {
  if (observed) return observed;
  const dir = await mkdtemp(join(tmpdir(), 'repro-d17-'));
  try {
    console.error('[repro:D17-B] running degraded child (fake process backend)...');
    const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(new URL('./fixtures/timeout-diagnostics-host.mjs', import.meta.url)), dir],
      { cwd: root, env: isolatedEnv(dir), timeout: 100000 });
    const line = stdout.split('\n').find(l => l.startsWith('D17_RESULT '));
    observed = JSON.parse(line.slice('D17_RESULT '.length));
    console.error(`[D17-B] ${JSON.stringify(observed)}`);
    return observed;
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
}

test('D17-B2 degraded: real idle timeout after output containing the phrase keeps output and rewrites only the host tail', { timeout: 120000 }, async () => {
  const r = (await childResult()).foregroundRealTimeoutAfterMarkerOutput;
  assert.equal(r.threw, true);
  assert.match(r.text, /^Command timed out after 5 seconds/m, 'earlier command output must not be rewritten');
  assert.match(r.text, /no output for 1 seconds \(timeoutMs idle timeout\)/, 'the real trailing host diagnostic must become the idle message');
  assert.equal(r.text.split(IDLE).length - 1, 1, `diagnostic must be rewritten exactly once (idempotent across both catch layers): ${r.text}`);
  assert.ok(!/Command timed out after 1 seconds\s*$/.test(r.text), `host absolute-timeout tail left unconverted: ${r.text}`);
});

test('D17-B3 degraded: background job with a real idle timeout is classified timed_out even if output contains the phrase', { timeout: 120000 }, async () => {
  const r = (await childResult()).backgroundRealTimeoutAfterMarkerOutput;
  assert.equal(r.status, 'timed_out', `job error=${JSON.stringify(r.error)}`);
});

test('D17-B4 degraded control: a failed background command whose OUTPUT ends with the idle marker is not forged into timed_out', { timeout: 120000 }, async () => {
  const r = (await childResult()).backgroundForgedIdleMarkerOutput;
  assert.equal(r.status, 'failed', `job error=${JSON.stringify(r.error)}`);
  assert.equal(r.exitCode, 1);
});

test('D17-B5 degraded: user cancel after output containing the phrase keeps output and the host "Command aborted" tail', { timeout: 120000 }, async () => {
  const r = (await childResult()).foregroundAbortAfterMarkerOutput;
  assert.equal(r.threw, true);
  assert.match(r.text, /^Command timed out after 4 seconds/m, 'command output must be preserved verbatim');
  assert.match(r.text, /Command aborteds*$/);
  assert.ok(!r.text.includes(IDLE), `user cancellation reported as idle timeout: ${r.text}`);
});
