// Regression D18 (real host): <cwd>/plan -> junction to <cwd>/..archive (inside the workspace) must be accepted; a junction outside must stay refused.
// Level: real Pi 1.1.0 CLI (print mode, offline scripted provider) + real note extension entry + real filesystem junction/symlink.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox, root, runCli } from '../../../tests/helpers/regression/run-cli.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const noteEntry = join(root, 'modules/note-tools/src/index.ts');
const noteScript = [
  { content: [{ type: 'toolCall', id: 'n1', name: 'note', arguments: { type: 'plan', content: '# Plan\n\nbody\n' } }] },
  { content: [{ type: 'text', text: 'finished' }] },
];
const toolResult = requests => requests.at(-1).messages.find(m => m.role === 'toolResult' && m.toolName === 'note');
const text = r => r.content.map(b => b.text ?? '').join('');

test('D18 internal ..archive junction behind <cwd>/plan is accepted by note', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('d18-in');
  try {
    const archive = join(sb.cwd, '..archive');
    await mkdir(archive);
    await symlink(archive, join(sb.cwd, 'plan'), linkType);
    const run = await runCli(sb, { script: noteScript, extensions: [noteEntry], args: ['--tools', 'note'], label: 'D18-internal' });
    assert.equal(run.requests.length, 2, `expected tool call + final answer; stderr=${run.stderr}`);
    const result = toolResult(run.requests);
    assert.ok(result, 'note tool result must be present');
    assert.notEqual(result.isError, true, `note must succeed for a junction that stays inside the workspace, got: ${text(result)}`);
    const files = await readdir(archive);
    assert.equal(files.filter(f => /^PLAN-\d{8}T\d{9}Z\.md$/.test(f)).length, 1, `note file must exist in ..archive; found ${files}`);
    assert.equal(await readFile(join(archive, files[0]), 'utf8'), '# Plan\n\nbody\n');
  } finally { await sb.cleanup(); }
});

test('D18 control: junction pointing outside cwd is still refused', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('d18-out');
  const outside = join(sb.home, 'outside-dir');
  try {
    await mkdir(outside);
    await symlink(outside, join(sb.cwd, 'plan'), linkType);
    const run = await runCli(sb, { script: noteScript, extensions: [noteEntry], args: ['--tools', 'note'], label: 'D18-external' });
    const result = toolResult(run.requests);
    assert.equal(result?.isError, true, 'external junction must be refused');
    assert.match(text(result), /NOTE_DIRECTORY_ESCAPE/);
    assert.deepEqual(await readdir(outside), [], 'nothing may be written outside the workspace');
  } finally { await sb.cleanup(); }
});
