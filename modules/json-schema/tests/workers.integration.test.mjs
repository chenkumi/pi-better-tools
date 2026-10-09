import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSchema } from '../src/schema.ts';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Worker } from 'node:worker_threads';
import { ValidationPool, validationPool } from '../src/validation-pool.ts';
test.after(async () => { await validationPool.close(); });
const schema = () => compileSchema(JSON.stringify({ type: 'object', $defs: { s: { type: 'string', pattern: '^a+$' } }, properties: { x: { $ref: '#/$defs/s' } }, required: ['x'] }));
test('actual worker validates safe patterns, local references and preserves raw data', async () => {
  const compiled = schema(), data = { x: 'aaa' };
  assert.equal(await compiled.validate(data), undefined);
  assert.match(await compiled.validate({ x: '!' }), /x/);
  assert.deepEqual(data, { x: 'aaa' });
  assert.doesNotThrow(() => validateToolArguments({ name: 'json_output', parameters: Type.Unsafe(compiled.jsonSchema) }, { name: 'json_output', arguments: data }));
});
test('actual validation worker cancellation and queueing do not abandon worker permits', async () => {
  const compiled = schema();
  const cancelled = new AbortController();
  const pending = compiled.validate({ x: 'aaa' }, cancelled.signal);
  cancelled.abort(); assert.match(await pending, /cancelled/);
  const running = Array.from({ length: 7 }, () => compiled.validate({ x: 'aaa' }));
  for (const promise of running) assert.equal(await promise, undefined);
  const queuedAbort = new AbortController();
  const burst = Array.from({ length: 4 }, () => compiled.validate({ x: 'aaa' }));
  const queued = compiled.validate({ x: 'aaa' }, queuedAbort.signal);
  queuedAbort.abort();
  assert.match(await queued, /cancelled/);
  for (const promise of burst) assert.equal(await promise, undefined);
  assert.equal(await compiled.validate({ x: 'aaa' }), undefined);
});
test('safe tuple additionalItems patterns use a worker and validate the tail', async () => {
  const compiled = compileSchema(JSON.stringify({ type: 'object', properties: { x: { type: 'array', items: [{ type: 'number' }], additionalItems: { type: 'string', pattern: '^a+$' } } } }));
  const result = compiled.validate({ x: [1, 'aaa'] });
  assert.equal(typeof result?.then, 'function', 'tail pattern must select isolated validation');
  assert.equal(await result, undefined);
  assert.match(await compiled.validate({ x: [1, '!'] }), /x/);
});
test('L32: real worker is reused, schema cache changes safely, and shutdown leaves no worker', async () => {
  const workers = [];
  const pool = new ValidationPool(() => {
    const worker = new Worker(new URL('../src/validation-worker.mjs', import.meta.url), { execArgv: [] });
    workers.push(worker); return worker;
  });
  const a = { type: 'object', properties: { x: { type: 'string', pattern: '^a+$' } }, required: ['x'] };
  const b = { type: 'object', properties: { x: { type: 'string', pattern: '^b+$' } }, required: ['x'] };
  try {
    assert.equal(await pool.validate(a, { x: 'aaa' }), undefined);
    assert.match(await pool.validate(b, { x: 'aaa' }), /x/);
    assert.equal(await pool.validate(b, { x: 'bbb' }), undefined);
    assert.equal(await pool.validate(a, { x: 'aaa' }), undefined);
    assert.equal(workers.length, 1, 'serial jobs must reuse the same live worker');
  } finally { await pool.close(); }
  assert.equal(workers[0].threadId, -1, 'shutdown waits for the actual worker exit');
});
test('unsafe regex is rejected before it can reach host synchronous tool validation', () => {
  for (const pattern of ['(a+)+$', '^(a|aa)+$']) assert.throws(() => compileSchema(JSON.stringify({ type: 'object', properties: { x: { type: 'string', pattern } } })), /unsafe pattern/);
});
