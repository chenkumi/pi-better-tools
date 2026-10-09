import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../helpers/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('Schedule Prompt endAt: real Pi 1.1.0 loader, tool schema and session lifecycle', { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-schedule-deadline-host-'));
  try {
    const output = await runCommand('schedule-prompt deadline host', process.execPath,
      [join(root, 'tests/fixtures/schedule-deadline.mjs'), root], { cwd: home, env: isolatedEnv(home), timeoutMs: 150000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.passed, true);
    assert.equal(result.hostVersion, '1.1.0');
    assert.deepEqual(result.checks, ['startup', 'schema-null', 'add', 'update', 'enable', 'session-reinitialize', 'no-provider']);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
