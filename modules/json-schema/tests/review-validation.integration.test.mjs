import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../extensions/json-schema.ts';
import { compileSchema } from '../src/schema.ts';
import { validationPool } from '../src/validation-pool.ts';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

test.after(async () => { await validationPool.close(); });

test('R2: real pattern worker rejects missing required default', async () => {
  const raw = { type: 'object', properties: { a: { type: 'string', pattern: '^a+$', default: 'aaa' } }, required: ['a'] };
  const compiled = compileSchema(JSON.stringify(raw));
  assert.ok(await compiled.validate({}));
  assert.equal(await compiled.validate({ a: 'aaa' }), undefined);
  assert.ok(await compiled.validate({ a: '!' }));
});

test('R2: recovery skips missing required default and delivers original valid candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r2-recovery-'));
  const hooks = new Map();
  const raw = { type: 'object', properties: { a: { type: 'string', default: 'x' } }, required: ['a'] };
  extension({ registerFlag() {}, registerTool() {}, on: (name, handler) => hooks.set(name, handler),
    getFlag: name => name === 'json-schema' ? JSON.stringify(raw) : 'out.json', getActiveTools: () => [] });
  const ctx = { mode: 'print', cwd: dir, modelRegistry: { complete() { assert.fail('no provider call allowed'); } } };
  try {
    hooks.get('session_start')({}, ctx);
    hooks.get('input')({}, ctx);
    hooks.get('message_end')({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{} then {"a":"ok"}' }] } }, ctx);
    await hooks.get('session_shutdown')({}, ctx);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')), { a: 'ok' });
  } finally { await hooks.get('session_shutdown')({}, ctx); await rm(dir, { recursive: true, force: true }); }
});

test('R10: admission runs before registration and real host argument validation', () => {
  const $defs = { S0: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } };
  for (let i = 1; i <= 12; i++) $defs[`S${i}`] = { anyOf: [{ $ref: `#/$defs/S${i - 1}` }, { $ref: `#/$defs/S${i - 1}` }] };
  const raw = { type: 'object', $defs, properties: { x: { $ref: '#/$defs/S12' } } };
  const hooks = new Map(), tools = [], errors = [];
  extension({ registerFlag() {}, registerTool: tool => tools.push(tool), on: (name, handler) => hooks.set(name, handler), getFlag: name => name === 'json-schema' ? JSON.stringify(raw) : undefined });
  const originalExit = process.exitCode, originalWrite = process.stderr.write;
  process.stderr.write = text => { errors.push(text); return true; };
  try {
    hooks.get('session_start')({}, { mode: 'print', cwd: tmpdir() });
    assert.equal(tools.length, 0, 'host must never receive this amplified parameter schema');
    assert.match(errors.join(''), /expanded.*budget/);
  } finally { process.exitCode = originalExit; process.stderr.write = originalWrite; }
  const small = compileSchema(JSON.stringify({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }));
  assert.deepEqual(validateToolArguments({ name: 'json_output', parameters: Type.Unsafe(small.jsonSchema) }, { name: 'json_output', arguments: { a: 'ok' } }), { a: 'ok' });
});

test('C1: dual-map amplification is refused before host tool registration', async () => {
  const definitions = {}, $defs = { S0: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } };
  for (let i = 0; i <= 12; i++) definitions[`S${i}`] = { type: 'string' };
  for (let i = 1; i <= 12; i++) $defs[`S${i}`] = { anyOf: [{ $ref: `#/definitions/S${i - 1}` }, { $ref: `#/definitions/S${i - 1}` }] };
  const raw = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', definitions, $defs, properties: { x: { $ref: '#/definitions/S12' } } };
  const hooks = new Map(), tools = [], errors = [];
  extension({ registerFlag() {}, registerTool: tool => tools.push(tool), on: (name, handler) => hooks.set(name, handler), getFlag: name => name === 'json-schema' ? JSON.stringify(raw) : undefined });
  const originalExit = process.exitCode, originalWrite = process.stderr.write;
  process.stderr.write = text => { errors.push(text); return true; };
  try {
    hooks.get('session_start')({}, { mode: 'print', cwd: tmpdir() });
    assert.equal(tools.length, 0, 'host must never receive the dual-map amplified schema');
    assert.match(errors.join(''), /expanded.*budget/);
  } finally {
    // Cancel the fixture's run before cleanup: never recover data or call a provider.
    hooks.get('agent_settled')({ aborted: true }, {});
    await hooks.get('session_shutdown')({}, { mode: 'print', cwd: tmpdir() });
    process.exitCode = originalExit;
    process.stderr.write = originalWrite;
  }
});
