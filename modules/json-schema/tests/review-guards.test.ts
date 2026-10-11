import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSchema } from '../src/schema.ts';
import { withoutSchemaDefaults } from '../src/validation-schema.mjs';
import { writeJsonFile } from '../src/delivery.ts';

test('default pruning visits schema positions only, including tuple tails and definitions', () => {
  const data = { default: { nested: { default: 7 } } };
  const leaf = { type: 'string', default: 'annotation', examples: [data], enum: [data], const: data };
  const schema = { type: 'object', default: data, examples: [data], properties: { a: { allOf: [leaf] } }, $defs: { d: leaf }, definitions: { d: leaf }, items: [leaf], additionalItems: leaf, prefixItems: [leaf], additionalProperties: leaf, contains: leaf, propertyNames: leaf, patternProperties: { '^x': leaf }, anyOf: [leaf], oneOf: [leaf] };
  const result = withoutSchemaDefaults(schema) as typeof schema;
  const cleanLeaf = { type: 'string', examples: [data], enum: [data], const: data };
  assert.equal('default' in result, false);
  assert.deepEqual(result.properties.a.allOf, [cleanLeaf]);
  assert.deepEqual(result.$defs.d, cleanLeaf);
  assert.deepEqual(result.definitions.d, cleanLeaf);
  assert.deepEqual(result.items, [cleanLeaf]);
  assert.deepEqual(result.additionalItems, cleanLeaf);
  assert.deepEqual(result.prefixItems, [cleanLeaf]);
  assert.deepEqual(result.additionalProperties, cleanLeaf);
  assert.deepEqual(result.contains, cleanLeaf);
  assert.deepEqual(result.propertyNames, cleanLeaf);
  assert.deepEqual(result.patternProperties['^x'], cleanLeaf);
  assert.deepEqual(result.anyOf, [cleanLeaf]);
  assert.deepEqual(result.oneOf, [cleanLeaf]);
  assert.deepEqual(result.examples, [data]);
  assert.equal(schema.default, data, 'source schema is not mutated');
});

test('bare recursive root reference and explicit ref allOf stay supported', async () => {
  const recursive = compileSchema(JSON.stringify({ type: 'object', properties: { child: { $ref: '#' } } }));
  assert.equal(await recursive.validate({ child: { child: {} } }), undefined);
  assert.ok(await recursive.validate({ child: 1 }));
  const allOf = compileSchema(JSON.stringify({ type: 'object', $defs: { s: { type: 'string' } }, properties: { a: { allOf: [{ $ref: '#/$defs/s' }, { type: 'string', minLength: 3 }] } } }));
  assert.ok(await allOf.validate({ a: 'x' }));
  assert.equal(await allOf.validate({ a: 'aaa' }), undefined);
  for (const draft of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
    assert.throws(() => compileSchema(JSON.stringify({ $schema: draft, type: 'object', properties: { child: { $ref: '#', type: 'object' } } })), /unsupported sibling/);
  }
});

test('failed rename preserves old file and cleans only its owned temp', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'json-rename-guard-'));
  const path = join(dir, 'out.json');
  await writeFile(path, 'OLD');
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeJsonFile(path, { a: 1 }), /injected rename failure/);
    assert.equal(await readFile(path, 'utf8'), 'OLD');
    assert.deepEqual(await readdir(dir), ['out.json']);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

test('exclusive temp collision never overwrites or deletes another owner file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'json-collision-guard-'));
  const path = join(dir, 'out.json');
  await writeFile(path, 'OLD');
  const originalOpen = fs.open;
  let collision = '';
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[1] === 'wx') { collision = String(args[0]); await writeFile(collision, 'OTHER OWNER'); }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeJsonFile(path, { a: 1 }), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'OLD');
    assert.equal(await readFile(collision, 'utf8'), 'OTHER OWNER');
    assert.equal((await readdir(dir)).length, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});
