import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('Pi 1.1.0 bounded recovery, policy approval, cancellation, repeat, reload and no-session contracts', { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-runtime-host-')); await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand('pi-runtime offline host', process.execPath,
      [join(root, 'modules/pi-runtime/tests/fixtures/runtime-host.mjs'), root],
      { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') }, timeoutMs: 150000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.host, '1.1.0'); assert.equal(result.providerCalls, 0);
    assert.deepEqual(result.cases.map(c => c.mode), ['success', 'limit', 'repeat', 'transform', 'template', 'policy', 'cancel', 'reload', 'no-session', 'tree', 'handled', 'preflight', 'withdrawn', 'safety']); assert.ok(result.cases.every(c => c.status === 'passed'));
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
