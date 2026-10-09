import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/notification-batching-host.mjs', import.meta.url));
for (const mode of ['normal', 'queued', 'aborted', 'preflight-failed']) test(`Pi 1.1.0 ${mode}: completed Shell results enter one native notification and one model request`, { timeout: 120000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-shell-batching-'));
  await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand(`shell batching ${mode}`, process.execPath, ['--import', import.meta.resolve('tsx'), fixture, mode], {
      cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') }, timeoutMs: 90000,
    });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.host, '1.1.0'); assert.equal(result.mode, mode);
    assert.equal(result.notifications, 1); assert.equal(result.jobs, mode === 'preflight-failed' ? 1 : 5); assert.equal(result.providerCalls, 0);
    assert.equal(result.fixtureModelCalls, mode === 'normal' ? 3 : mode === 'queued' ? 4 : mode === 'aborted' ? 2 : 1);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
