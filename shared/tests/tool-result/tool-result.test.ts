import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonResult } from '../../src/tool-result/index.ts';

test('text, details and structuredContent are the same JSON-clean value', () => {
  const result = jsonResult({ a: 1, skipped: undefined, nested: { b: [1, 2] } });
  assert.equal(result.content[0].text, '{"a":1,"nested":{"b":[1,2]}}');
  assert.deepEqual(result.details, { a: 1, nested: { b: [1, 2] } });
  assert.deepEqual(result.structuredContent, result.details);
  assert.equal('isError' in result, false);
});

test('isError is set only when asked for', () => {
  assert.equal(jsonResult({ error: 'x' }, true).isError, true);
  assert.equal('isError' in jsonResult({ ok: true }, false), false);
});
