import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
const root = process.cwd(), out = resolve('review-evidence/20261014-modules/validation47');
const cli = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const provider = join(out, 'json-provider.ts'), product = join(root, 'modules/json-schema/src/index.ts');
const cases = [
  { id: 'G7-001', variant: 'minItems-no-items', mode: 'text', schema: { type: 'object', properties: { xs: { type: 'array', minItems: 1 } }, required: ['xs'] }, data: { xs: [] }, expectedValid: false },
  { id: 'G7-001', variant: 'minItems-with-items-control', mode: 'text', schema: { type: 'object', properties: { xs: { type: 'array', items: {}, minItems: 1 } }, required: ['xs'] }, data: { xs: [] }, expectedValid: false, control: true },
  { id: 'G7-002', variant: 'undeclared-required', mode: 'text', schema: { type: 'object', required: ['must'] }, data: {}, expectedValid: false },
  { id: 'G7-002', variant: 'declared-required-control', mode: 'text', schema: { type: 'object', properties: { must: {} }, required: ['must'] }, data: {}, expectedValid: false, control: true },
  { id: 'G7-003', variant: 'compound-const', mode: 'text', schema: { type: 'object', properties: { x: { const: { a: 1 } } }, required: ['x'] }, data: { x: { a: 1 } }, expectedValid: true },
  { id: 'G7-003', variant: 'scalar-const-control', mode: 'text', schema: { type: 'object', properties: { x: { const: 1 } }, required: ['x'] }, data: { x: 1 }, expectedValid: true, control: true },
  { id: 'G7-004', variant: 'integer-string-tool', mode: 'tool', schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, data: { n: '7' }, expectedValid: false },
  { id: 'G7-004', variant: 'optional-null-tool', mode: 'tool', schema: { type: 'object', properties: { s: { type: 'string' } } }, data: { s: null }, expectedValid: false },
  { id: 'G7-004', variant: 'integer-valid-control', mode: 'tool', schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, data: { n: 7 }, expectedValid: true, control: true },
];
const results = { environment: { node: process.version, platform: process.platform, host: JSON.parse(await fs.readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version }, commandTemplate: 'node <actual Pi bundle/cli.js> -p --offline --no-approve --no-session --no-extensions --no-skills --no-themes --no-context-files --no-prompt-templates -e <probe provider> -e <product entry> --model review-json/fixture --thinking off [--tools json_output|--no-tools] --json-schema <schema> --json-output result.json Review', samples: [] };
const totalStart = Date.now();
async function runChild(args, opts) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, opts);
    let stdout = '', stderr = '', timedOut = false, capped = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    const add = (which, b) => {
      if (stdout.length + stderr.length + b.length > 128 * 1024) { capped = true; child.kill(); return; }
      if (which === 'stdout') stdout += b; else stderr += b;
    };
    child.stdout.on('data', b => add('stdout', b)); child.stderr.on('data', b => add('stderr', b));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolveRun({ exitCode, signal, stdout, stderr, timedOut, capped, actualClose: true }); });
  });
}
for (const c of cases) {
  for (let iteration = 1; iteration <= 3; iteration++) {
    if (Date.now() - totalStart > 170000) throw new Error('Total experiment budget exhausted');
    console.log(`Progress: ${c.id} ${c.variant} ${iteration}/3`);
    const home = await fs.mkdtemp(join(tmpdir(), 'pi-review-json-'));
    const agent = join(home, '.pi/agent');
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(join(agent, 'auth.json'), '{}');
    await fs.writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
    const spec = join(home, 'spec.json'); await fs.writeFile(spec, JSON.stringify(c));
    const args = [cli, '-p', '--offline', '--no-approve', '--no-session', '--no-extensions', '--no-skills', '--no-themes', '--no-context-files', '--no-prompt-templates', '-e', provider, '-e', product, '--model', 'review-json/fixture', '--thinking', 'off', ...(c.mode === 'tool' ? ['--tools', 'json_output'] : ['--no-tools']), '--json-schema', JSON.stringify(c.schema), '--json-output', 'result.json', 'Review'];
    const started = Date.now();
    let result;
    try {
      result = { ...c, iteration, ...(await runChild(args, { cwd: home, env: { ...isolatedEnv(home), REVIEW_JSON_SPEC: spec }, stdio: ['ignore', 'pipe', 'pipe'] })), elapsedMs: Date.now() - started };
      const delivered = await fs.readFile(join(home, 'result.json'), 'utf8').catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      result.deliveredBytes = delivered; result.delivered = delivered === null ? null : JSON.parse(delivered);
      const obs = await fs.readFile(join(home, 'observations.jsonl'), 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e));
      result.observations = obs.trim() ? obs.trim().split('\n').map(x => JSON.parse(x)) : [];
      result.requestCount = result.observations.filter(x => x.phase === 'provider').length;
      result.noTempFiles = !(await fs.readdir(home)).some(p => p.startsWith('.pi-json-'));
      result.contractViolation = !result.timedOut && !result.capped && (c.expectedValid ? result.exitCode !== 0 || delivered === null : result.exitCode === 0 && delivered !== null);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      if (result) result.fixtureCleanup = true;
    }
    results.samples.push(result);
    await fs.writeFile(join(out, 'json-results.json'), JSON.stringify(results, null, 2));
    console.log(`Progress: exit=${result.exitCode}, delivered=${result.deliveredBytes !== null}, contractViolation=${result.contractViolation}`);
  }
}
console.log(`Progress: completed ${results.samples.length} real CLI samples, all child close observed`);
