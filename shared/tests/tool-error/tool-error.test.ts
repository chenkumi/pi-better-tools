import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolError, codedText, toolErrorCode } from '../../src/tool-error/index.ts';

test('a ToolError message starts with its code and keeps the cause', () => {
  const cause = new Error('inner');
  const error = new ToolError('PTY_SESSION_EXITED', 'session s1 has exited', { cause });
  assert.equal(error.message, 'PTY_SESSION_EXITED: session s1 has exited');
  assert.equal(error.code, 'PTY_SESSION_EXITED');
  assert.equal(error.cause, cause);
});

test('codes must be upper snake case', () => {
  for (const code of ['', 'lower', 'Mixed_Case', '1ABC', 'A-B', 'A B']) assert.throws(() => new ToolError(code, 'x'), TypeError, code);
});

test('codedText builds the same prefix for returned failures and rejects bad codes', () => {
  assert.equal(codedText('SUBAGENT_CAPACITY', 'too many'), 'SUBAGENT_CAPACITY: too many');
  assert.throws(() => codedText('bad', 'x'), TypeError);
  assert.equal(toolErrorCode(codedText('A_B', 'x')), 'A_B');
});

test('toolErrorCode reads a ToolError, a prefixed message or a string, and ignores prose', () => {
  assert.equal(toolErrorCode(new ToolError('A_B', 'x')), 'A_B');
  assert.equal(toolErrorCode(new Error('FORK_NOT_FOUND: no such fork')), 'FORK_NOT_FOUND');
  assert.equal(toolErrorCode('OUTPUT_TOO_LARGE: big'), 'OUTPUT_TOO_LARGE');
  assert.equal(toolErrorCode(new Error('Request not accepted: capacity limit reached.')), undefined);
  assert.equal(toolErrorCode(undefined), undefined);
});

test('re-wrapping an already coded message does not stack the prefix', () => {
  const first = new ToolError('A_B', 'x');
  assert.equal(new ToolError('A_B', first.message).message, 'A_B: x');
  assert.equal(codedText('A_B', 'A_B: x'), 'A_B: x');
  assert.equal(new ToolError('C_D', first.message).message, 'C_D: A_B: x', 'a different code still wraps');
});
