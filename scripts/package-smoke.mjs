import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePackManifest, runCommand, runNpm } from '../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../tests/helpers/environment.mjs';
import { runChildSmoke } from '../tests/helpers/child-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceScope = process.env.PI_BETTER_TOOLS_EVIDENCE_SCOPE ?? '';
if (!/^[a-zA-Z0-9_-]*$/.test(evidenceScope)) throw new Error('Invalid evidence scope');
const evidence = join(root, 'plan/evidence', evidenceScope);
const heartbeat = setInterval(() => console.log('[package] Validation or cleanup still running...'), 10000);
if (process.argv.length > 2) throw new Error('Usage: package-smoke.mjs (only the pinned Pi host is supported)');
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const hosts = [rootManifest.devDependencies['@earendil-works/pi-coding-agent']];
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
  ...['subagents', 'shell-tools', 'file-tools', 'web-tools', 'note-tools', 'gpt-speed', 'json-schema', 'pty-terminal', 'schedule-prompt', 'blackhole', 'pi-runtime', 'monitor'].flatMap(name => [`modules/${name}/src/index.ts`, `modules/${name}/README.md`]),
  'modules/pi-runtime/src/policy.ts',
  ...['core', 'schema', 'lines', 'network', 'sources', 'renderers'].map(name => `modules/monitor/src/${name}.ts`),
  'modules/monitor/LICENSE', 'modules/monitor/package.json',
  'modules/shell-tools/src/monitor-capability.ts', 'modules/shell-tools/src/monitor-exec.ts', 'modules/shell-tools/src/monitor-publisher.ts',
  'modules/subagents/extensions/subagent/monitor-capability.ts',
  'modules/subagents/extensions/subagent/index.ts', 'modules/subagents/extensions/subagent/child-guard.ts',
  'modules/subagents/agents/planner.md', 'modules/subagents/agents/reviewer.md', 'modules/subagents/agents/scout.md', 'modules/subagents/agents/worker.md',
  'modules/subagents/prompts/implement.md', 'modules/subagents/prompts/implement-and-review.md', 'modules/subagents/prompts/scout-and-plan.md',
  'modules/shell-tools/extensions/timeout-ms.ts', 'modules/file-tools/extensions/file-tools.ts', 'modules/file-tools/src/diff-worker.mjs',
  'modules/web-tools/src/index.ts', 'modules/web-tools/schemas/web_search.schema.json',
  'modules/web-tools/src/renderers.ts', 'modules/web-tools/src/fetch/extract-core.mjs', 'modules/web-tools/src/fetch/extract-core.d.mts', 'modules/web-tools/src/fetch/extract-worker.mjs',
  'modules/pty-terminal/src/matcher.ts', 'modules/pty-terminal/src/match-worker.mjs',
  'modules/json-schema/src/pattern-policy.ts', 'modules/json-schema/src/validation-worker.mjs', 'modules/json-schema/src/validation-pool.ts',
  'modules/subagents/extensions/subagent/prompt-files.ts',
  'modules/file-tools/src/search-tools.ts',
  'modules/subagents/extensions/subagent/message-reservation.ts',
  'modules/note-tools/extensions/note.ts', 'modules/note-tools/README.md',
  'modules/gpt-speed/extensions/gpt-speed.ts', 'modules/gpt-speed/README.md',
  'modules/json-schema/extensions/json-schema.ts', 'modules/json-schema/src/index.ts', 'modules/json-schema/src/schema.ts', 'modules/json-schema/src/extract.ts', 'modules/json-schema/src/delivery.ts', 'modules/json-schema/README.md',
  // The integrated package is licensed by the root LICENSE. Original module
  // notices remain preserved, but duplicate module LICENSE files are not required.
  'modules/pty-terminal/src/targets.ts', 'modules/pty-terminal/src/pty-manager.ts', 'modules/pty-terminal/src/renderers.ts', 'modules/pty-terminal/src/install.mjs', 'modules/pty-terminal/README.md', 'modules/pty-terminal/LICENSE',
  'modules/schedule-prompt/src/scheduler.ts', 'modules/schedule-prompt/src/tool.ts', 'modules/schedule-prompt/src/subagent.ts', 'modules/schedule-prompt/LICENSE',
  'modules/blackhole/index.ts', 'modules/blackhole/package.json', 'modules/blackhole/LICENSE',
  'modules/blackhole/src/hooks/cosmetic-output.ts', 'modules/blackhole/src/changelog/changelog.ts',
  'modules/blackhole/CHANGELOG.md', 'modules/blackhole/example-config.json', 'modules/blackhole/llms.txt',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/configuration.md',
];
function checkContents(pack) {
  const paths = pack.files.map(f => f.path);
  assert.ok(!paths.some(path => path.startsWith('modules/goal/')), 'removed Goal module must not ship');
  assert.ok(!paths.some(path => path.startsWith('modules/scheduler/')), 'removed Scheduler module must not ship');
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
      // Isolated HOME/config and a pinned native-script policy; never grant all scripts.
      await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'pi-better-tools-production-probe', version: '1.0.0', private: true, type: 'module', allowScripts: { 'node-pty@1.2.0-beta.14': true } }));
      const hostPackages = ['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-tui'].map(name => `@earendil-works/${name}@${version}`);
      await record(`${version}:production-install`, () => runNpm(`production dependency install Pi ${version}`, ['install', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', tarball, ...hostPackages, 'typebox@1.3.27'], { cwd: temp, env, timeoutMs: 600000 }));
      const packageRoot = join(temp, 'node_modules/pi-better-tools');
      const host = join(temp, 'node_modules/@earendil-works/pi-coding-agent');
      // The supported workflow mounts a source directory with its own installed node_modules.
      // npm's outer tarball install may hoist dependencies; explicitly prepare the same local-source layout.
      // No development-tree links, bundled host peers or implicit lifecycle scripts are allowed.
      await record(`${version}:local-source-dependencies`, () => runNpm(`local-source runtime dependencies Pi ${version}`, ['install', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: packageRoot, env, timeoutMs: 600000 }));
      await record(`${version}:pty-native-setup`, () => runNpm(`native PTY setup Pi ${version}`, ['rebuild', 'node-pty'], { cwd: packageRoot, env, timeoutMs: 180000 }));
      await record(`${version}:production-tree`, async () => {
        assert.equal(await realpath(packageRoot), packageRoot);
        const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
        const hostManifest = JSON.parse(await readFile(join(host, 'package.json'), 'utf8'));
        assert.equal(hostManifest.version, version);
        for (const peer of Object.keys(installed.peerDependencies)) assert.equal(installed.dependencies[peer], undefined);
        for (const dev of ['typescript', 'tsx']) for (const base of [temp, packageRoot]) await assert.rejects(stat(join(base, 'node_modules', dev)), { code: 'ENOENT' });
        for (const [name, expected] of Object.entries({ 'pi-open-tui': '0.3.11', '@ff-labs/pi-fff': '0.11.0' })) {
          const dependencyRoot = join(packageRoot, 'node_modules', name);
          const dependency = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8'));
          assert.equal(dependency.version, expected);
          for (const entry of dependency.pi.extensions) assert.ok((await stat(resolve(dependencyRoot, entry))).isFile());
          for (const peer of ['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui']) await assert.rejects(stat(join(dependencyRoot, 'node_modules/@earendil-works', peer)), { code: 'ENOENT' });
        }
        for (const path of required) assert.ok((await stat(join(packageRoot, path))).isFile(), path);
        const worker = await realpath(join(packageRoot, 'modules/file-tools/src/diff-worker.mjs'));
        assert.ok(!relative(packageRoot, worker).startsWith('..'));
        return JSON.stringify({ installedVersion: installed.version, hostVersion: hostManifest.version, developmentDependenciesAbsent: true });
      });
      await record(`${version}:validation-workers`, async () => {
        async function probe(path, workerData) {
          const worker = new Worker(join(packageRoot, path), { workerData });
          const messages = [];
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`Worker failed to exit: ${path}`)), 10000);
              worker.on('message', message => messages.push(message));
              worker.once('error', error => { clearTimeout(timer); reject(error); });
              worker.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Worker exit ${code}`)); });
            });
            assert.equal(messages.length, 2);
            assert.deepEqual(messages[0], { ready: true });
            return messages[1];
          } finally { await worker.terminate(); }
        }
        assert.deepEqual(await probe('modules/pty-terminal/src/match-worker.mjs', { source: '^a+$', flags: '', input: 'aaa' }), { matched: true });
        // The JSON worker is reusable: require ready, two results on the same worker, then confirmed termination.
        const schema = { type: 'object', properties: { x: { type: 'string', pattern: '^a+$' } }, required: ['x'] };
        const worker = new Worker(join(packageRoot, 'modules/json-schema/src/validation-worker.mjs'));
        let exited = false;
        let timer;
        worker.once('exit', () => { exited = true; });
        try {
          const results = await new Promise((resolve, reject) => {
            let phase = 0;
            const results = [];
            timer = setTimeout(() => reject(new Error('Packaged reusable validation worker did not respond')), 10000);
            worker.once('error', reject);
            worker.once('exit', () => reject(new Error('Packaged validation worker exited before completion')));
            worker.on('message', message => {
              try {
                if (phase === 0) {
                  assert.deepEqual(message, { ready: true });
                  phase = 1;
                  worker.postMessage({ schema, data: { x: 'aaa' } });
                } else if (phase === 1) {
                  assert.equal(message.reason, undefined);
                  results.push(message);
                  phase = 2;
                  worker.postMessage({ schema, data: { x: '!' } });
                } else {
                  assert.equal(phase, 2, 'unexpected duplicate validation result');
                  assert.match(message.reason, /x/);
                  results.push(message);
                  phase = 3;
                  resolve(results);
                }
              } catch (error) { reject(error); }
            });
          });
          assert.equal(results.length, 2);
        } finally {
          clearTimeout(timer);
          await worker.terminate();
          assert.equal(exited, true, 'validation worker termination must be confirmed');
        }
        return 'Both packaged workers executed with ready handshakes; reusable validation and worker exits confirmed in clean production dependencies.';
      });
      await record(`${version}:extraction-worker`, async () => {
        const worker = new Worker(join(packageRoot, 'modules/web-tools/src/fetch/extract-worker.mjs'));
        let exited = false;
        let timer;
        worker.once('exit', () => { exited = true; });
        try {
          await new Promise((resolve, reject) => {
            let phase = 0;
            timer = setTimeout(() => reject(new Error('Packaged extraction worker did not respond')), 30000);
            worker.once('error', reject);
            worker.once('exit', () => reject(new Error('Packaged extraction worker exited before completion')));
            worker.on('message', message => {
              try {
                if (phase === 0) {
                  assert.deepEqual(message, { ready: true });
                  phase = 1;
                  worker.postMessage({ html: '<html><head><title>Extraction probe</title></head><body><main><h1>EXTRACT_VALID</h1></main></body></html>', url: 'https://example.com/', format: 'text', mode: 'body' });
                } else if (phase === 1) {
                  assert.equal(message.ok, true);
                  assert.equal(message.result.title, 'Extraction probe');
                  assert.match(message.result.content, /EXTRACT_VALID/);
                  phase = 2;
                  worker.postMessage({ html: '<html><body><h1>EXTRACT_REUSED</h1></body></html>', url: 'https://example.com/', format: 'markdown', mode: 'body' });
                } else {
                  assert.equal(phase, 2, 'unexpected duplicate extraction result');
                  assert.equal(message.ok, true);
                  assert.equal(message.result.content.trim(), '# EXTRACT\\_REUSED', 'markdown extraction escapes the underscore');
                  phase = 3;
                  resolve();
                }
              } catch (error) { reject(error); }
            });
          });
        } finally {
          clearTimeout(timer);
          await worker.terminate();
          assert.equal(exited, true, 'extraction worker termination must be confirmed');
        }
        return 'Packaged extraction core loaded with production dependencies, text/markdown reuse and worker termination verified.';
      });
      const monitorFixture = join(temp, 'monitor-production.mjs'); await copyFile(join(root, 'tests/fixtures/monitor-production.mjs'), monitorFixture);
      const monitorHome = join(temp, 'home-monitor'); await mkdir(monitorHome);
      await record(`${version}:monitor-runtime`, async () => {
        const output = await runCommand(`production Pi ${version} Monitor`, process.execPath, [monitorFixture, packageRoot], { cwd: monitorHome, env: { ...isolatedEnv(monitorHome), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 180000 });
        const result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.status, 'passed'); assert.equal(result.host, version); assert.equal(result.providerCalls, 0); assert.deepEqual(result.sources, ['command', 'websocket']); assert.equal(result.sourceCloseObserved, true); return output;
      });
      const runtimeFixture = join(temp, 'runtime-host.mjs');
      await copyFile(join(root, 'modules/pi-runtime/tests/fixtures/runtime-host.mjs'), runtimeFixture);
      const runtimeHome = join(temp, 'home-runtime'); await mkdir(runtimeHome);
      await record(`${version}:pi-runtime-recovery`, async () => {
        const output = await runCommand(`production Pi ${version} runtime recovery`, process.execPath, [runtimeFixture, packageRoot],
          { cwd: runtimeHome, env: { ...isolatedEnv(runtimeHome), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 180000 });
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.status, 'passed'); assert.equal(result.host, version); assert.equal(result.providerCalls, 0);
        assert.deepEqual(result.cases.map(c => c.mode), ['success', 'limit', 'repeat', 'transform', 'template', 'policy', 'cancel', 'reload', 'no-session', 'tree', 'handled', 'preflight', 'withdrawn', 'safety']); assert.ok(result.cases.every(c => c.status === 'passed')); return output;
      });
      const blackholeFixture = join(temp, 'blackhole-display.mjs');
      await copyFile(join(root, 'tests/fixtures/blackhole-display.mjs'), blackholeFixture);
      await copyFile(join(root, 'tests/fixtures/blackhole-display-audit.ts'), join(temp, 'blackhole-display-audit.ts'));
      const blackholeHome = join(temp, 'home-blackhole'); await mkdir(blackholeHome);
      await record(`${version}:blackhole-display-resume`, async () => {
        const output = await runCommand(`production Pi ${version} blackhole native-cut compact/resume`, process.execPath,
          [blackholeFixture, packageRoot], { cwd: blackholeHome, env: isolatedEnv(blackholeHome), timeoutMs: 180000 });
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.contract, 'pi-owned-native-cut-display-v1'); assert.equal(result.host, version);
        for (const key of ['nativeCut', 'persisted', 'resumed', 'rendered', 'duplicateSafe', 'displayOnly', 'noModelCopyDuplicate']) assert.equal(result[key], true, key);
        assert.deepEqual(result.counterSemantics, { modelStreamCalls: 'main-agent-streamFunction-invocations', actualExternalFetchCalls: 'global-fetch-attempts', providerCalls: 'compatibility-alias-of-actualExternalFetchCalls' });
        for (const key of ['modelStreamCalls', 'actualExternalFetchCalls', 'providerCalls']) assert.equal(result[key], 0, key);
        assert.equal(Object.hasOwn(result, 'compactAll'), false);
        assert.deepEqual(result.cases.map(row => row.scenario), ['retained-final', 'dropped-final']);
        for (const row of result.cases) {
          assert.equal(row.nativeCut, true); assert.equal(row.firstKeptEntryId, row.expectedFirstKeptEntryId); assert.ok(typeof row.firstKeptEntryId === 'string' && row.firstKeptEntryId.length > 0);
          assert.equal(row.tokensBefore, row.expectedTokensBefore); assert.ok(Number.isSafeInteger(row.tokensBefore) && row.tokensBefore > 0);
          assert.equal(row.keepRecentTokens, 8); assert.equal(row.reserveTokens, 256);
          for (const key of ['summaryInputExact', 'toolPairsComplete', 'currentFinalRetained', 'persisted', 'resumed', 'rawHistoryDiskExact', 'resumedCompactionExact', 'duplicateSafe', 'displayOnly', 'noModelCopyDuplicate']) assert.equal(row[key], true, key);
          assert.equal(row.currentFinalCopied, false); for (const key of ['modelStreamCalls', 'actualExternalFetchCalls', 'providerCalls']) assert.equal(row[key], 0, key);
        }
        assert.equal(result.cases[0].copies, 0); assert.equal(result.cases[0].rendered, false); assert.equal(result.cases[0].copiedSourceOutsideContext, false);
        assert.equal(result.cases[1].copies, 1); assert.equal(result.cases[1].rendered, true); assert.equal(result.cases[1].copiedSourceOutsideContext, true);
        return output;
      });
      const jsonFixture = join(temp, 'json-schema-runtime.mjs'); await copyFile(join(root, 'tests/fixtures/json-schema-runtime.mjs'), jsonFixture);
      const jsonProvider = join(temp, 'json-schema-provider.ts'); await copyFile(join(root, 'tests/fixtures/json-schema-provider.ts'), jsonProvider);
      const jsonHome = join(temp, 'home-json-schema'); await mkdir(jsonHome);
      await record(`${version}:json-schema-runtime`, async () => {
        // Cases run serially: parallel CLIs share jiti's cache dir, and concurrent writes fail on Windows (UNKNOWN open).
        const output = await runCommand(`production Pi ${version} json-schema-runtime`, process.execPath, [jsonFixture, packageRoot, jsonProvider], { cwd: jsonHome,
          env: { ...isolatedEnv(jsonHome), PI_BETTER_TOOLS_HOST: host, PI_JSON_SCHEMA_CASE_CONCURRENCY: '1' }, timeoutMs: 600000 });
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.hostVersion, version); assert.equal(result.status, 'passed'); assert.ok(result.cases.length >= 30); assert.ok(result.cases.every(c => c.status === 'passed')); return output;
      });
      const hooksFixture = join(temp, 'sdk-hooks.mjs'); await copyFile(join(root, 'tests/fixtures/sdk-hooks.mjs'), hooksFixture);
      const hooksHome = join(temp, 'home-sdk-hooks'); await mkdir(hooksHome);
      await record(`${version}:sdk-hooks`, async () => {
        const output = await runCommand(`production Pi ${version} sdk-hooks`, process.execPath, [hooksFixture, packageRoot, version], { cwd: hooksHome, env: { ...isolatedEnv(hooksHome), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 210000 });
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.hostVersion, version); assert.equal(result.status, 'passed'); assert.equal(result.cases.length, 14);
        assert.ok(result.cases.every(item => item.status === 'passed')); assert.equal(new Set(result.cases.map(item => item.name)).size, 14);
        assert.equal(result.hooksObserved.length, 21); assert.equal(new Set(result.hooksObserved).size, 21); return output;
      });
      const fixture = join(temp, 'smoke.mjs'); await copyFile(join(root, 'tests/fixtures/smoke.mjs'), fixture);
      await copyFile(join(root, 'tests/fixtures/renderer-probes.mjs'), join(temp, 'renderer-probes.mjs'));
      for (const mode of ['full', 'read-only', 'no-tools', 'exclude', 'brave', 'exa', 'invalid']) {
        const home = join(temp, `home-${mode}`); await mkdir(home);
        await record(`${version}:${mode}`, () => runCommand(`production Pi ${version} ${mode}`, process.execPath, [fixture, packageRoot, mode], { cwd: home, env: { ...isolatedEnv(home), PI_BETTER_TOOLS_HOST: host }, timeoutMs: 150000 }));
      }
      await record(`${version}:managed-child`, () => runChildSmoke({ home: join(temp, 'home-managed-child'), host, packageRoot, evidence: join(evidence, `package-${version}-managed-child.jsonl`) }));
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
