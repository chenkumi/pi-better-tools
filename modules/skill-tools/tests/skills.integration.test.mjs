import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('Pi skill discovery, reload, package relocation, command expansion and extension filtering', { timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-skills-host-'));
  await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand('skills offline host', process.execPath,
      [join(root, 'modules/skill-tools/tests/fixtures/skills-host.mjs'), root],
      { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') }, timeoutMs: 50000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.status, 'passed');
    assert.equal(result.host, '1.1.0');
    assert.equal(result.providerCalls, 0);
    assert.deepEqual(result.cases, ['startup', 'reload', 'relocated', 'lazy-body', 'skill-command', 'extension-filter', 'no-tools']);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
