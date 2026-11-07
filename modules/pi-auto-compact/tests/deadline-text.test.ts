import assert from 'node:assert/strict';
import test from 'node:test';
import { deadlineText, WRITE_TOOLS } from '../src/checkpoint/messages.ts';

test('the deadline notice names only the file-writing tools that are enabled', () => {
  const writeOnly = deadlineText(['write']);
  assert.match(writeOnly, /enabled file-writing tools: write\)/);
  assert.doesNotMatch(writeOnly, /\bnote\b.*tool \(type checkpoint\)|\bedit\b/, 'must not demand note or edit when only write is available');
  assert.doesNotMatch(writeOnly, /with the note tool/);
  const all = deadlineText(WRITE_TOOLS);
  assert.match(all, /note, write, edit/);
  assert.match(all, /with the note tool \(type checkpoint\)/);
});
