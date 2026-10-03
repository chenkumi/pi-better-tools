import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePackManifest, runCommand, runNpm } from '../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../tests/helpers/environment.mjs';
import { runChildSmoke } from '../tests/helpers/child-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'plan/evidence');
const heartbeat = setInterval(() => console.log('[package] Validation or cleanup still running...'), 10000);
const hosts = [];
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] !== '--host' || !/^\d+\.\d+\.\d+$/.test(process.argv[i + 1] ?? '')) throw new Error('Usage: package-smoke.mjs [--host x.y.z]...');
  hosts.push(process.argv[i + 1]);
}
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!hosts.length) hosts.push(rootManifest.devDependencies['@earendil-works/pi-coding-agent']);
await mkdir(evidence, { recursive: true });
const results = [];
const report = { status: 'running', node: process.version, platform: process.platform, hosts, results, scope: 'production tarball runtime smoke, not full source regression or paid backend verification' };
const logs = [];
async function record(label, action) {
  const startedAt = new Date().toISOString();
  try {
    const output = await action();
    logs.push(`=== ${label} ===\n${typeof output === 'string' ? output : JSON.stringify(output) ?? ''}`);
    results.push({ label, status: 'passed', startedAt, endedAt: new Date().toISOString() });
    return output;
  } catch (error) {
    logs.push(`=== ${label}: FAILED ===\n${error.stack ?? error}`);
    results.push({ label, status: 'failed', startedAt, endedAt: new Date().toISOString(), error: String(error.message ?? error) });
    throw error;
  } finally {
    await writeFile(join(evidence, 'package.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(evidence, 'package.log'), logs.join('\n') + '\n');
  }
}
const required = [
  ...['subagents', 'shell-tools', 'file-tools', 'web-tools', 'scheduler', 'note-tools', 'gpt-speed', 'goal', 'json-schema'].flatMap(name => [`modules/${name}/src/index.ts`, `modules/${name}/README.md`]),
  'modules/subagents/extensions/subagent/index.ts', 'modules/subagents/extensions/subagent/child-guard.ts',
  'modules/subagents/agents/planner.md', 'modules/subagents/agents/reviewer.md', 'modules/subagents/agents/scout.md', 'modules/subagents/agents/worker.md',
  'modules/subagents/prompts/implement.md', 'modules/subagents/prompts/implement-and-review.md', 'modules/subagents/prompts/scout-and-plan.md',
  'modules/shell-tools/extensions/timeout-ms.ts', 'modules/file-tools/extensions/file-tools.ts', 'modules/file-tools/src/diff-worker.mjs',
  'modules/web-tools/src/index.ts', 'modules/web-tools/schemas/web_search.schema.json', 'modules/scheduler/src/extension.ts', 'modules/scheduler/package.json', 'modules/scheduler/dist/runner.js',
  'modules/note-tools/extensions/note.ts', 'modules/note-tools/README.md',
  'modules/gpt-speed/extensions/gpt-speed.ts', 'modules/gpt-speed/README.md',
  'modules/goal/extensions/goal.ts', 'modules/goal/src/state.ts', 'modules/goal/src/controller.ts', 'modules/goal/src/prompts.ts', 'modules/goal/README.md',
  'modules/json-schema/extensions/json-schema.ts', 'modules/json-schema/src/index.ts', 'modules/json-schema/src/schema.ts', 'modules/json-schema/src/extract.ts', 'modules/json-schema/src/delivery.ts', 'modules/json-schema/README.md',
  // The integrated package is licensed by the root LICENSE. Original module
  // notices remain preserved, but duplicate module LICENSE files are not required.
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/configuration.md',
];
function checkContents(pack) {
  const paths = pack.files.map(f => f.path);
  for (const path of required) assert.ok(paths.includes(path), `missing tarball resource ${path}`);
  for (const path of paths) {
    assert.ok(!isAbsolute(path) && !path.split('/').includes('..'), `unsafe package path ${path}`);
    assert.ok(!/(^|\/)(node_modules|tests|plan|scripts|\.git)(\/|$)/.test(path), `development content leaked: ${path}`);
    assert.ok(!/package-lock\.json$/.test(path));
  }
}
try {
  await record('build', () => runNpm('package build', ['run', 'build'], { cwd: root, timeoutMs: 180000 }));
  await record('pack:dry-run', async () => {
    const pack = parsePackManifest(await runNpm('package dry-run', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, timeoutMs: 120000, quiet: true }), rootManifest);
    checkContents(pack);
    return pack;
  });
  const packed = await record('pack:tarball', async () => {
    const pack = parsePackManifest(await runNpm('real package tarball', ['pack', '--ignore-scripts', '--json', '--pack-destination', evidence], { cwd: root, timeoutMs: 120000, quiet: true }), rootManifest);
    checkContents(pack);
    return pack;
  });
  const tarball = join(evidence, packed.filename);
  report.tarball = { filename: packed.filename, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), files: packed.files.length, bytes: packed.size };
  for (const version of hosts) {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-better-tools-production-')));
    try {
      const bootstrapHome = join(temp, 'bootstrap'); await mkdir(bootstrapHome);
      const env = isolatedEnv(bootstrapHome);
      await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'pi-better-tools-production-probe', version: '1.0.0', private: true, type: 'module' }));
      const hostPackages = ['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-tui'].map(name => `@earendil-works/${name}@${version}`);
      await record(`${version}:production-install`, () => runNpm(`production dependency install Pi ${version}`, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball, ...hostPackages, 'typebox@1.3.27'], { cwd: temp, env, timeoutMs: 600000 }));
      const packageRoot = join(temp, 'node_modules/pi-better-tools');
      const host = join(temp, 'node_modules/@earendil-works/pi-coding-agent');
      await record(`${version}:production-tree`, async () => {
        assert.equal(await realpath(packageRoot), packageRoot);
        const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
        const hostManifest = JSON.parse(await readFile(join(host, 'package.json'), 'utf8'));
        assert.equal(hostManifest.version, version);
        for (const peer of Object.keys(installed.peerDependencies)) assert.equal(installed.dependencies[peer], undefined);
        for (const dev of ['typescript', 'tsx', 'vitest']) await assert.rejects(stat(join(temp, 'node_modules', dev)), { code: 'ENOENT' });
        for (const path of required) assert.ok((await stat(join(packageRoot, path))).isFile(), path);
        const worker = await realpath(join(packageRoot, 'modules/file-tools/src/diff-worker.mjs'));
        assert.ok(!relative(packageRoot, worker).startsWith('..'));
        return JSON.stringify({ installedVersion: installed.version, hostVersion: hostManifest.version, developmentDependenciesAbsent: true });
      });
      const jsonFixture = join(temp, 'json-schema-runtime.mjs'); await copyFile(join(root, 'tests/fixtures/json-schema-runtime.mjs'), jsonFixture);
      const jsonProvider = join(temp, 'json-schema-provider.ts'); await copyFile(join(root, 'tests/fixtures/json-schema-provider.ts'), jsonProvider);
      const jsonHome = join(temp, 'home-json-schema'); await mkdir(jsonHome);
      await record(`${version}:json-schema-runtime`, async () => {
        const output = await runCommand(`production Pi ${version} json-schema-runtime`, process.execPath, [jsonFixture, packageRoot, jsonProvider], { cwd: jsonHome, env: { ...isolatedEnv(jsonHome), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 240000 });
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.hostVersion, version); assert.equal(result.status, 'passed'); assert.ok(result.cases.length >= 30); assert.ok(result.cases.every(c => c.status === 'passed')); return output;
      });
      // Run the independent goal lifecycle before broad probes, so an unrelated
      // module fault cannot hide whether this host admitted the new extension.
      const goalFixture = join(temp, 'goal-runtime.mjs'); await copyFile(join(root, 'tests/fixtures/goal-runtime.mjs'), goalFixture);
      const goalHome = join(temp, 'home-goal'); await mkdir(goalHome);
      await record(`${version}:goal-runtime`, () => runCommand(`production Pi ${version} goal-runtime`, process.execPath, [goalFixture, packageRoot], { cwd: goalHome, env: { ...isolatedEnv(goalHome), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 150000 }));
      const hooksFixture = join(temp, 'sdk-hooks.mjs'); await copyFile(join(root, 'tests/fixtures/sdk-hooks.mjs'), hooksFixture);
      const hooksHome = join(temp, 'home-sdk-hooks'); await mkdir(hooksHome);
      await record(`${version}:sdk-hooks`, async () => {
        const output = await runCommand(`production Pi ${version} sdk-hooks`, process.execPath, [hooksFixture, packageRoot, version], { cwd: hooksHome, env: { ...isolatedEnv(hooksHome), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 210000 });
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.hostVersion, version); assert.equal(result.status, 'passed'); assert.equal(result.cases.length, 12);
        assert.ok(result.cases.every(item => item.status === 'passed')); assert.equal(new Set(result.cases.map(item => item.name)).size, 12);
        assert.equal(result.hooksObserved.length, 21); assert.equal(new Set(result.hooksObserved).size, 21); return output;
      });
      const fixture = join(temp, 'smoke.mjs'); await copyFile(join(root, 'tests/fixtures/smoke.mjs'), fixture);
      for (const mode of ['full', 'read-only', 'no-tools', 'exclude', 'brave', 'exa', 'invalid', 'child']) {
        const home = join(temp, `home-${mode}`); await mkdir(home);
        await record(`${version}:${mode}`, () => runCommand(`production Pi ${version} ${mode}`, process.execPath, [fixture, packageRoot, mode], { cwd: home, env: { ...isolatedEnv(home), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 150000 }));
      }
      await record(`${version}:managed-child`, () => runChildSmoke({ home: join(temp, 'home-managed-child'), host, packageRoot, evidence: join(evidence, `package-${version}-managed-child.jsonl`) }));
      await record(`${version}:runner-bin`, async () => {
        const output = await runCommand(`production runner ${version}`, process.execPath, [join(packageRoot, 'modules/scheduler/dist/runner.js'), 'status', '--agent-dir', join(bootstrapHome, '.pi/agent')], { cwd: bootstrapHome, env, timeoutMs: 30000 });
        const data = JSON.parse(output); assert.equal(data.running, false); assert.equal(data.activeChildren, 0); assert.equal(data.schedules, 0);
        return output;
      });
    } catch (error) {
      // Keep the failed stage and nonzero exit, but still inspect other hosts.
      // No assertion/time limit is relaxed; later probes for this host are unrun.
      report.status = 'failed'; report.error = String(error.stack ?? error);
      console.error(error.stack ?? error); process.exitCode = 1;
    } finally {
      console.log(`[package] Cleaning isolated production installation for ${version}...`);
      await record(`${version}:cleanup`, async () => { await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); return 'Owned production directory removed.'; });
    }
  }
  report.status = results.some(result => result.status === 'failed') ? 'failed' : 'passed';
  console.log(`[package] ${hosts.join(', ')} production tarball smoke completed (${report.status}); evidence: ${evidence}`);
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error);
  console.error(error.stack ?? error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try { await writeFile(join(evidence, 'package.json'), JSON.stringify(report, null, 2) + '\n'); }
  finally { clearInterval(heartbeat); }
}
