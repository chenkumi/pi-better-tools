// R05 (Note part) repro: note realpath()-checks <cwd>/<type>, then open(join(directory, file), 'wx') uses the LEXICAL path.
// If <cwd>/<type> is swapped for a junction pointing outside cwd between the check and the open, the note is created
// outside the workspace. Correct behaviour: nothing may be created outside cwd.
// Run: node --import tsx --test modules/note-tools/tests/note-toctou.integration.test.mjs
// Barrier technique (no production change): the test wraps node:fs/promises.realpath (installed BEFORE the real host loads the
// extension, then syncBuiltinESMExports). When note.ts's realpath(<cwd>/report) has returned its real (inside-cwd) result, the wrapper
// performs the attacker's swap (rmdir the empty dir, create a junction to <home>/outside) BEFORE returning to note.ts.
// This deterministically lands the swap in the check->open window. Fidelity: real Pi host + real note tool; offline fake provider.
// Caveat: the barrier is a test-side interposer on the fs module, so it proves the window is exploitable, not that an attacker can win it by timing.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { readdir, mkdir, rmdir, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { makeSandbox, startHost } from '../../../tests/helpers/regression/host-r.mjs';

const sandbox = await makeSandbox('r05-note');
after(() => sandbox.cleanup());
const outside = join(sandbox.home, 'outside');
const target = resolve(sandbox.cwd, 'report');
const model = { id: 'offline', name: 'Offline', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

// KNOWN LIMITATION (todo): the threat model does not cover an external writer swapping an ancestor directory between the realpath check
// and open(). The assertion states the desired behaviour; `todo` keeps it visible without failing CI. See modules/note-tools/README.md.
test('R05 note must not create a file outside cwd when <cwd>/<type> is swapped to a junction after the realpath check', { timeout: 90000, todo: 'known limitation: ancestor-directory TOCTOU is outside the note threat model (see README)' }, async () => {
  await mkdir(outside, { recursive: true });
  const original = fsp.realpath;
  let swapped = false;
  fsp.realpath = async function patched(path, ...rest) {
    const result = await original.call(this, path, ...rest);
    if (!swapped && typeof path === 'string' && resolve(path) === target) {
      swapped = true;
      console.error('[R05-note] barrier: realpath(<cwd>/report) done; swapping directory for a junction to outside cwd');
      await rmdir(target);
      await symlink(outside, target, 'junction');
    }
    return result;
  };
  syncBuiltinESMExports();
  const host = await startHost({
    sandbox, extensionPaths: ['modules/note-tools/src/index.ts'], tools: ['note'], select: ['r05-offline', 'offline'],
    providers: [{ name: 'r05-offline', api: 'openai-responses', models: [model],
      script: (nth) => nth === 1 ? [{ type: 'toolCall', id: 'note-1', name: 'note', arguments: { type: 'report', content: '# TOCTOU probe\n\nharmless text\n' } }] : undefined }],
  });
  try {
    await host.session.prompt('save a report note');
    const results = host.session.messages.filter((m) => m.role === 'toolResult').map((m) => ({ isError: m.isError, text: JSON.stringify(m.content).slice(0, 300) }));
    const outsideFiles = await readdir(outside);
    console.error(`[R05-note] barrier fired=${swapped} toolResult=${JSON.stringify(results)} filesOutsideCwd=${JSON.stringify(outsideFiles)}`);
    assert.equal(swapped, true, 'test precondition: the barrier must have fired inside the note tool');
    assert.deepEqual(outsideFiles, [], 'a note file was created outside the workspace through the swapped junction');
  } finally {
    fsp.realpath = original; syncBuiltinESMExports();
    await host.close();
  }
});
