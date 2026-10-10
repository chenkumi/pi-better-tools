// D05: after json_output was accepted, a host cancel in agent_before_settle (agent_settled.aborted=true, no SIGTERM, no aborted
// assistant message) must stop delivery: empty stdout, existing output file untouched, non-zero exit.
// Level: real Pi 1.1.0 CLI (print mode, offline scripted provider) + real json-schema entry + small abort extension.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox, root, runCli } from '../../../tests/helpers/regression/run-cli.mjs';

const entry = join(root, 'modules/json-schema/src/index.ts');
const aborter = join(root, 'tests/helpers/regression/abort-before-settle.ts');
const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false });
const script = [{ content: [{ type: 'toolCall', id: 'r1', name: 'json_output', arguments: { name: 'Acme' } }] }];

async function scenario(label, withFile) {
  const sb = await makeSandbox(`d05-${label}`);
  try {
    const target = join(sb.cwd, 'result.json');
    if (withFile) await writeFile(target, 'OLD_RESULT\n');
    const run = await runCli(sb, { script, label: `D05-${label}`, extensions: [entry, aborter],
      args: ['--tools', 'json_output', '--json-schema', schema, ...(withFile ? ['--json-output', target] : [])] });
    console.error(`[D05-${label}] code=${run.code} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr.slice(-300))}`);
    assert.deepEqual(JSON.parse(await readFile(join(sb.home, 'settled.json'), 'utf8')), { aborted: true }, 'precondition: host reported agent_settled.aborted=true');
    assert.equal(run.requests.length, 1, 'exactly one model request: tool accepted, then terminate');
    assert.equal(run.stdout, '', `cancelled run must not print a result to stdout, got ${JSON.stringify(run.stdout)}`);
    if (withFile) assert.equal(await readFile(target, 'utf8'), 'OLD_RESULT\n', 'cancelled run must not overwrite the existing output file');
    assert.notEqual(run.code, 0, 'cancelled run must exit non-zero');
  } finally { await sb.cleanup(); }
}

test('D05 stdout mode: before-settle cancel after accepted result delivers nothing', { timeout: 120000 }, () => scenario('stdout', false));
test('D05 file mode: before-settle cancel after accepted result keeps old file', { timeout: 120000 }, () => scenario('file', true));
