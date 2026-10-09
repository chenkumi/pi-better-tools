import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { IoGate } from '../extensions/subagent/io-gate.ts';
import { createPromptFiles, removePromptFiles } from '../extensions/subagent/prompt-files.ts';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
for (const stage of ['mkdir', 'prompt', 'task'] as const) test(`cancel during ${stage} returns before I/O settles, late owner cleans only after settlement`, async t => {
  const blocked = deferred(), entered = deferred(), cleaned = deferred();
  const gate = new IoGate();
  const mkdir = fs.promises.mkdtemp, write = fs.promises.writeFile, rm = fs.promises.rm;
  let directory: string | undefined, deleted = false, taskWrites = 0;
  t.mock.method(fs.promises, 'mkdtemp', async (...args: Parameters<typeof mkdir>) => {
    directory = await mkdir(...args);
    if (stage === 'mkdir') { entered.resolve(); await blocked.promise; }
    return directory;
  });
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).endsWith('task.txt')) taskWrites++;
    if ((stage === 'prompt' && String(args[0]).includes('prompt-')) || (stage === 'task' && String(args[0]).endsWith('task.txt'))) { entered.resolve(); await blocked.promise; }
    return write(...args);
  });
  t.mock.method(fs.promises, 'rm', async (...args: Parameters<typeof rm>) => {
    await rm(...args); deleted = true; cleaned.resolve();
  });
  const pending = createPromptFiles('worker', 'system', 'task', gate);
  try {
    await entered.promise; gate.stop(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
    assert.equal(deleted, false); assert.ok(gate.pendingOperations > 0);
    assert.ok(directory && fs.existsSync(directory));
    blocked.resolve(); await cleaned.promise;
    assert.equal(fs.existsSync(directory!), false);
    if (stage !== 'task') assert.equal(taskWrites, 0, 'cancelled preparation must not proceed to later writes');
  } finally { blocked.resolve(); await cleaned.promise; t.mock.restoreAll(); }
});
test('cancellation while a prompt mutation is queued prevents starting its OS write', async t => {
  const locked = deferred(), release = deferred(), cleaned = deferred();
  const gate = new IoGate();
  const mkdir = fs.promises.mkdtemp, write = fs.promises.writeFile, rm = fs.promises.rm;
  let owner: Promise<void> | undefined, directory: string | undefined, writes = 0;
  t.mock.method(fs.promises, 'mkdtemp', async (...args: Parameters<typeof mkdir>) => {
    directory = await mkdir(...args);
    owner = withFileMutationQueue(join(directory, 'prompt-worker.md'), async () => {
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    return directory;
  });
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof write>) => { writes++; return write(...args); });
  t.mock.method(fs.promises, 'rm', async (...args: Parameters<typeof rm>) => { await rm(...args); cleaned.resolve(); });
  const pending = createPromptFiles('worker', 'system', 'task', gate);
  try {
    await locked.promise;
    // Advance one event-loop turn, not a duration: preparation has resumed and
    // its mutation cannot acquire the still-owned queue.
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.stop(new Error('cancelled queued write'));
    await assert.rejects(pending, /cancelled queued write/);
    assert.equal(writes, 0); assert.ok(directory && fs.existsSync(directory));
    release.resolve(); await owner; await cleaned.promise;
    assert.equal(writes, 0, 'a cancelled queue callback must not start a new OS write');
    assert.equal(fs.existsSync(directory!), false);
  } finally { release.resolve(); await owner; await cleaned.promise; t.mock.restoreAll(); }
});
test('cleanup gate abort returns while actual deletion retains ownership and finishes late', async t => {
  const files = await createPromptFiles('worker', 'system', 'task', new IoGate());
  assert.equal(await fs.promises.readFile(files.filePath, 'utf8'), 'system');
  assert.equal(await fs.promises.readFile(files.taskPath, 'utf8'), 'Task: task');
  const entered = deferred(), blocked = deferred(), cleaned = deferred(), gate = new IoGate();
  const original = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (...args: Parameters<typeof original>) => { entered.resolve(); await blocked.promise; await original(...args); cleaned.resolve(); });
  const pending = gate.run(() => removePromptFiles(files), 'cleanup prompt files');
  try {
    await entered.promise; gate.stop(new Error('cancelled cleanup'));
    await assert.rejects(pending, /cancelled cleanup/);
    assert.ok(gate.pendingOperations > 0); assert.ok(fs.existsSync(files.dir));
    blocked.resolve(); await cleaned.promise; assert.equal(fs.existsSync(files.dir), false);
  } finally { blocked.resolve(); await cleaned.promise; t.mock.restoreAll(); }
});
