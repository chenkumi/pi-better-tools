import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { main, runInvocation } from '../../setup/core.mjs';
import { formatSetupCommand, setupCommand } from '../../setup/commands.mjs';

test('CLI parsing is strict and help/doctor cannot invoke installers', async () => {
  const output = [];
  const noInstall = { run: () => assert.fail('unexpected install'), output: value => output.push(value), inspect: () => ({ schemaVersion: 1 }) };
  assert.equal(await main(['--help'], noInstall), 0);
  assert.equal(await main(['doctor', '--json'], noInstall), 0);
  assert.deepEqual(JSON.parse(output[1]), { schemaVersion: 1 });
  for (const args of [['wat'], ['doctor', '--install'], ['browser', 'install'], ['pty', 'setup', '--force'], ['--help', 'install']]) {
    await assert.rejects(main(args, noInstall), /Unknown arguments/);
  }
  const calls = [];
  assert.equal(await main(['pty', 'setup'], { pty: () => 'pty-invocation', run: action => { calls.push(action); return 37; } }), 37);
  assert.deepEqual(calls, ['pty-invocation']);
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
