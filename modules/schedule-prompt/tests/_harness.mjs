// Shared harness: real Pi 1.1.0 CLI in rpc/print mode, offline scripted provider, isolated home/agentDir/workspace.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, makeSandbox, root } from '../../../tests/helpers/regression/run-cli.mjs';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';

export { makeSandbox, root };
const here = dirname(fileURLToPath(import.meta.url));
export const scheduleEntry = join(root, 'modules/schedule-prompt/src/index.ts');
export const probePath = join(here, '_probe.ts');
// run-cli.mjs still points providerPath at the removed defect-repro/helpers; resolve the relocated provider directly.
export const providerFile = join(root, 'tests/helpers/regression/scripted-provider.ts');
export const log = m => console.error(`[schedule-prompt] ${m}`);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll a condition (barrier with an upper bound, not a fixed sleep). Returns the truthy value or undefined on limit. */
export async function waitUntil(fn, ms, label, every = 100) {
  const end = Date.now() + ms; let beat = Date.now();
  for (;;) {
    const v = await fn(); if (v) return v;
    if (Date.now() >= end) { log(`limit reached while waiting for: ${label}`); return undefined; }
    if (Date.now() - beat > 5000) { beat = Date.now(); log(`still waiting for: ${label}`); }
    await delay(every);
  }
}

export const job = (over) => ({ id: 'job-' + Math.random().toString(36).slice(2, 8), name: 'repro-job', enabled: true, type: 'interval',
  schedule: '1s', intervalMs: 1000, prompt: 'SCHEDULED_PROMPT_TEXT', runCount: 0, createdAt: new Date().toISOString(), ...over });
export const storePath = sb => join(sb.cwd, '.pi/schedule-prompts.json');
export async function writeStore(sb, jobs) {
  await mkdir(join(sb.cwd, '.pi'), { recursive: true });
  await writeFile(storePath(sb), JSON.stringify({ version: 1, jobs }));
}
export const readStore = sb => readFile(storePath(sb), 'utf8').then(t => JSON.parse(t), () => ({ jobs: [] }));
export const readJsonl = path => readFile(path, 'utf8').then(t => t.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)), () => []);
export const textOf = m => (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

/** Copy test-only extensions to the (always trusted) global agentDir so an in-process child session discovers them. */
export async function installGlobalExtensions(sb, paths) {
  const dir = join(sb.agentDir, 'extensions'); await mkdir(dir, { recursive: true });
  for (const p of paths) await copyFile(p, join(dir, p.split(/[\\/]/).at(-1)));
}

/**
 * Start the real Pi CLI. mode 'rpc' keeps stdin open; mode 'json'/'text' runs -p with the given prompt.
 * Returns an object with send, events, stdout, stderr, badLines, waitFor, finish and file paths.
 */
export function startPi(sb, { script = [], extensions = [], mode = 'rpc', approve = false, prompt = 'Do the task.', env = {}, extraArgs = [], label = 'pi' }) {
  const paths = { script: join(sb.home, 'script.json'), requests: join(sb.home, 'requests.jsonl'), events: join(sb.home, 'events.jsonl'), timers: join(sb.home, 'timers.jsonl') };
  const ready = writeFile(paths.script, JSON.stringify(script));
  const argv = [cli, ...(mode === 'rpc' ? ['--mode', 'rpc'] : mode === 'json' ? ['-p', '--mode', 'json'] : ['-p']),
    '--offline', approve ? '--approve' : '--no-approve', '--no-extensions', '--no-skills', '--no-themes', '--no-context-files', '--no-prompt-templates',
    '-e', providerFile, ...extensions.flatMap(e => ['-e', e]), '--model', 'repro-offline/fixture', '--thinking', 'off', ...extraArgs, ...(mode === 'rpc' ? [] : [prompt])];
  const childEnv = { ...isolatedEnv(sb.home), REPRO_SCRIPT: paths.script, REPRO_LOG: paths.requests, REPRO_EVENTS: paths.events, REPRO_TIMER_LOG: paths.timers, ...env };
  const state = { events: [], stdout: '', stderr: '', badLines: [], waiters: new Set(), closed: false, code: undefined };
  let child, closedP;
  const started = ready.then(() => {
    log(`[${label}] starting real Pi CLI (${mode}, offline, ${approve ? 'trusted' : 'untrusted'})`);
    child = spawn(process.execPath, argv, { cwd: sb.cwd, env: childEnv, stdio: [mode === 'rpc' ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      state.stdout += d; buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (!line.trim()) continue;
        try { const ev = JSON.parse(line); state.events.push(ev); for (const w of [...state.waiters]) w(); } catch { state.badLines.push(line); }
      }
    });
    child.stderr.on('data', d => { state.stderr += d; });
    closedP = new Promise(r => child.on('close', (code) => { state.closed = true; state.code = code; for (const w of [...state.waiters]) w(); r(code); }));
    child.on('error', e => { state.stderr += String(e); });
  });
  const beat = setInterval(() => log(`[${label}] still running...`), 10000); beat.unref();
  return Object.assign(state, {
    paths, started,
    async send(obj) { await started; child.stdin.write(JSON.stringify(obj) + '\n'); },
    /** Resolve with the first event matching pred (checking existing events first), or undefined after ms / process exit. */
    waitFor(pred, ms, what) {
      return new Promise(resolve => {
        let timer;
        const cleanup = () => { clearTimeout(timer); state.waiters.delete(check); };
        const check = () => { const ev = state.events.find(pred); if (ev || state.closed) { cleanup(); resolve(ev); } };
        timer = setTimeout(() => { cleanup(); log(`[${label}] limit reached waiting for ${what}`); resolve(undefined); }, ms);
        state.waiters.add(check); check();
      });
    },
    async finish(ms = 20000) {
      await started; clearInterval(beat);
      try { child.stdin?.end(); } catch {}
      const to = setTimeout(() => child.kill('SIGKILL'), ms);
      await closedP; clearTimeout(to);
      log(`[${label}] exit=${state.code}`);
      return state;
    },
  });
}
export const toolResults = (pi, name) => pi.events.filter(e => e.type === 'message_end' && e.message?.role === 'toolResult' && (!name || e.message.toolName === name)).map(e => e.message);
export const toolCall = (name, args, id = 'call-' + name) => ({ type: 'toolCall', id, name, arguments: args });
