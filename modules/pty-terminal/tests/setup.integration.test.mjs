import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
