import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';
const fixture = fileURLToPath(new URL('./fixtures/host.ts', import.meta.url));
for (const mode of ['shell-first', 'monitor-first']) test(`real offline Pi1.1.0 Monitor load order ${mode}`, { timeout: 120000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-monitor-host-')); await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand(`monitor host ${mode}`, process.execPath, ['--import', import.meta.resolve('tsx'), fixture, mode], { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') }, timeoutMs: 90000 });
    const result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.status, 'passed'); assert.equal(result.host, '1.1.0'); assert.equal(result.providerCalls, 0); assert.equal(result.childClosed, true);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
