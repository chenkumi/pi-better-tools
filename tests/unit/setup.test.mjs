import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { browserInvocation, main, runInvocation } from '../../setup/core.mjs';
import { formatSetupCommand, setupCommand } from '../../setup/commands.mjs';

test('browser operations use own resolved CLI and current Node, never a shell or global playwright', () => {
  const root = join(process.cwd(), 'own install');
  const options = { resolve: name => { assert.equal(name, 'playwright'); return { root }; }, execPath: '/own node' };
  for (const [action, expected] of [['install', ['install', 'chromium', '--no-shell']], ['install-deps', ['install-deps', 'chromium']], ['setup', ['install', '--with-deps', 'chromium', '--no-shell']]]) {
    const invocation = browserInvocation(action, options);
    assert.equal(invocation.command, '/own node');
    assert.deepEqual(invocation.args, [join(root, 'cli.js'), ...expected]);
  }
  assert.throws(() => browserInvocation('__proto__', options), /Unknown/);
});

test('CLI parsing is strict and help/doctor cannot invoke installers', async () => {
  const output = [];
  const noInstall = { run: () => assert.fail('unexpected install'), output: value => output.push(value), inspect: () => ({ schemaVersion: 1 }) };
  assert.equal(await main(['--help'], noInstall), 0);
  assert.equal(await main(['doctor', '--json'], noInstall), 0);
  assert.deepEqual(JSON.parse(output[1]), { schemaVersion: 1 });
  for (const args of [['wat'], ['doctor', '--install'], ['browser', 'install', '--with-deps'], ['pty', 'setup', '--force'], ['--help', 'install']]) {
    await assert.rejects(main(args, noInstall), /Unknown arguments/);
  }
  const calls = [];
  assert.equal(await main(['browser', 'install'], { browser: action => action, run: action => { calls.push(action); return 37; } }), 37);
  assert.deepEqual(calls, ['install']);
});

test('setup command quoting labels PowerShell and POSIX and escapes quotes/metacharacters', () => {
  const common = { execPath: "/node's path", cliPath: '/pkg $value/setup.mjs' };
  assert.equal(formatSetupCommand(['doctor'], { ...common, platform: 'win32' }), "PowerShell: & '/node''s path' '/pkg $value/setup.mjs' 'doctor'");
  assert.equal(formatSetupCommand(['doctor'], { ...common, platform: 'linux' }), "POSIX shell: '/node'\\''s path' '/pkg $value/setup.mjs' 'doctor'");
  assert.ok(setupCommand(['doctor']).includes('cli.mjs'));
  assert.throws(() => setupCommand(['bad\ncommand']), /Invalid/);
});

test('installer runner uses no shell and returns actual child close/error status', async () => {
  const invocation = { command: '/node', args: ['/cli', 'install'], cwd: '/own', env: { KEEP: 'yes' } };
  for (const error of [false, true]) {
    const code = await runInvocation(invocation, {
      log: () => {},
      spawnChild(command, args, options) {
        assert.equal(command, invocation.command);
        assert.deepEqual(args, invocation.args);
        assert.deepEqual(options, { cwd: '/own', env: invocation.env, stdio: 'inherit', shell: false });
        const child = new EventEmitter();
        queueMicrotask(() => error ? child.emit('error', new Error('not emitted to output')) : child.emit('close', 37));
        return child;
      },
    });
    assert.equal(code, error ? 1 : 37);
  }
});
