import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSchema } from '../src/schema.ts';
const obj = (value: unknown) => JSON.stringify({ type: 'object', properties: { x: value } });
test('enum/const cannot silently bypass sibling bounds, combinations or type', () => {
  for (const value of [
    { enum: ['a', 'ab'], minLength: 2 }, { const: 'a', minLength: 2 },
    { type: 'string', enum: ['a', 'ab'], minLength: 2 },
    { enum: [1, 2], type: 'number', minimum: 2 },
    { const: [1], type: 'array', minItems: 2 },
    { const: { a: 1 }, type: 'object', required: ['missing'] },
    { enum: ['a'], const: 'b' }, { enum: ['a'], allOf: [{ type: 'number' }] },
    { type: 'number', const: 'a' }, { type: 'integer', enum: [1, 1.5] },
  ]) assert.throws(() => compileSchema(obj(value)), /enum\/const/);
  const schema = compileSchema(obj({ type: 'string', enum: ['a', 'ab'] }));
  assert.equal(schema.validate({ x: 'a' }), undefined); assert.ok(schema.validate({ x: 'no' }));
});
test('unsafe patterns fail startup, including references, propertyNames and patternProperties', () => {
  for (const pattern of ['(a+)+$', '^(a|aa)+$', 'a+$', '^a*a*$', '^(?=a)a', '^a{100000}$', '^([a])\\1$', 'x'.repeat(201)]) {
    assert.throws(() => compileSchema(obj({ type: 'string', pattern })), /pattern/);
    assert.throws(() => compileSchema(JSON.stringify({ type: 'object', propertyNames: { type: 'string', pattern } })), /pattern/);
    assert.throws(() => compileSchema(JSON.stringify({ type: 'object', patternProperties: { [pattern]: { type: 'string' } } })), /pattern/);
    assert.throws(() => compileSchema(JSON.stringify({ type: 'object', $defs: { s: { type: 'string', pattern } }, properties: { x: { $ref: '#/$defs/s' } } })), /pattern/);
  }
});
test('draft-07 tuple additionalItems is audited before synchronous host validation', () => {
  for (const pattern of ['(a+)+$', '^(a|aa)+$']) {
    assert.throws(() => compileSchema(obj({ type: 'array', items: [{ type: 'number' }], additionalItems: { type: 'string', pattern } })), /unsafe pattern/);
  }
  assert.throws(() => compileSchema(obj({ type: 'array', items: [{ type: 'number' }], additionalItems: { type: 'string', enum: ['a'], minLength: 2 } })), /enum\/const/);
});
test('the linear subset keeps ordinary anchors, character classes and escaped literals', () => {
  for (const pattern of ['^a+$', '^a*$', '^\\d+$', 'literal', '^foo\\.bar$', '^[+?*()|{}]+$', '^\\[a\\]$', '^a?$']) assert.doesNotThrow(() => compileSchema(obj({ type: 'string', pattern })));
});
