import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../../../setup/cli.mjs', import.meta.url));
const require = createRequire(cli);

test('published CLI help/doctor run from unrelated cwd with no install or cache writes', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-setup-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cache = join(cwd, 'empty-browser-cache');
  await mkdir(cache);
  // A misleading consumer dependency must never override the package instance.
  const fake = join(cwd, 'node_modules/playwright');
  await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0', main: 'index.js' }));
  await writeFile(join(fake, 'index.js'), 'throw new Error("WRONG_CWD_DEPENDENCY");');
  const npmCli = join(cwd, 'npm-cli.js');
  await writeFile(npmCli, 'throw new Error("DOCTOR_STARTED_INSTALLER");');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache, npm_execpath: npmCli, HOME: cwd, USERPROFILE: cwd, SETUP_TEST_SECRET: 'must-not-be-emitted' };
  const snapshot = await readdir(cwd, { recursive: true });
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 15000 });
  const help = run(['--help']);
  assert.ifError(help.error);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /consumer approval required/);
  const doctor = run(['doctor', '--json']);
  assert.ifError(doctor.error);
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.node.executable, process.execPath);
  assert.equal(report.browser.root, dirname(require.resolve('playwright/package.json')));
  assert.equal(report.browser.status, 'executable-missing');
  assert.equal(report.pty.root, dirname(require.resolve('node-pty/package.json')));
  assert.ok(['loadable', 'unavailable'].includes(report.pty.status));
  assert.equal(doctor.stdout.includes('must-not-be-emitted'), false);
  assert.deepEqual(await readdir(cwd, { recursive: true }), snapshot);
  assert.deepEqual(await readdir(cache), []);
  const invalid = run(['browser', 'install', '--unapproved-option']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown arguments/);
  assert.deepEqual(await readdir(cache), []);
});

test('bin, included setup directory, lock metadata and npm conveniences use one CLI', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.bin, { 'pi-better-tools': 'setup/cli.mjs' });
  assert.deepEqual(lock.packages[''].bin, manifest.bin);
  assert.ok(manifest.files.includes('setup'));
  for (const [script, args] of [['pty:install', 'pty setup'], ['browser:install', 'browser install'], ['browser:install-deps', 'browser install-deps'], ['setup:browser', 'browser setup']]) {
    assert.equal(manifest.scripts[script], `node setup/cli.mjs ${args}`);
  }
});

// Read-only: the real Playwright CLI is only asked to print its plan. Nothing is downloaded and the
// relative cache directory is never created, so this can run from any cwd without touching a cache.
test('relative browser cache resolves against the caller cwd for doctor and for the installer child', { timeout: 60_000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-setup-cache-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: './pw-cache' };
  delete env.INIT_CWD;
  const cache = join(cwd, 'pw-cache');
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(doctor.error);
  assert.equal(doctor.status, 0, doctor.stderr);
  const diagnostic = JSON.parse(doctor.stdout);
  assert.equal(diagnostic.browser.status, 'executable-missing');
  assert.ok(diagnostic.browser.executable.startsWith(cache), `doctor must resolve the relative cache against the caller cwd: ${diagnostic.browser.executable}`);
  // Ask this package's own invocation what cwd it would hand the installer, then probe the real CLI.
  const probe = [
    "import { spawnSync } from 'node:child_process';",
    `import { browserInvocation } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'core.mjs')).href)};`,
    "const invocation = browserInvocation('install');",
    "const result = spawnSync(invocation.command, [...invocation.args, '--dry-run'], { cwd: invocation.cwd, env: invocation.env, encoding: 'utf8', timeout: 30000 });",
    'console.log(JSON.stringify({ cwd: invocation.cwd, status: result.status, output: `${result.stdout ?? \'\'}${result.stderr ?? \'\'}` }));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const installer = JSON.parse(child.stdout);
  assert.equal(installer.cwd, cwd, 'the installer child must keep the caller cwd, not the package directory');
  assert.equal(installer.status, 0, installer.output);
  const location = /Install location:\s+(.+?)\s*$/m.exec(installer.output)?.[1];
  assert.ok(location, `Playwright dry-run must report an install location: ${installer.output}`);
  assert.ok(location.startsWith(cache), `the installer child must target the same cache as doctor: ${location} vs ${cache}`);
  assert.equal(await readdir(cache).catch(() => 'absent'), 'absent', 'the dry-run probe must not create the cache');
});
