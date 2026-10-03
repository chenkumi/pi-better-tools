import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../src/install.mjs', import.meta.url));
test('native installer drops only inherited allow-scripts and invokes the active npm without a shell', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-pty-install-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = join(cwd, 'npm-cli.js');
  await writeFile(cli, 'console.log(JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env).filter(k=>k.toLowerCase()==="npm_config_allow_scripts"),keep:process.env.KEEP_ENV,cwd:process.cwd()}));');
  const env = { PATH: process.env.PATH, npm_execpath: cli, npm_config_allow_scripts: 'inherited', NPM_CONFIG_ALLOW_SCRIPTS: 'inherited-uppercase', KEEP_ENV: 'kept' };
  const result = spawnSync(process.execPath, [installer], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.args, ['rebuild', 'node-pty', '--foreground-scripts']);
  assert.deepEqual(output.keys, []); assert.equal(output.keep, 'kept');
  // Assert cwd by real identity on hosts whose temp path has aliases.
  assert.equal(output.cwd, spawnSync(process.execPath, ['-p', 'process.cwd()'], { cwd, encoding: 'utf8' }).stdout.trim());
  await writeFile(cli, 'process.exit(37);');
  const failed = spawnSync(process.execPath, [installer], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(failed.error); assert.equal(failed.status, 37);
});

test('native installer rejects an absent or unsupported npm launcher', () => {
  for (const env of [{}, { npm_execpath: '/not-an-npm-launcher.js' }]) {
    const result = spawnSync(process.execPath, [installer], { env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.match(result.stderr, /Use npm run pty:install/);
  }
});
