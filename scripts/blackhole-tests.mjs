import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../tests/helpers/environment.mjs';
import { runCommand } from '../modules/file-tools/scripts/test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'pi-blackhole-unit-'));
try {
  const env = isolatedEnv(home);
  await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
  // HOME remains isolated, but SDK-mocked unit cases own their agentDir. Inherited
  // explicit overrides take precedence over getAgentDir() and bypass those mocks.
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_AGENT_DIR;
  env.PI_BLACKHOLE_UNIT_ISOLATED = '1';
  // Keep the source runner and aliases; permit file filters for repair evidence.
  const output = await runCommand('blackhole upstream Vitest', process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--root', 'modules/blackhole', '--maxWorkers=2', ...process.argv.slice(2)],
    { cwd: root, env, timeoutMs: 600000 });
  process.stdout.write(output);
} finally {
  console.log('[blackhole] Cleaning isolated test home...');
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
