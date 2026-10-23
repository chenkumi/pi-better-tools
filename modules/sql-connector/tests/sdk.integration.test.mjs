import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/sdk-host.mjs', import.meta.url));
for (const mode of ['search', 'fallback', 'untrusted', 'absent', 'invalid', 'read-only', 'no-tools', 'exclude']) {
  test(`SQL Connector real Pi discovery: ${mode}`, { timeout: 120000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'sql-connector-sdk-'));
    try {
      const output = await runCommand(`SQL Connector ${mode}`, process.execPath, [fixture, root, mode], { cwd: home, env: isolatedEnv(home), timeoutMs: 90000 });
      const result = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(result.status, 'passed');
      assert.equal(result.host, '1.4.0');
      assert.equal(result.networkCalls, 0);
      assert.equal(result.databaseConnections, 0);
    } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}
