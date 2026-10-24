import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PtySessionManager } from '../src/pty-manager.ts';
import { setupCommand } from '../../../setup/commands.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };

test('native load diagnostic gives this instance setup command without raw loader errors', () => {
  const original = Module._load;
  Module._load = (name, ...args) => {
    if (name === 'node-pty') throw new Error('PRIVATE_LOADER_DETAIL');
    return original(name, ...args);
  };
  try {
    const manager = new PtySessionManager();
    assert.throws(() => manager.spawn('unused', [], {}, process.cwd()), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(setupCommand(['doctor'])));
      assert.ok(error.message.includes(setupCommand(['pty', 'setup'])));
      assert.equal(error.message.includes('PRIVATE_LOADER_DETAIL'), false);
      assert.equal(manager.list().length, 0);
      return true;
    });
  } finally { Module._load = original; }
});

test('spawn errors are not mislabeled as missing native dependency', () => {
  const original = Module._load;
  const failure = new Error('spawn denied');
  Module._load = (name, ...args) => name === 'node-pty' ? { spawn: () => { throw failure; } } : original(name, ...args);
  try {
    assert.throws(() => new PtySessionManager().spawn('unused', [], {}, process.cwd()), error => error instanceof Error && error.cause === failure && /spawn denied/.test(error.message) && !/npm run pty:install|native/i.test(error.message));
  } finally { Module._load = original; }
});
