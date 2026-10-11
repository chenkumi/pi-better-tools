import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { compileSchema } from '../src/schema.ts';
import { writeJsonFile } from '../src/delivery.ts';
import { withoutSchemaDefaults } from '../src/validation-schema.mjs';

export function dag(depth: number) {
  const $defs: Record<string, unknown> = { S0: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } };
  for (let i = 1; i <= depth; i++) $defs[`S${i}`] = { anyOf: [{ $ref: `#/$defs/S${i - 1}` }, { $ref: `#/$defs/S${i - 1}` }] };
  return { type: 'object', $defs, properties: { x: { $ref: `#/$defs/S${depth}` } } };
}

test('R2: required default cannot validate missing raw input; instance annotations stay intact', async () => {
  const raw = { type: 'object', properties: { a: { type: 'string', default: 'x' } }, required: ['a'] };
  const compiled = compileSchema(JSON.stringify(raw));
  const data = {};
  assert.ok(await compiled.validate(data), 'missing required property must fail');
  assert.deepEqual(data, {});
  assert.deepEqual(compiled.jsonSchema, raw, 'provider annotation is not rewritten');
  assert.equal(await compiled.validate({ a: 'ok' }), undefined);
  for (const keyword of ['const', 'enum']) {
    const instance = { default: 'literal', nested: { default: 3 } };
    const constraint = keyword === 'const' ? { const: instance } : { enum: [instance] };
    const s = compileSchema(JSON.stringify({ type: 'object', properties: { a: constraint }, required: ['a'] }));
    // Zod object literals use identity, so this guard inspects schema bytes, not
    // unrelated object-const equality behavior. The required-default repro above is unchanged.
    assert.deepEqual(s.jsonSchema.properties, { a: constraint });
    assert.deepEqual(withoutSchemaDefaults({ type: 'object', properties: { a: constraint } }), { type: 'object', properties: { a: constraint } });
  }
});

test('R3: draft2020 ref siblings must be rejected rather than ignored', () => {
  for (const patterned of [false, true]) {
    const s = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', $defs: { s: { type: 'string', ...(patterned ? { pattern: '^a+$' } : {}) } }, properties: { a: { $ref: '#/$defs/s', type: 'string', minLength: 3 }, b: { $ref: '#/$defs/s', minLength: 3 } }, required: ['a'] };
    assert.throws(() => compileSchema(JSON.stringify(s)), /\$ref.*sibling.*allOf/);
  }
});

test('R10: small ref DAG amplification is counted and rejected before tool schema admission', () => {
  // Bounded depth 8 demonstrates actual Zod leaf amplification, never depth20.
  const validator = z.fromJSONSchema(dag(8) as never);
  const result = validator.safeParse({ x: { v: 1 } });
  assert.equal(result.success, false);
  const leaves = (issues: unknown[]): number => issues.reduce<number>((count, value) => {
    const issue = value as { errors?: unknown[][] };
    return count + (issue.errors ? issue.errors.reduce((n, branch) => n + leaves(branch), 0) : 1);
  }, 0);
  assert.equal(leaves(result.error!.issues), 256, '2^8 actual invalid leaf issues');
  assert.throws(() => compileSchema(JSON.stringify(dag(12))), /expanded.*budget/);
  const small = compileSchema(JSON.stringify(dag(3)));
  assert.equal(small.validate({ x: { v: 'ok' } }), undefined);
  assert.ok(small.validate({ x: { v: 1 } }));
});

test('R11: real filesystem replaces a legal 224-character target without temp leftovers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r11-'));
  const name = 'x'.repeat(224), path = join(dir, name);
  try {
    await writeFile(path, 'old'); // Prove this target is legal on the actual platform.
    await writeJsonFile(path, { a: 1 });
    assert.equal(await readFile(path, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepEqual(await readdir(dir), [name]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
