import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
const directory = resolve('plan/review-20261012-evidence/verify-subagents');
const pilot = process.argv[2] === 'pilot';
const rerun = process.argv[2] === 'rerun-large';
const prefix = pilot ? 'pilot-' : rerun ? 'rerun-' : '';
const modes = pilot ? ['control', 'ready-control'] : rerun ? ['large-text'] : ['control', 'large-text', 'metadata-close', 'aggregate-close', 'begin-close', 'ready-fault', 'ready-control'];
let failures = 0;
const records = [];
for (let repeat = 1; repeat <= (pilot ? 1 : 3); repeat++) {
  for (const mode of modes) {
    const label = `${prefix}${mode}-${repeat}`;
    const root = fs.mkdtempSync(join(directory, 'launch-'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|CREDENTIAL|^PI_SUBAGENTS_GUARD$/.test(key)) delete env[key];
    for (const key of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR']) env[key] = root;
    env.PI_CODING_AGENT_DIR = join(root, 'agent'); env.PI_BLACKHOLE_PASSIVE = 'true'; env.PI_OFFLINE = '1'; env.PROBE_MODE = mode;
    const script = join(directory, mode.startsWith('ready-') ? 'ready.test.ts' : 'runner.test.ts');
    const args = ['--max-old-space-size=384', '--import', 'tsx', '--test', '--test-concurrency=1', script];
    console.log(`Progress: starting ${label}; fresh process, 60s outer cap`);
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { env, cwd: process.cwd(), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(join(directory, `${label}.stdout.log`), result.stdout ?? '');
    fs.writeFileSync(join(directory, `${label}.stderr.log`), result.stderr ?? '');
    const record = { label, command: [process.execPath, ...args], status: result.status, signal: result.signal, error: result.error?.message, elapsedMs: Date.now() - started };
    if (result.status !== 0) failures++;
    // An outer timeout is not cleanup evidence; retain its launch root.
    if (!result.error) { fs.rmSync(root, { recursive: true, force: true }); record.launchRemoved = !fs.existsSync(root); }
    else record.retainedRoot = root;
    records.push(record);
    fs.writeFileSync(join(directory, `${label}.exit.json`), JSON.stringify(record, null, 2));
    console.log(`Progress: ${label} exit=${result.status}; elapsed=${record.elapsedMs}ms`);
    if (result.error) break;
  }
}
fs.writeFileSync(join(directory, `${prefix}results.json`), JSON.stringify(records, null, 2));
console.log(`Progress: finished ${records.length} fresh processes; failures=${failures}`);
process.exitCode = failures ? 1 : 0;
