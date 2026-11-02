import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../helpers/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('Web static fetch/File read component composition', { timeout: 120000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-better-tools-web-read-'));
  try {
    const output = await runCommand('web-read', process.execPath, ['--import', import.meta.resolve('tsx'), join(root, 'tests/fixtures/browser.mjs'), root],
      { cwd: home, env: isolatedEnv(home), timeoutMs: 100000 });
    assert.match(output, /"fetched":true.*"paginatedRead":true/);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
});
