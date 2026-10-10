// Shared helpers for defect-repro tests: isolated home/agentDir/workspace and a real Pi 1.1.0 CLI (print mode) runner.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../helpers/environment.mjs';

export const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const providerPath = join(root, 'tests/helpers/regression/scripted-provider.ts');
const hostPkg = join(root, 'node_modules/@earendil-works/pi-coding-agent');
export const cli = join(hostPkg, 'dist/bundle/cli.js');

export async function makeSandbox(label, settings = {}) {
  const home = await mkdtemp(join(tmpdir(), `repro-${label}-`));
  const agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), '{}');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false, ...settings }));
  return { home, agentDir, cwd, settingsPath: join(agentDir, 'settings.json'), cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }) };
}

export async function runCli(sandbox, { script, extensions = [], args = [], prompt = 'Do the task.', env = {}, timeoutMs = 90000, label = 'cli' }) {
  const scriptPath = join(sandbox.home, 'script.json'), logPath = join(sandbox.home, 'requests.jsonl');
  await writeFile(scriptPath, JSON.stringify(script));
  const argv = [cli, '-p', '--offline', '--no-approve', '--no-session', '--no-extensions', '--no-skills', '--no-themes', '--no-context-files', '--no-prompt-templates',
    '-e', providerPath, ...extensions.flatMap(e => ['-e', e]), '--model', 'repro-offline/fixture', '--thinking', 'off', ...args, prompt];
  const childEnv = { ...isolatedEnv(sandbox.home), REPRO_SCRIPT: scriptPath, REPRO_LOG: logPath, ...env };
  console.error(`[repro:${label}] starting real Pi CLI (offline)...`);
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, argv, { cwd: sandbox.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const beat = setInterval(() => console.error(`[repro:${label}] still running...`), 10000);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { clearInterval(beat); clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearInterval(beat); clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
  });
  const requests = await readFile(logPath, 'utf8').then(t => t.trim().split('\n').filter(Boolean).map(JSON.parse), () => []);
  console.error(`[repro:${label}] exit=${result.code} requests=${requests.length}`);
  return { ...result, requests };
}
