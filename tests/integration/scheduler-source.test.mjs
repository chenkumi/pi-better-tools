import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../helpers/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('Scheduler uses the TS entry and runs without any dist artifacts', { timeout: 180000 }, async () => {
  assert.ok(manifest.pi.extensions.includes('./modules/scheduler/src/index.ts'));
  assert.ok(!manifest.pi.extensions.includes('./modules/scheduler/dist/extension.js'));
  assert.equal(manifest.bin['pi-scheduler'], './modules/scheduler/dist/runner.js', 'standalone CLI remains supported');
  // Stage under the repository only to resolve its declared development dependencies.
  // No dependency links or compiled artifacts; this is not a production-install test.
  const staged = await mkdtemp(join(root, '.scheduler-source-probe-'));
  const home = await mkdtemp(join(tmpdir(), 'pi-scheduler-source-home-'));
  try {
    await writeFile(join(staged, 'package.json'), JSON.stringify(manifest));
    const modules = join(root, 'modules');
    await cp(modules, join(staged, 'modules'), { recursive: true,
      filter: path => !relative(modules, path).split(/[\\/]/).some(part => ['dist', 'tests', 'scripts', 'node_modules'].includes(part)) });
    await assert.rejects(stat(join(staged, 'modules/scheduler/dist')), { code: 'ENOENT' });
    for (const mode of ['full', 'child']) {
      const modeHome = join(home, mode);
      const output = await runCommand(`source-only Scheduler ${mode}`, process.execPath,
        [join(root, 'tests/fixtures/smoke.mjs'), staged, mode],
        { cwd: root, env: isolatedEnv(modeHome), timeoutMs: 150000 });
      const result = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(result.loaded, true);
      assert.equal(result.extensions, manifest.pi.extensions.length);
      for (const name of ['schedule_create', 'schedule_update', 'schedule_status', 'schedule_cancel', 'schedule_delete']) assert.ok(result.tools.includes(name));
    }
  } finally {
    await rm(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
