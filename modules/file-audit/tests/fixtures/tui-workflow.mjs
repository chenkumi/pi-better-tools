import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv } from '../../../../tests/helpers/environment.mjs';
import { startArm, requestText } from './tui-ab.mjs';

const observer = fileURLToPath(new URL('./workflow-observer.ts', import.meta.url));
const verifier = fileURLToPath(new URL('../../../../scripts/verify-sources.mjs', import.meta.url));
const config = 'modules/workflow/config.mjs', feature = 'modules/workflow/feature.mjs';
const originalConfig = 'export const enabled = true;\n', overwrittenConfig = 'export const enabled = false;\n';
const featureSource = answer => `import { enabled } from './config.mjs';\nexport const answer = ${answer};\nexport const rollout = enabled;\n`;
const originalFeature = featureSource(1), finalFeature = featureSource(2);
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const targetTest = "import assert from 'node:assert/strict';\nimport { answer } from './modules/workflow/feature.mjs';\nassert.equal(answer, 2);\nconsole.log('Feature-only test: PASS');\n";

async function prepare(cwd) {
  await mkdir(join(cwd, 'modules/workflow'), { recursive: true });
  await mkdir(join(cwd, 'scripts'), { recursive: true });
  await copyFile(verifier, join(cwd, 'scripts/verify-sources.mjs'));
  assert.equal(hash(await readFile(join(cwd, 'scripts/verify-sources.mjs'))), hash(await readFile(verifier)));
  const files = [];
  for (let i = 0; i < 64; i++) {
    const path = `modules/workflow/unrelated-${String(i).padStart(2, '0')}.mjs`;
    const content = '//' + String(i).padStart(2, '0') + 'x'.repeat(16379) + '\n';
    assert.equal(Buffer.byteLength(content), 16384);
    await writeFile(join(cwd, path), content); files.push({ path, sha256: hash(content) });
  }
  for (const [path, content] of [[feature, originalFeature], [config, originalConfig]]) {
    await writeFile(join(cwd, path), content); files.push({ path, sha256: hash(content) });
  }
  // Config is deliberately LAST: the fail-fast real verifier must read all 66
  // inventoried content files before reporting this injected problem.
  const native = { modules: [{ module: 'workflow', origin: 'Isolated workflow experiment', license: 'MIT', entry: config, files }] };
  const packages = ['pi-open-tui', '@ff-labs/pi-fff'].map(name => ({ name, version: '1.0.0', integrity: 'fixture-integrity',
    resolved: `https://unused.invalid/${name}`, entry: './index.ts', license: 'MIT' }));
  const manifest = { dependencies: {}, pi: { extensions: [] } }, lock = { packages: {} };
  // These are inert identity fixtures required by the existing verifier, NOT
  // installed packages; the isolated Pi loads only explicit real extensions.
  for (const dep of packages) {
    manifest.dependencies[dep.name] = dep.version;
    manifest.pi.extensions.push(dep.name === '@ff-labs/pi-fff' ? './modules/file-tools/src/fff-override.mjs' : `./node_modules/${dep.name}/index.ts`);
    lock.packages[`node_modules/${dep.name}`] = { version: dep.version, integrity: dep.integrity, resolved: dep.resolved };
    const dir = join(cwd, 'node_modules', dep.name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.ts'), '// inert fixture\n');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: dep.version, license: dep.license, pi: { extensions: ['./index.ts'] } }));
  }
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(cwd, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(join(cwd, 'target-test.mjs'), targetTest);
  await writeFile(join(cwd, 'docs/sources.json'), JSON.stringify({ modules: [] }));
  await writeFile(join(cwd, 'docs/adaptations.json'), JSON.stringify({ files: [], addedFiles: [], removedFiles: [],
    localSourceNpmSuite: { packages }, localSourceSuiteFinalIntegration: { rootFiles: [{ path: 'target-test.mjs', sha256: hash(targetTest) }] } }));
  const saveNative = () => writeFile(join(cwd, 'docs/native-modules.json'), JSON.stringify(native));
  await saveNative();
  return { async approveFeatureOnly() {
    assert.equal(await readFile(join(cwd, feature), 'utf8'), finalFeature);
    native.modules[0].files.find(item => item.path === feature).sha256 = hash(finalFeature);
    assert.equal(native.modules[0].files.find(item => item.path === config).sha256, hash(originalConfig));
    await saveNative();
  } };
}

async function oracle(cwd) {
  // Independent requirement oracle: not derived from extension output or its
  // metadata parser. Check expected bytes AND run the real artifact in a fresh
  // Node process: answer must be 2 and rollout must remain true. No import cache.
  const configCorrect = await readFile(join(cwd, config), 'utf8') === originalConfig;
  const featureCorrect = await readFile(join(cwd, feature), 'utf8') === finalFeature;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
    'const m=await import(process.argv[1]); console.log(JSON.stringify({answer:m.answer,rollout:m.rollout}));',
    pathToFileURL(join(cwd, feature)).href], { cwd, env: isolatedEnv(dirname(cwd)), timeout: 10000 });
  const runtime = JSON.parse(stdout);
  return { configCorrect, featureCorrect, runtime, correct: configCorrect && featureCorrect && runtime.answer === 2 && runtime.rollout === true };
}

