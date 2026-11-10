import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECKPOINT_TOOL, deadlineText } from '../src/checkpoint/messages.ts';

test('the deadline notice asks for the checkpoint tool as the very next action and mentions no file', () => {
  const text = deadlineText();
  assert.match(text, new RegExp(`calling ${CHECKPOINT_TOOL}`));
  assert.match(text, /very next action must be that call/);
  assert.doesNotMatch(text, /notes file|note tool|file-writing/);
});
