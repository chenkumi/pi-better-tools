import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/deadline-host.mjs', import.meta.url));
const cases = {
  reported: 'the model is asked shortly before the threshold, answers with the anchor, and the report is in the summary\'s timeline after Pi\'s compaction',
  missed: 'a single turn that jumps over the threshold gets no request',
};
for (const [scenario, title] of Object.entries(cases)) test(`Pi 1.5.0 Pi Auto Compact deadline savepoint: ${title}`, { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-auto-compact-deadline-host-')); await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand(`pi-auto-compact deadline-host ${scenario}`, process.execPath, ['--import', import.meta.resolve('tsx'), fixture, scenario],
      { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp') }, timeoutMs: 150000 });
    const result = JSON.parse(output.trim().split(String.fromCharCode(10)).at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.host, '1.5.0'); assert.equal(result.scenario, scenario);
    assert.equal(result.compactions, 1);
    assert.equal(result.requests, scenario === 'reported' ? 1 : 0);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
