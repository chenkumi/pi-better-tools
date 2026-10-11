// C2/W1 follow-up only: isolated Subagents tests, evidence outside source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.join(repo, 'plan/evidence/review-repair-20261011/review-followups/subagents');
const mode = process.argv[2];
if (!['red', 'green', 'verify', 'cancel-guards', 'unit'].includes(mode)) throw new Error('Usage: review-followup-validation.mjs red|green|verify|cancel-guards|unit');
fs.mkdirSync(evidence, { recursive: true });
// Do not include 'pi-subagent-' in the ancestor root: existing prompt-cleanup
// fault seams match that substring to select only the product-owned prompt dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-owned-followup-'));
const agent = path.join(root, 'agent'); fs.mkdirSync(agent); fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)/i.test(key)));
const env = { ...inherited, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
 PI_CODING_AGENT_DIR: agent, PI_BLACKHOLE_PASSIVE: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
 PI_SUBAGENTS_TEST_CLI: path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
 PI_SUBAGENTS_TEST_EVIDENCE: path.join(evidence, 'host') };
const core = ['--import', 'tsx', '--test', '--test-name-pattern=C2|W1', 'modules/subagents/tests/session-store.test.ts'];
const unitArgs = ['--import', 'tsx', '--test', '--test-concurrency=1', ...fs.readdirSync(path.join(repo, 'modules/subagents/tests')).filter(n => /\.test\.(ts|mjs)$/.test(n) && !n.includes('.integration.')).map(n => `modules/subagents/tests/${n}`)];
const stages = mode === 'unit' ? [{ label: 'unit-final', args: unitArgs }] : mode !== 'verify' ? [1, 2, 3].map(i => ({ label: `${mode}-${i}`, args: mode === 'cancel-guards'
 ? ['--import', 'tsx', '--test', 'modules/subagents/tests/runner-prompt-lifecycle.test.ts'] : core })) : [
 { label: 'typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/subagents/tsconfig.json'] },
 { label: 'focused-guards', args: ['--import', 'tsx', '--test', '--test-concurrency=1',
  'modules/subagents/tests/session-store.test.ts', 'modules/subagents/tests/query-snapshot.test.ts',
  'modules/subagents/tests/review-fixes.test.ts', 'modules/subagents/tests/review-lifecycle.test.ts',
  'modules/subagents/tests/runner-io.test.ts', 'modules/subagents/tests/recovery.test.ts',
  'modules/subagents/tests/rpc-abandon.test.ts', 'modules/subagents/tests/review-background.test.ts'] },
 { label: 'unit', args: unitArgs },
 { label: 'real-host-resume', args: ['--import', 'tsx', '--test', '--test-name-pattern=P6 real production resumable dispatch: single$', 'modules/subagents/tests/pi-resume.integration.test.ts'] },
];
const results = [];
try {
 for (const stage of stages) {
  console.log(`[progress] Starting Subagents ${stage.label}`);
  const log = path.join(evidence, `${stage.label}.log`), out = fs.createWriteStream(log);
  const proc = spawn(process.execPath, stage.args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { out.write(d); process.stdout.write(d); });
  proc.stderr.on('data', d => { out.write(d); process.stderr.write(d); });
  const heartbeat = setInterval(() => console.log(`[progress] Subagents ${stage.label} verification in progress...`), 5000);
  const exit = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
  clearInterval(heartbeat); await new Promise(resolve => out.end(resolve));
  results.push({ label: stage.label, args: stage.args, exit, log: path.relative(repo, log).replaceAll('\\', '/') });
  console.log(`[result] ${stage.label} exit=${exit}`);
  if (mode === 'red' ? exit !== 1 : exit !== 0) process.exitCode = 1;
 }
} finally {
 fs.writeFileSync(path.join(evidence, `${mode}-results.json`), JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
 fs.rmSync(root, { recursive: true, force: true });
}
