import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../helpers/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@earendil-works/pi-coding-agent'];
test('real SDK hook ordering, reload selection, pending tools and prompt composition', { timeout: 240000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-better-sdk-hooks-'));
  const heartbeat = setInterval(() => console.log('[sdk-hooks-test] Offline regression or cleanup still running...'), 10000);
  try {
    const output = await runCommand('all-modules:sdk-hooks', process.execPath, [join(root, 'tests/fixtures/sdk-hooks.mjs'), root, expectedVersion],
      { cwd: home, env: isolatedEnv(home), timeoutMs: 210000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.hostVersion, expectedVersion); assert.equal(result.status, 'passed');
    assert.equal(result.cases.length, 12); assert.equal(new Set(result.cases.map(item => item.name)).size, 12);
    assert.ok(result.cases.every(item => item.status === 'passed'));
    assert.equal(result.hooksObserved.length, 21); assert.equal(new Set(result.hooksObserved).size, 21);
    await writeFile(join(root, 'plan/evidence/pi-100-hooks-runtime.json'), JSON.stringify(result, null, 2) + '\n');
  } finally {
    try { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    finally { clearInterval(heartbeat); }
  }
});
