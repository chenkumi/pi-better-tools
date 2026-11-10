import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';


const deadlineFixture = fileURLToPath(new URL('./fixtures/deadline-timing-host.mjs', import.meta.url));
const deadlineCases = {
  fits: 'a request appended with room to spare is answered before the compaction and its answer survives it',
  overshoot: 'a request appended when the size is already over the threshold is answered after the compaction, on the summary only',
  baseline: 'without a request the compaction runs right after the turn that crossed the threshold',
  'edge-over': 'the threshold check counts the appended draft, so a size just under it still compacts before the answer',
  'edge-under': 'with the draft fitting under the threshold, the request is answered and no compaction runs',
};
for (const [scenario, title] of Object.entries(deadlineCases)) test(`Pi 1.5.2 savepoint timing: ${title}`, { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-auto-compact-deadline-')); await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand(`pi-auto-compact deadline ${scenario}`, process.execPath, ['--import', import.meta.resolve('tsx'), deadlineFixture, scenario],
      { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp') }, timeoutMs: 150000 });
    const result = JSON.parse(output.trim().split(String.fromCharCode(10)).at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.host, '1.5.2'); assert.equal(result.scenario, scenario);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
