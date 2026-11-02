import assert from 'node:assert/strict';
import test from 'node:test';
import { foldToolUse } from '../src/fold/registry.ts';
import { formatRange, formatRef } from '../src/fold/ref.ts';

test('a reference carries the line and the first eight characters of the entry id', () => {
  assert.equal(formatRef({ line: 1234, id: 'a1b2c3d4e5f6a7b8' }), '⟦L1234:a1b2c3d4⟧');
  assert.equal(formatRef({ line: 7, id: 'abc' }), '⟦L7:abc⟧');
});

test('the size is shown only for a large line', () => {
  assert.equal(formatRef({ line: 9, id: 'a1b2c3d4', bytes: 2048 }), '⟦L9:a1b2c3d4⟧');
  assert.equal(formatRef({ line: 9, id: 'a1b2c3d4', bytes: 84_000 }), '⟦L9:a1b2c3d4 · 82.0KB⟧');
});

test('consecutive conversation lines collapse to a range keyed by the first entry', () => {
  assert.equal(formatRange({ line: 120, id: 'a1b2c3d4' }, 124), '⟦L120–124:a1b2c3d4⟧');
  assert.equal(formatRange({ line: 120, id: 'a1b2c3d4' }, 120), '⟦L120:a1b2c3d4⟧');
});

test('a folded tool line ends with the reference, including the size hint of a large result', () => {
  const out = foldToolUse({ id: 'c', name: 'bash', args: { command: 'make' } }, { text: 'ok', isError: false, ref: { line: 88, id: 'deadbeef00', bytes: 120_000 } });
  assert.ok(out.endsWith(' ⟦L88:deadbeef · 117.2KB⟧'), out);
});
