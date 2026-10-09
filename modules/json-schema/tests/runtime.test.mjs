import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const expectedPiVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@earendil-works/pi-coding-agent'];
test('L32: real Pi loader runs parallel patterned tools and drains the persistent pool on shutdown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-json-schema-pattern-host-'));
  try {
    const agentDir = join(home, '.pi/agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}');
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
    const provider = join(home, 'provider.ts');
    await copyFile(join(root, 'tests/fixtures/json-schema-provider.ts'), provider);
    const schema = { type: 'object', properties: { name: { type: 'string', pattern: '^A[a-z]+$' }, count: { type: 'integer' } }, required: ['name', 'count'], additionalProperties: false };
    const cli = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
    await runCommand('json-schema:pattern-host', process.execPath, [cli, '-p', '--offline', '--no-approve', '--no-session', '--no-extensions', '--no-skills', '--no-themes', '--no-context-files', '--no-prompt-templates',
      '-e', provider, '-e', join(root, 'modules/json-schema/src/index.ts'), '--model', 'json-offline/fixture', '--thinking', 'off', '--tools', 'json_output', '--json-schema', JSON.stringify(schema), '--json-output', 'result.json', 'Extract the result.'],
    { cwd: home, env: { ...isolatedEnv(home), JSON_SCHEMA_SCENARIO: 'duplicate' }, timeoutMs: 600000 });
    assert.deepEqual(JSON.parse(await readFile(join(home, 'result.json'), 'utf8')), { name: 'Acme', count: 5 });
    assert.equal((await readFile(join(home, 'requests.jsonl'), 'utf8')).trim().split('\n').length, 1, 'parallel successful tools must not cause another model call');
    assert.match(await readFile(join(home, 'cleaned.txt'), 'utf8'), /cleaned/);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('real Pi offline structured-output lifecycle and failure regression', { timeout: 600000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-json-schema-runtime-'));
  try {
    const output = await runCommand('json-schema:real-cli', process.execPath, [join(root, 'tests/fixtures/json-schema-runtime.mjs'), root], { cwd: home, env: isolatedEnv(home), timeoutMs: 570000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.hostVersion, expectedPiVersion); assert.equal(result.status, 'passed'); assert.ok(result.cases.length >= 25); assert.ok(result.cases.every(c => c.status === 'passed'));
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
