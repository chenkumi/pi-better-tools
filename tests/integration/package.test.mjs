import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';

import { isolatedEnv } from '../helpers/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const expectedExtensions = manifest.pi.extensions.length;
const modules = (await readdir(join(root, 'modules'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
const dependencyEntries = [
  './node_modules/pi-open-tui/extensions/open-tui/index.ts',
  './node_modules/@ff-labs/pi-fff/src/index.ts',
];
assert.deepEqual([...manifest.pi.extensions].sort(), [...modules.map(name => `./modules/${name}/src/index.ts`), ...dependencyEntries].sort());
assert.equal(expectedExtensions, 14, 'twelve local entries plus two pinned dependency entries');
assert.ok(manifest.pi.extensions.includes('./modules/monitor/src/index.ts'));
// Each mode spawns an isolated Pi host in its own home, so modes can overlap.
describe('all manifest extensions', { concurrency: 4 }, () => {
for (const mode of ['full', 'read-only', 'no-tools', 'exclude', 'brave', 'exa', 'invalid']) {
  test(`all manifest extensions: ${mode}`, { timeout: 180000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-better-tools-test-'));
    try {
      const output = await runCommand(`all-modules ${mode}`, process.execPath, [join(root, 'tests/fixtures/smoke.mjs'), root, mode], { cwd: home, env: isolatedEnv(home), timeoutMs: 150000 });
      const result = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(result.loaded, true); assert.equal(result.extensions, expectedExtensions); assert.equal(result.prompts, 3);
    } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}
});
