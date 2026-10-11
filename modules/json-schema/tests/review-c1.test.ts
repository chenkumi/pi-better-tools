import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { compileSchema } from '../src/schema.ts';

function dualMapDag(depth: number) {
  const definitions: Record<string, unknown> = {};
  const $defs: Record<string, unknown> = { S0: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } };
  for (let i = 0; i <= depth; i++) definitions[`S${i}`] = { type: 'string' };
  for (let i = 1; i <= depth; i++) $defs[`S${i}`] = { anyOf: [{ $ref: `#/definitions/S${i - 1}` }, { $ref: `#/definitions/S${i - 1}` }] };
  return { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', definitions, $defs, properties: { x: { $ref: `#/definitions/S${depth}` } } };
}

const leaves = (issues: unknown[]): number => issues.reduce<number>((count, value) => {
  const issue = value as { errors?: unknown[][] };
  return count + (issue.errors ? issue.errors.reduce((n, branch) => n + leaves(branch), 0) : 1);
}, 0);

test('C1: admission counts the definition map actually selected by the converter', () => {
  // Actual bounded converter evidence: depth8 only. No depth12 instance validation.
  const result = z.fromJSONSchema(dualMapDag(8) as never).safeParse({ x: { v: 1 } });
  assert.equal(result.success, false);
  assert.equal(leaves(result.error!.issues), 256, 'converter selects the $defs DAG, not shallow definitions');
  assert.throws(() => compileSchema(JSON.stringify(dualMapDag(12))), /expanded.*budget/);
});

test('C1 guard: small dual-map schema keeps provider schema and draft handling unchanged', () => {
  const raw = dualMapDag(2);
  const compiled = compileSchema(JSON.stringify(raw));
  const { $schema: _ignored, ...parameters } = raw;
  assert.deepEqual(compiled.jsonSchema, parameters, 'admission must not rewrite either definition map or references');
  assert.equal(compiled.validate({ x: { v: 'ok' } }), undefined);
  assert.ok(compiled.validate({ x: { v: 1 } }));
});