function incrementalDecision(status, scan) {
  // Explicit simulated OPERATOR policy, not a product feature. Never consult
  // the hidden injection flag/oracle to decide whether delivery is permitted.
  if (/(?:^|[\s,])(?:mismatch|missing|unavailable|untracked|skipped)=[1-9]/m.test(scan)) return 'blocked';
  const paths = status.replaceAll('\\', '/');
  if (![config, feature].every(path => paths.includes(`: ${path} (`)) || !/Selected: 2; checked: 2;/.test(scan) || !/\bmatched=2\b/.test(scan)) return 'review-incomplete';
  return 'proceed';
}

export async function runWorkflow(scenario, order, evidenceDir, tokenizer) {
  const directory = await mkdtemp(join(tmpdir(), `file-audit-workflow-${scenario}-`));
  const arms = {}, timeline = [];
  const beat = setInterval(() => console.log(`[workflow] ${scenario}: real PTY experiment or cleanup still running...`), 10000);
  let success = false;
  try {
    for (const label of order) {
      console.log(`[workflow] ${scenario}/${label}: starting real fullscreen Pi TUI`);
      const arm = await startArm(join(directory, label), label === 'B', 'fullscreen', { observer, tools: 'read,edit,workflow_test' });
      const event = (kind, detail = {}) => {
        const row = { arm: label, kind, timestamp: new Date().toISOString(), ...detail };
        timeline.push(row); appendFileSync(join(directory, 'timeline.jsonl'), JSON.stringify(row) + '\n');
      };
      try {
        const fixture = await prepare(arm.cwd);
        if (label === 'B' && scenario === 'evicted') await arm.command('limits --max-files 1', /max-files: 1/);
        await arm.prompt('WF_READ');
        const readRequest = (await arm.records()).filter(row => row.event === 'request').at(-1);
        const readResult = readRequest.transcript.find(item => item.role === 'toolResult' && item.toolName === 'read');
        assert.equal(readResult.isError, false);
        assert.match(JSON.stringify(readResult.content), /enabled = true/);
        event('read-success', { toolCallId: readResult.toolCallId, readConfigSha256: hash(originalConfig) });
        const metadataBefore = hash(await readFile(join(arm.cwd, 'docs/native-modules.json')));
        if (scenario !== 'clean') {
          assert.notEqual(process.pid, arm.terminal.pid);
          await writeFile(join(arm.cwd, config), overwrittenConfig);
          assert.equal(hash(await readFile(join(arm.cwd, 'docs/native-modules.json'))), metadataBefore);
          event('external-overwrite', { actorPid: process.pid, piPid: arm.terminal.pid,
            beforeSha256: hash(originalConfig), afterSha256: hash(await readFile(join(arm.cwd, config))), metadataUnchanged: true });
        } else event('no-injection');
        // This second PTY prompt is sent only AFTER the parent's external write.
        await arm.prompt('WF_WORK');
        const target = (await arm.records()).find(row => row.event === 'target-test');
        assert.equal(target.exitCode, 0); assert.match(target.stdout, /Feature-only test: PASS/);
        event('target-test-passed', { exitCode: target.exitCode });
        // Model normal provenance maintenance for the approved feature edit,
        // identically in every arm. NEVER update config's expected hash.
        await fixture.approveFeatureOnly(); event('approved-feature-metadata-only');
        const before = await arm.snapshot('before-gate');
        let gate = 'proceed', diagnosticFound = false, status, check, full;
        const incremental = async () => {
          const statusRow = await arm.command('status', /Candidates:/);
          const checkRow = await arm.command('check', /Selected:/);
          return { status: statusRow.message, check: checkRow.message };
        };
        const fullCheck = async () => {
          await arm.command('', /Full provenance: (?:PASSED|FAILED)/, 'workflow-full');
          const record = (await arm.records()).filter(row => row.event === 'full-verification').at(-1);
          assert.equal(record.io.contentFiles, 66, 'count real successful content reads, not inventory guesses');
          assert.equal(record.io.reads.filter(row => row.path === config).length, 1);
          return record;
        };
        if (label === 'B') {
          ({ status, check } = await incremental());
          gate = incrementalDecision(status, check);
          diagnosticFound = /mismatch: modules[\\/]workflow[\\/]config\.mjs/.test(check);
          const frame = await arm.snapshot('initial-gate');
          assert.match(frame.screenLines.join('\n'), /Selected:/);
          if (diagnosticFound) assert.match(frame.screenLines.join('\n'), /mismatch: modules[\\/]workflow[\\/]config\.mjs/);
          if (scenario === 'evicted') { assert.match(status, /capacity=[1-9]/); assert.doesNotMatch(status.replaceAll('\\', '/'), /: modules\/workflow\/config\.mjs/); }
        } else if (label === 'C') {
          full = await fullCheck(); gate = full.exitCode === 0 ? 'proceed' : 'blocked';
          diagnosticFound = full.exitCode !== 0 && full.stderr.includes(`native module changed without updated provenance: ${config}`);
          const frame = await arm.snapshot('initial-gate');
          assert.match(frame.screenLines.join('\n'), /Full provenance: (?:PASSED|FAILED)/);
        }
        const after = await arm.snapshot('after-gate');
        assert.equal(after.requests, before.requests, 'neither closing command should call a model');
        event('initial-gate', { decision: gate, diagnosticFound });
        const initialOracle = await oracle(arm.cwd);
        assert.equal(initialOracle.correct, scenario === 'clean');
        assert.equal(gate, scenario === 'clean' || label === 'A' ? 'proceed' : label === 'B' && scenario === 'evicted' ? 'review-incomplete' : 'blocked');
        assert.equal(diagnosticFound, scenario !== 'clean' && (label === 'C' || label === 'B' && scenario !== 'evicted'));
        let repaired = false, repairCheck;
        if (diagnosticFound) {
          // Simulated operator repair, grounded in a visible filename diagnostic.
          // NOT a scripted assistant response or an automatic extension repair.
          const metadata = hash(await readFile(join(arm.cwd, 'docs/native-modules.json')));
          await writeFile(join(arm.cwd, config), originalConfig);
          assert.equal(hash(await readFile(join(arm.cwd, 'docs/native-modules.json'))), metadata);
          event('operator-repair', { actorPid: process.pid, path: config, metadataUnchanged: true });
          if (label === 'B') {
            const repeat = await incremental(); repairCheck = repeat.check;
            assert.equal(incrementalDecision(repeat.status, repeat.check), 'proceed');
          } else { repairCheck = await fullCheck(); assert.equal(repairCheck.exitCode, 0); }
          assert.equal((await oracle(arm.cwd)).correct, true); repaired = true;
          event('repair-recheck-passed');
        }
        await arm.prompt('WF_CONTEXT_PROBE');
        const final = await arm.close(), saved = await arm.save();
        const requests = saved.records.filter(row => row.event === 'request'); assert.equal(requests.length, 7);
        assert.equal(saved.records.filter(row => row.event === 'network-attempt').length, 0);
        assert.ok(saved.records.some(row => row.event === 'shutdown'));
        const cost = label === 'B' ? { contentFiles: Number(check.match(/checked: (\d+)/)[1]), contentBytes: Number(check.match(/content bytes: (\d+)/)[1]),
          metadataBytes: Number(check.match(/metadata bytes: (\d+)/)[1]), elapsedMs: Number(check.match(/elapsed: (\d+)ms/)[1]) }
          : label === 'C' ? { contentFiles: full.io.contentFiles, contentBytes: full.io.contentBytes, metadataBytes: full.io.metadataBytes,
            totalBytes: full.io.totalBytes, elapsedMs: full.elapsedMs } : null;
        arms[label] = { label, home: saved.home, initialGate: gate, diagnosticFound, initialOracle, falseDelivery: gate === 'proceed' && !initialOracle.correct,
          targetExitCode: target.exitCode, status, check, full, cost, repaired, repairCheck, finalOracle: await oracle(arm.cwd), requests,
          records: saved.records, output: saved.output, exitCode: final.exitCode };
        console.log(`[workflow] ${scenario}/${label}: gate=${gate}, diagnostic=${diagnosticFound}, falseDelivery=${arms[label].falseDelivery}, repaired=${repaired}, CLI exit=0`);
      } finally { try { await arm.close(); } finally { await arm.save(); } }
    }
    const perRequest = arms.A.requests.map((request, i) => {
      const payloads = ['A', 'B', 'C'].map(label => requestText(arms[label].requests[i], arms[label].home, true));
      assert.equal(payloads[1], payloads[0]); assert.equal(payloads[2], payloads[0]);
      assert.doesNotMatch(payloads[0], /Full provenance:|File Audit|mismatch: modules/);
      return { nth: i + 1, normalizedSha256: hash(payloads[0]), normalizedBytes: Buffer.byteLength(payloads[0]),
        estimatedNormalizedTokens: tokenizer ? tokenizer.encode(payloads[0]).length : null };
    });
    const result = { scenario, order, externalCalls: 0, normalizedPayloadsEqual: true,
      tokenMethod: tokenizer ? 'js-tiktoken@1.0.21 o200k_base; semantic serialization estimate, not billed usage' : null,
      estimatedNormalizedTokensPerArm: tokenizer ? perRequest.reduce((sum, row) => sum + row.estimatedNormalizedTokens, 0) : null,
      perRequest, timeline, arms: Object.fromEntries(['A', 'B', 'C'].map(label => {
        const { home: _home, requests: _requests, records: _records, output: _output, ...summary } = arms[label]; return [label, summary];
      })) };
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      for (const label of ['A', 'B', 'C']) {
        await writeFile(join(evidenceDir, `${scenario}-${label}.journal.jsonl`), arms[label].records.map(row => JSON.stringify(row)).join('\n') + '\n');
        await writeFile(join(evidenceDir, `${scenario}-${label}.terminal.raw.txt`), arms[label].output);
      }
      await writeFile(join(evidenceDir, `${scenario}-summary.json`), JSON.stringify(result, null, 2));
    }
    success = true; return result;
  } finally {
    clearInterval(beat);
    if (success) { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); console.log(`[workflow] ${scenario}: all 3 CLI exits confirmed; successful workspaces removed`); }
    else console.error(`[workflow] Failure evidence retained at ${directory}`);
  }
}
