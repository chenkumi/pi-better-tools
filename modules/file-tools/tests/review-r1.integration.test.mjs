import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../extensions/file-tools.ts';
import { sha256Token } from '../src/file-operations.ts';

test('R1: registered edit returns bounded success after committing 200000 short lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-r1-'));
  try {
    const tools = [];
    extension({ registerTool: tool => tools.push(tool), on: () => () => {} });
    const edit = tools.find(tool => tool.name === 'edit');
    const path = join(dir, 'edit.txt');
    await writeFile(path, 'original');
    const updated = 'x\n'.repeat(200000) + 'z';
    let result, failure;
    try {
      result = await edit.execute('r1', { path, expectedHash: sha256Token('original'), edits: [{ oldText: 'original', newText: updated }] }, undefined, undefined, { cwd: dir });
    } catch (error) { failure = error; }
    // Assert disk first: a formatter failure must not disguise an actual commit.
    assert.equal(await readFile(path, 'utf8'), updated);
    assert.deepEqual(await readdir(dir), ['edit.txt']);
    assert.ifError(failure);
    assert.equal(result.details.sha256After, sha256Token(updated));
    assert.equal(result.details.added, 200001);
    assert.equal(result.details.removed, 1);
    const text = result.content[0].text;
    assert.match(text, /FILE_EDIT_SUCCESS/);
    assert.ok(text.includes(sha256Token(updated)));
    assert.ok(text.split('\n').length <= 44);
    assert.ok(text.length < 10000);
    assert.match(text, /more diff line\(s\) omitted/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
