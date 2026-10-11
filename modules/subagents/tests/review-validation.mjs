// Focused offline review verification. No root runner, install, real credentials or providers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-verify-'));
const agent = path.join(root, 'agent'); fs.mkdirSync(agent); fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const env = { ...process.env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
 PI_CODING_AGENT_DIR: agent, PI_BLACKHOLE_PASSIVE: 'true', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
 PI_SUBAGENTS_TEST_CLI: path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
 PI_SUBAGENTS_TEST_EVIDENCE: path.join(repo, 'modules/subagents/tests/review-evidence/host') };
const stages = [];
for (const module of ['subagents', 'shell-tools']) {
 const evidence = `modules/${module}/tests/review-evidence`; fs.mkdirSync(path.join(repo, evidence), { recursive: true });
 stages.push({ label: `${module}:typecheck`, log: `${evidence}/typecheck-final.log`, args: ['node_modules/typescript/bin/tsc', '-p', `modules/${module}/tsconfig.json`] });
 const files = fs.readdirSync(path.join(repo, `modules/${module}/tests`)).filter(n => /\.test\.(ts|mjs)$/.test(n) && !n.includes('.integration.')).map(n => `modules/${module}/tests/${n}`);
 stages.push({ label: `${module}:unit`, log: `${evidence}/unit-final.log`, args: ['--import', 'tsx', '--test', '--test-concurrency=1', ...files] });
}
stages.push({ label: 'subagents:real-host-single-resume', log: 'modules/subagents/tests/review-evidence/host-final.log', args: ['--import', 'tsx', '--test', '--test-name-pattern=P6 real production resumable dispatch: single$', 'modules/subagents/tests/pi-resume.integration.test.ts'] });
stages.push({ label: 'shell-tools:real-host-loader', log: 'modules/shell-tools/tests/review-evidence/host-final.log', args: ['--import', 'tsx', '--test', '--test-name-pattern=package loader preserves', 'modules/shell-tools/tests/extension.integration.test.mjs'] });
const results = [];
try {
 for (const stage of stages) {
  console.log(`[progress] Starting ${stage.label}`);
  const out = fs.createWriteStream(path.join(repo, stage.log));
  const proc = spawn(process.execPath, stage.args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { out.write(d); process.stdout.write(d); });
  proc.stderr.on('data', d => { out.write(d); process.stderr.write(d); });
  const heartbeat = setInterval(() => console.log(`[progress] ${stage.label} verification in progress...`), 5000);
  const code = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
  clearInterval(heartbeat); await new Promise(resolve => out.end(resolve));
  results.push({ label: stage.label, command: [process.execPath, ...stage.args], exit: code, log: stage.log });
  console.log(`[result] ${stage.label} exit=${code}`); if (code !== 0) process.exitCode = 1;
 }
} finally {
 fs.writeFileSync(path.join(repo, 'modules/subagents/tests/review-evidence/validation.json'), JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
 fs.rmSync(root, { recursive: true, force: true });
}
