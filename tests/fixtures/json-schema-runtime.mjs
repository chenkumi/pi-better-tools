// Real CLI / production-tarball probe. Copies only test fixtures into isolated homes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(process.argv[2]);
const host = process.env.PI_BETTER_TOOLS_HOST ?? dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const hostRoot = host.endsWith('dist') ? dirname(host) : host;
const providerSource = process.argv[3] ?? fileURLToPath(new URL('./json-schema-provider.ts', import.meta.url));
const cli = join(hostRoot, 'dist/bundle/cli.js');
const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name', 'count'], additionalProperties: false });
const cases = [];
const heartbeat = setInterval(() => console.error('[json-schema-runtime] Offline CLI verification still running...'), 10000);
async function run(name, scenario, extra = [], expected = { name: 'Acme', count: 5 }, options = {}) {
  console.error(`[json-schema-runtime] Checking ${name}...`);
  const home = await mkdtemp(join(homedir(), 'json-case-'));
  try {
    const agentDir = join(home, '.pi/agent'); await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}');
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
    const fixture = join(home, 'provider.ts'); await copyFile(providerSource, fixture);
    const target = join(home, 'result.json');
    if (options.oldFile) await writeFile(target, 'OLD_RESULT\n');
    const args = [cli, '-p', '--offline', '--no-approve', '--no-session', '--no-extensions', '--no-skills', '--no-themes', '--no-context-files', '--no-prompt-templates', '-e', fixture, '-e', packageRoot,
      '--model', scenario.startsWith('virtual') ? 'json-router/auto' : 'json-offline/fixture', '--thinking', 'off', ...(extra.includes('--no-tools') ? [] : ['--tools', 'json_output']),
      ...(options.inactive ? [] : ['--json-schema', schema, ...(options.file ? ['--json-output', target] : [])]), ...extra, 'Extract the result.', ...(options.multi ? ['Second request must not reuse the first result.'] : [])];
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir, JSON_SCHEMA_SCENARIO: scenario, PI_WEB_TOOLS_CONFIG: join(agentDir, 'web-search.json') };
    await writeFile(join(agentDir, 'web-search.json'), '{"provider":"openai"}');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      let timedOut = false, escalation;
      const timer = setTimeout(() => {
        timedOut = true;
        console.error(`[json-schema-runtime] ${name} timed out; waiting for owned child termination...`);
        child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, 60000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.on('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(escalation);
        if (timedOut) reject(new Error(`${name} timed out (owned child exited; code=${code}, signal=${signal})`));
        else resolve({ code, signal, stdout, stderr });
      });
    });
    const requests = await readFile(join(home, 'requests.jsonl'), 'utf8').then(t => t.trim().split('\n').map(JSON.parse), error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (options.fail) {
      assert.notEqual(result.code, 0, `${name}: unexpected success; stderr=${result.stderr}`);
      if (!options.protocol) assert.equal(result.stdout, '', `${name}: error polluted stdout: ${result.stdout.slice(0, 500)}`);
      assert.match(result.stderr, options.error ?? /pi-json-schema:/);
      if (options.oldFile) assert.equal(await readFile(target, 'utf8'), 'OLD_RESULT\n');
    } else {
      assert.equal(result.code, 0, `${name}: stderr=${result.stderr}`);
      const json = options.file ? await readFile(target, 'utf8') : result.stdout;
      assert.ok(json.endsWith('\n'));
      assert.deepEqual(JSON.parse(json), expected, `${name}: must parse the ENTIRE output, not its last line`);
      if (!options.file) assert.equal(json, JSON.stringify(expected) + '\n');
      assert.match(result.stderr, /FIXTURE_PROGRESS_LOG/);
    }
    if (options.calls !== undefined) assert.equal(requests.length, options.calls, `${name}: ${result.stderr}`);
    if (options.noTool) assert.ok(requests.every(r => !r.tools.includes('json_output')));
    assert.match(await readFile(join(home, 'cleaned.txt'), 'utf8'), /cleaned/, 'host must execute other shutdown handlers');
    assert.ok(!(await readdir(home)).some(name => name.endsWith('.tmp')), 'no leftover atomic temporary output');
    cases.push({ name, status: 'passed', calls: requests.length });
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
}
try {
  for (const scenario of ['tool', 'text', 'fenced', 'mixed', 'duplicate']) await run(`stdout ${scenario}`, scenario, [], undefined, { calls: 1 });
  await run('file tool atomic replacement', 'tool', [], undefined, { file: true, oldFile: true, calls: 1 });
  await run('file text extraction', 'text', [], undefined, { file: true, calls: 1 });
  await run('stdout rejects multiple prompts without reusing prior result', 'text', [], undefined, { multi: true, fail: true, calls: 1 });
  await run('SIGTERM event during settlement cancels staged JSON', 'signal', [], undefined, { fail: true, calls: 1 });
  await run('virtual model extraction routing', 'virtual', [], undefined, { calls: 2 });
  await run('extraction from a tool call', 'fallback', [], undefined, { calls: 2 });
  await run('extraction from text', 'fallback-text', [], undefined, { calls: 2 });
  await run('invalid tool arguments are rejected, never delivered, and end in failure', 'invalid-tool', [], undefined, { fail: true, calls: 3 });
  for (const scenario of ['invalid-text', 'overflow', 'null', 'empty']) await run(`unusable text ${scenario} falls back to one extraction call`, scenario, [], undefined, { calls: 2 });
  for (const scenario of ['error', 'aborted', 'conflict']) await run(`failure ${scenario}`, scenario, [], undefined, { fail: true, calls: 1 });
  await run('extraction failure is bounded to one extra call', 'fallback-fail', [], undefined, { fail: true, calls: 2 });
  await run('extraction with the wrong tool name is rejected', 'fallback-wrong', [], undefined, { fail: true, calls: 2 });
  await run('file extraction failure preserves old result', 'fallback-fail', [], undefined, { fail: true, file: true, oldFile: true, calls: 2 });
  await run('missing schema stops before model', 'tool', ['--json-schema', ''], undefined, { fail: true, calls: 0 });
  await run('invalid schema stops before model', 'tool', ['--json-schema', '{"type":"object","required":7}'], undefined, { fail: true, calls: 0 });
  await run('unsupported schema keyword stops before model', 'tool', ['--json-schema', '{"type":"object","properties":{"a":{"type":"string"}},"if":{"required":["a"]}}'], undefined, { fail: true, calls: 0 });
  await run('JSONL mode rejected', 'tool', ['--mode', 'json'], undefined, { fail: true, calls: 0, protocol: true });
  await run('exclude prevents extraction tool bypass', 'fallback', ['--exclude-tools', 'json_output'], undefined, { fail: true, calls: 1, noTool: true });
  await run('no-tools prevents extraction tool bypass', 'fallback', ['--no-tools'], undefined, { fail: true, calls: 1, noTool: true });
  await run('disabled tool still accepts validated text', 'text', ['--no-tools'], undefined, { calls: 1, noTool: true });
  await run('inactive retains normal print output', 'inactive', [], undefined, { inactive: true, calls: 1, noTool: true });
  const version = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8')).version;
  console.log(JSON.stringify({ status: 'passed', hostVersion: version, cases, noNetwork: true, noPaidModels: true }));
} finally { clearInterval(heartbeat); }
