// R01: a transient provider error followed by Pi's native retry succeeding (as text, and as json_output).
// Level: real Pi 1.1.0 CLI (print mode, retry enabled with 1ms backoff, offline scripted provider) + real json-schema entry.
//
// POLICY IS UNDECIDED (README lists upstream error as a non-delivery condition; whether a recovered retry may be accepted is not specified).
// So the hard assertions are policy-neutral invariants that both "fail-fast" and "accept recovered success" must satisfy:
//   (1) stdout never carries assistant prose;  (2) exit code and stdout agree: exit 0 <=> stdout is exactly the JSON line;
//       a non-zero exit must have empty stdout and a diagnostic on stderr.
// The policy-specific test ("recovered success is delivered") is marked todo: it records the current behaviour without deciding the policy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { makeSandbox, root, runCli } from '../../../tests/helpers/regression/run-cli.mjs';

const entry = join(root, 'modules/json-schema/src/index.ts');
const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false });
const retrySettings = { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } };
const transient = { error: '503 Service Unavailable: overloaded, please retry' };
const PROSE = 'PROSE_MARKER_the_answer_is';
const scripts = {
  text: [transient, { content: [{ type: 'text', text: `${PROSE} {"name":"Acme"}` }] }],
  tool: [transient, { content: [{ type: 'toolCall', id: 'r1', name: 'json_output', arguments: { name: 'Acme' } }] }],
};

async function observe(kind) {
  const sb = await makeSandbox(`r01-${kind}`, retrySettings);
  try {
    const run = await runCli(sb, { script: scripts[kind], label: `R01-${kind}`, extensions: [entry], args: ['--tools', 'json_output', '--json-schema', schema] });
    console.error(`[R01-${kind}] code=${run.code} requests=${run.requests.length} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr.slice(-300))}`);
    return run;
  } finally { await sb.cleanup(); }
}
function neutralInvariants(run) {
  assert.equal(run.requests.length, 2, 'precondition: host natively retried once (error, then success)');
  assert.ok(!run.stdout.includes(PROSE), `stdout must not carry assistant prose, got ${JSON.stringify(run.stdout)}`);
  if (run.code === 0) assert.equal(run.stdout, '{"name":"Acme"}\n', 'exit 0 means the single JSON result line was delivered');
  else { assert.equal(run.stdout, '', 'non-zero exit must leave stdout empty'); assert.match(run.stderr, /pi-json-schema:/, 'failure must be diagnosed on stderr'); }
}

test('R01 retry then text success: no prose on stdout, exit code coherent with stdout', { timeout: 120000 }, async () => neutralInvariants(await observe('text')));
test('R01 retry then json_output success: no prose on stdout, exit code coherent with stdout', { timeout: 120000 }, async () => neutralInvariants(await observe('tool')));

for (const kind of ['text', 'tool']) {
  test(`R01 (policy-A, informational) recovered ${kind} success is delivered and exits 0`, { timeout: 120000, todo: 'policy undecided: fail-fast vs accept recovered retry' }, async () => {
    const run = await observe(kind);
    assert.equal(run.code, 0, `recovered retry should exit 0 under policy A; stderr=${run.stderr}`);
    assert.equal(run.stdout, '{"name":"Acme"}\n');
  });
}
