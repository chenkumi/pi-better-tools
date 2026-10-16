import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
const exec = promisify(execFile);
const host = process.env.PI_BETTER_TOOLS_HOST ?? dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
test('SHELL-01: adopted foreground execution remains cancellable across the deferred runner boundary', { timeout: 120000 }, async () => {
  for (let run = 1; run <= 3; run++) {
    const root = await mkdtemp(join(tmpdir(), 'handoff-cancel-'));
    try {
      console.error(`[handoff-cancel] isolated run ${run}/3`);
      const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(new URL('./fixtures/handoff-cancel-host.mjs', import.meta.url)), root, host], { env: isolatedEnv(root), timeout: 30000 });
      assert.match(stdout, /HANDOFF_CANCEL_PASS/);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
