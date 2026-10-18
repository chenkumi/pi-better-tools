import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { consumerRoot, discoverNpm, ptyInvocation } from '../../../setup/core.mjs';

const owner = resolve('consumer project');
const root = join(owner, 'node_modules', 'node-pty');
const version = '1.2.0-beta.15';
const dependencies = {
  resolve: name => { assert.equal(name, 'node-pty'); return { root, version }; },
  readJson: path => { assert.equal(path, join(owner, 'package.json')); return { allowScripts: { [`node-pty@${version}`]: true } }; },
  npm: () => join(owner, 'npm-cli.js'),
};

test('native installer targets exact hoisted dependency and preserves consumer policy', () => {
  const env = { npm_config_allow_scripts: 'inherited', NPM_CONFIG_ALLOW_SCRIPTS: 'uppercase', KEEP_ENV: 'kept', npm_config_ignore_scripts: 'true' };
  const result = ptyInvocation({ ...dependencies, env });
  assert.equal(result.command, process.execPath);
  assert.deepEqual(result.args, [join(owner, 'npm-cli.js'), 'rebuild', root, '--foreground-scripts', '--global=false', '--prefix', owner]);
  assert.equal(result.cwd, owner);
  assert.deepEqual(result.env, { KEEP_ENV: 'kept', npm_config_ignore_scripts: 'true' });
  assert.equal(env.npm_config_allow_scripts, 'inherited');
});

test('native setup refuses missing, broad, denied or different-version consumer approval before npm discovery', () => {
  for (const allowScripts of [undefined, { '*': true }, { 'node-pty': true }, { [`node-pty@${version}`]: false }, { 'node-pty@0.0.0': true }]) {
    assert.throws(() => ptyInvocation({ ...dependencies, readJson: () => ({ allowScripts }), npm: () => assert.fail('must not discover npm') }), /consumer approval/);
  }
});

test('missing consumer manifest is an actionable refusal, not an implicit global setup', () => {
  assert.throws(() => ptyInvocation({ ...dependencies,
    readJson: () => { throw new Error('secret/path/ENOENT'); },
    npm: () => assert.fail('must not discover npm'),
  }), error => /readable consumer package.json/.test(error.message) && !/secret/.test(error.message));
});

test('nested dependency policy owner is the consumer, not dependency package', () => {
  assert.equal(consumerRoot(join(owner, 'node_modules', 'pi-better-tools', 'node_modules', 'node-pty')), owner);
  assert.throws(() => consumerRoot(owner), /Unsupported/);
});

test('standalone discovery uses known Node-adjacent npm or deterministic refusal, never PATH', () => {
  const execPath = join(owner, 'node');
  const expected = join(owner, 'node_modules/npm/bin/npm-cli.js');
  const options = { env: { PATH: '/malicious', npm_execpath: 'npm-cli.js' }, execPath, realpath: path => path, exists: path => path === expected };
  assert.equal(discoverNpm(options), expected);
  assert.throws(() => discoverNpm({ ...options, exists: () => false }), /npm CLI not found/);
  const active = join(owner, 'active/npm-cli.js');
  assert.equal(discoverNpm({ ...options, env: { npm_execpath: active }, exists: () => true }), active);
});
