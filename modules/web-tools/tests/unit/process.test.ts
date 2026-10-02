import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isolatedEnv, runCommand } from '../../scripts/process.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
test('isolated environment retains OS essentials but no provider keys/config override', () => {
  const env = isolatedEnv(join(tmpdir(), 'isolated-home'));
  assert.ok(env.PATH ?? env.Path);
  for (const name of ['OPENAI_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'PI_WEB_TOOLS_CONFIG']) assert.equal(env[name], undefined);
  assert.equal(env.PI_OFFLINE, '1');
  if (process.platform === 'win32') assert.ok(env.SystemRoot ?? env.SYSTEMROOT);
});

test('explicit config path does not silently follow agentDir; empty/relative override fails closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-web-config-env-'));
  try {
    const agentDir = join(home, 'different-agent'); await mkdir(agentDir);
    const config = join(agentDir, 'custom-search.json');
    await writeFile(config, JSON.stringify({ provider: 'brave', providers: { openai: { captureSources: true } } }));
    const source = `const { CONFIG_PATH, loadConfig } = await import(${JSON.stringify(new URL('../../src/config.ts', import.meta.url).href)});\ntry { const config = loadConfig(); console.log(JSON.stringify({path:CONFIG_PATH,provider:config.provider,capture:config.providers.openai.captureSources})); } catch(e) { console.log(JSON.stringify({error:e.message})); }`;
    const execute = async (override?: string) => {
      const env = { ...isolatedEnv(home), PI_CODING_AGENT_DIR: agentDir, ...(override !== undefined ? { PI_WEB_TOOLS_CONFIG: override } : {}) };
      const result = await runCommand(process.execPath, ['--input-type=module', '-e', source], { cwd: home, env, label: 'Configuration-path contract', timeoutMs: 10000 });
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(await execute(config), { path: config, provider: 'brave', capture: true });
    assert.deepEqual(await execute(), { path: join(home, '.pi', 'agent', 'web-search.json'), provider: 'openai', capture: false });
    for (const invalid of ['', 'relative/SECRET.json']) {
      const result = await execute(invalid);
      assert.match(result.error, /CONFIG_INVALID.*path must be absolute/);
      assert.ok(!result.error.includes('SECRET'));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('deadline kills owned root and detached grandchild holding pipes, with a bounded final wait', { timeout: 15000 }, async () => {
  let failure: Error | undefined;
  const start = performance.now();
  try {
    await runCommand(process.execPath, [join(root, 'tests/fixtures/timeout-tree.mjs')], {
      cwd: root, label: 'Owned process-tree timeout fixture', timeoutMs: 1500,
    });
    assert.fail('fixture must exceed its deadline');
  } catch (e) { failure = e as Error; }
  const pids = [...failure!.message.matchAll(/(?:root|grand):(\d+)/g)].map(m => Number(m[1]));
  try {
    assert.match(failure!.message, /failed \(timeout\)/);
    assert.equal(pids.length, 2, failure!.message);
    assert.ok(performance.now() - start < 10000, 'deadline cleanup must not hang on inherited pipes');
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        // Linux PID 1 may briefly retain a zombie; it is terminated, not running.
        assert.equal(process.platform, 'linux');
        assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.+\) Z /);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH' && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  } finally {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* already terminated */ }
  }
});
