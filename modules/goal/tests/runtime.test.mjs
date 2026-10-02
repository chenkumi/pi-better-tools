import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const expectedPiVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@earendil-works/pi-coding-agent'];
test('real Pi goal-first offline lifecycle and fault regression', { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-better-goal-runtime-'));
  try {
    const output = await runCommand('goal:real-pi-runtime', process.execPath, [join(root, 'tests/fixtures/goal-runtime.mjs'), root], { cwd: home, env: isolatedEnv(home), timeoutMs: 150000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.hostVersion, expectedPiVersion); assert.equal(result.status, 'passed'); assert.ok(result.cases.length >= 18); assert.ok(result.cases.every(c => c.status === 'passed'));
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
