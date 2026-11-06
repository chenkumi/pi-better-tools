// Parent-side harness: follows modules/fork/src/child.ts (verified -> tool-set check -> stats -> prompt -> settled -> result) against a PTY child.
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from 'node-pty';
import { writeForkSession } from '../../modules/fork/src/snapshot.ts';
import { CHANNEL } from '../../modules/fork/src/child-guard.ts';

const ext = resolve('tools/mux-text-spike/fork-ext.ts');
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

async function runChild({ modelOverride, tools = ['nap'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'spike-fork-'));
  const cwd = join(realpathSync.native(home), 'work'); mkdirSync(cwd, { recursive: true });
  const parentId = randomUUID(), childId = randomUUID(), token = 'tok-' + randomUUID();
  const now = new Date().toISOString();
  const branch = [
    { type: 'message', id: 'u0000001', parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'parent hello' }], timestamp: Date.now() } },
    { type: 'message', id: 'a0000001', parentId: 'u0000001', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'parent answer' }], provider: 'spike', api: 'spike-api', model: 'fixture',
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: 'stop', timestamp: Date.now() } },
  ];
  const written = writeForkSession({ sessionId: parentId, cwd, sessionDir: join(home, 'parent-sessions'), branch }, 'FORKJOB1', childId);
  const guardJson = { forkId: 'FORKJOB1', sessionId: childId, parentSessionId: parentId, cwd, model: modelOverride ?? 'spike/fixture', thinkingLevel: 'off', childTrusted: false, tools, loadable: [], token };

  const log = []; let sock, exited; const waiters = [];
  const notify = () => { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1); };
  const find = pred => log.find(pred);
  const until = (pred, ms = 20000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); const c = () => { const v = find(pred); if (v || exited) { clearTimeout(t); res(v); return true; } }; if (!c()) waiters.push(c); });
  const server = createServer(s => { sock = s; s.on('error', () => {}); let buf = ''; s.on('data', d => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { log.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); notify(); } }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const p = pty.spawn(process.execPath, [cli, '--mode', 'tui', '-e', ext, '--no-extensions', '--session', written.sessionPath, '--session-dir', join(home, 'child-sessions'), '--model', 'spike/fixture', '--thinking', 'off', '--tools', tools.join(','), '--no-approve'].filter(a => a !== '--mode' && a !== 'tui'), {
    cwd, cols: 100, rows: 30, env: { ...process.env, PI_FORK_GUARD: JSON.stringify(guardJson), SPIKE_PORT: String(server.address().port), PI_CODING_AGENT_DIR: join(home, 'agent'), HOME: home, USERPROFILE: home } });
  p.onExit(e => { exited = e; notify(); });
  const send = o => sock.write(JSON.stringify(o) + '\n');
  const ipc = type => m => m.ipc?.channel === CHANNEL && m.ipc?.token === token && m.ipc?.type === type;
  const stop = () => { try { p.kill(); } catch {} server.close(); };
  return { written, childId, parentId, until, ipc, send, log, stop, get exited() { return exited; } };
}

console.log('== A. accepted handshake');
if (!process.env.SPIKE_SKIP_A) {
  const c = await runChild();
  const verified = await c.until(c.ipc('verified'));
  check('child sends verified over the shimmed channel', !!verified?.ipc, c.exited ? 'child exited ' + JSON.stringify(c.exited) : '');
  if (verified?.ipc) {
    check('tool set equals the parent selection', JSON.stringify(verified.ipc.tools) === JSON.stringify(['nap']), JSON.stringify(verified.ipc.tools));
    check('sessionFile equals the snapshot path', verified.ipc.sessionFile === c.written.sessionPath && existsSync(verified.ipc.sessionFile));
    await c.until(m => m.type === 'hello'); await sleep(500);
    c.send({ type: 'stats' }); const before = await c.until(m => m.type === 'stats');
    check('stats before prompt cover the inherited history', before.assistantMessages === 1 && before.tokens.total === 18, `assistants=${before.assistantMessages} total=${before.tokens.total}`);
    c.send({ type: 'prompt', text: 'tools do the task' });
    const started = await c.until(m => m.type === 'agent_start');
    check('prompt starts a run (agent_start)', !!started);
    const settled = await c.until(c.ipc('settled'));
    check('guard reports settled quiet', settled?.ipc?.quiet === true);
    const last = [...c.log].reverse().find(m => m.type === 'message_end' && m.role === 'assistant');
    check('last assistant text is available from events', /echo\(2 user msgs\)/.test(last?.text ?? ''), last?.text);
    c.send({ type: 'stats' }); const after = (await c.until(m => m.type === 'stats' && m !== before));
    const afterStats = [...c.log].reverse().find(m => m.type === 'stats');
    const delta = afterStats.tokens.total - before.tokens.total;
    check('usage delta = this Fork run only (2 requests x 18)', delta === 36 && Math.abs(afterStats.tokens.cost - before.tokens.cost - 0.002) < 1e-9, `delta=${delta}`);
    check('child kept running (RPC-free) and is still alive', !c.exited);
  }
  c.stop();
}

console.log('\n== B. rejected handshake (model differs from the parent selection)');
{
  const c = await runChild({ modelOverride: 'spike/other' });
  await c.until(c.ipc('rejected'), 15000); await sleep(1000); const rejected = c.log.find(c.ipc('rejected'));
  check('child sends rejected MODEL_UNAVAILABLE', rejected?.ipc?.code === 'MODEL_UNAVAILABLE', JSON.stringify(rejected?.ipc ?? c.exited));
  await sleep(1500);
  check('child exits non-zero', c.exited?.exitCode === 1, JSON.stringify(c.exited));
  c.stop();
}

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
