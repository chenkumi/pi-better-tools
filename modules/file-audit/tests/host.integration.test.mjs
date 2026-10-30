import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const mode of ['native', 'files', 'standalone', 'excluded']) {
  test(`Pi 1.4.0 File Audit: ${mode}`, { timeout: 120000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), `pi-file-audit-${mode}-`));
    await mkdir(join(home, 'tmp'));
    try {
      const output = await runCommand(`file-audit ${mode}`, process.execPath,
        [join(root, 'modules/file-audit/tests/fixtures/host.mjs'), root, mode],
        { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') }, timeoutMs: 110000 });
      const result = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(result.status, 'passed'); assert.equal(result.host, '1.4.0'); assert.equal(result.networkCalls, 0);
      if (['files', 'native'].includes(mode)) assert.deepEqual(result.cases, ['success-and-final-errors', 'note-read-edit-dedup',
        'nested-note-and-read', 'manual-check', 'change-notice', 'window', 'reload', 'tree', 'new-and-resume']);
    } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}
