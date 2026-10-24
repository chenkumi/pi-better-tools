// Edge cases of the foreground auto-background safety net (see auto-background.integration.test.mjs for the base cases).
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
  const dir = await mkdtemp(join(tmpdir(), 'auto-bg-edge-'));
  try {
    console.error('[auto-bg-edge] running child (fake process backend)...');
    const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(new URL('./fixtures/auto-background-edge-host.mjs', import.meta.url)), dir],
      { cwd: root, env: isolatedEnv(dir), timeout: 100000 });
    observed = JSON.parse(stdout.split('\n').find(line => line.startsWith('AUTO_BG_EDGE_RESULT ')).slice('AUTO_BG_EDGE_RESULT '.length));
    console.error(`[auto-bg-edge] ${JSON.stringify(observed)}`);
    return observed;
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
}

test('the documented no-timeout sentinel is an unbounded run: the safety net still adopts it', { timeout: 120000 }, async () => {
  const { sentinel } = await childResult();
  assert.equal(sentinel.settled, true, 'the sentinel command is handed to a background job like one without timeoutMs');
  assert.equal(sentinel.receipt, true);
  assert.match(sentinel.text, /moved to a background job automatically/);
});

test('a rejected automatic handoff is retried and the call stays detachable while it waits', { timeout: 120000 }, async () => {
  const { capacity } = await childResult();
  assert.equal(capacity.activeReceipts, 8);
  assert.equal(capacity.settledWhileFull, false, 'no room: the command stays in the foreground');
  assert.equal(capacity.detachableWhileFull, true, 'Alt+J / steer handoff stays available after the rejection');
  assert.equal(capacity.settledAfterRoom, true, 'once a slot frees up the same process is adopted');
  assert.equal(capacity.receipt, true);
  assert.match(capacity.text, /moved to a background job automatically/);
});
