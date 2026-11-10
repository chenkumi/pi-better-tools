import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/real-host.mjs', import.meta.url));
const cases = {
  full: 'real compaction is persisted, references resolve, resume is exact, window start is kept and session tools read it',
  'invalid-config': 'an invalid settings file leaves compaction to Pi, which produces and persists its own summary',
  'unknown-window': 'an unknown context window leaves compaction to Pi, which produces and persists its own summary',
};
for (const [scenario, title] of Object.entries(cases)) test(`Pi 1.5.2 Pi Auto Compact: ${title}`, { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-auto-compact-host-')); await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand(`pi-auto-compact host ${scenario}`, process.execPath, ['--import', import.meta.resolve('tsx'), fixture, scenario],
      { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp') }, timeoutMs: 150000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.host, '1.5.2');
    if (scenario === 'full') assert.equal(result.providerCalls, 0); else assert.equal(result.nativeSummary, true);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
