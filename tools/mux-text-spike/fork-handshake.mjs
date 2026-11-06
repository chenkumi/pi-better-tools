// Parent-side harness: follows modules/fork/src/child.ts (verified -> tool-set check -> stats -> prompt -> settled -> result) against a PTY child.
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from 'node-pty';
import { spawnSync } from 'node:child_process';
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
  return { written, childId, parentId, until, ipc, send, log, stop, get pid() { return p.pid; }, ptyKill: () => p.kill(), get exited() { return exited; } };
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

console.log('\n== C. provider cache identity (headers + payload hooks run by Pi)');
{
  const c = await runChild();
  await c.until(c.ipc('verified')); await c.until(m => m.type === 'hello'); await sleep(500);
  const probes = () => c.log.filter(m => m.type === 'probe');
  c.send({ type: 'prompt', text: 'first turn' }); await c.until(c.ipc('settled'));
  const first = probes()[0];
  const h = first?.headers ?? {};
  check('the provider default (options.sessionId) is the child own id, so the override matters', first?.ownSessionId === c.childId, `${first?.ownSessionId}`);
  check('final session_id header is the parent session id', h.session_id === c.parentId, `${h.session_id}`);
  check('final x-client-request-id header is the parent session id', h['x-client-request-id'] === c.parentId, `${h['x-client-request-id']}`);
  check('the hook wrote only identity headers it owns', Object.keys(first?.hookHeaders ?? {}).sort().join() === 'session_id,x-client-request-id', Object.keys(first?.hookHeaders ?? {}).join());
  check('payload prompt_cache_key is the parent session id', first?.payloadWithKey?.prompt_cache_key === c.parentId, `${first?.payloadWithKey?.prompt_cache_key}`);
  check('payload without prompt_cache_key is not given one', !('prompt_cache_key' in (first?.payloadWithoutKey ?? {})));
  c.send({ type: 'prompt', text: 'second turn' }); await c.until(c.ipc('settled')); await sleep(300);
  const second = probes().at(-1);
  check('a later turn also uses the parent identity', probes().length >= 2 && second?.headers?.session_id === c.parentId && second?.payloadWithKey?.prompt_cache_key === c.parentId, `probes=${probes().length}`);
  c.stop();
}

console.log('\n== D. blocked path (model error while a nested job is still pending)');
{
  const c = await runChild();
  await c.until(c.ipc('verified')); await c.until(m => m.type === 'hello'); await sleep(500);
  const ipcs = type => c.log.filter(c.ipc(type));
  c.send({ type: 'jobs', n: 1 });
  c.send({ type: 'prompt', text: 'fail now' });
  const blocked = (await c.until(c.ipc('blocked'), 15000))?.ipc;
  check('guard reports blocked MODEL_ERROR', blocked?.reason === 'MODEL_ERROR', JSON.stringify(blocked));
  check('blocked carries the provider error text', /usage limit/.test(blocked?.error ?? ''), blocked?.error);
  check('blocked carries the pending job counts', blocked?.pending?.shell === 1 && blocked?.pending?.subagents === 0, JSON.stringify(blocked?.pending));
  await sleep(3000);
  check('blocked is not repeated for an unchanged signature', ipcs('blocked').length === 1, `count=${ipcs('blocked').length}`);
  check('no settled while the nested job is pending (blocked never claims success)', ipcs('settled').length === 0);
  c.send({ type: 'jobs', n: 0 });
  await c.until(c.ipc('unblocked'), 8000);
  check('unblocked is sent when the nested job ends', ipcs('unblocked').length === 1);
  await c.until(c.ipc('settled'), 8000);
  check('settled quiet follows once the child is quiet', ipcs('settled')[0]?.ipc?.quiet === true);
  c.stop();
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const info = (name, value) => console.log(`  INFO  ${name}: ${value}`);
const TOOLS = ['nap', 'spawn_bg', 'hang'];
const ready = async c => { await c.until(c.ipc('verified')); await c.until(m => m.type === 'hello'); await sleep(500); };
const leaked = [];

console.log('\n== E. cancel and process-tree cleanup');
console.log('-- E1 abort of a blocked tool (side-channel abort)');
{
  const c = await runChild({ tools: TOOLS }); await ready(c);
  c.send({ type: 'prompt', text: 'hang please' }); await c.until(m => m.type === 'hang_started');
  c.send({ type: 'abort' });
  const released = await c.until(m => m.type === 'hang_aborted', 8000);
  check('the blocked tool receives the abort signal', released?.aborted === true);
  const before = c.log.filter(m => m.type === 'agent_settled').length;
  await c.until(m => m.type === 'agent_settled' && c.log.filter(x => x.type === 'agent_settled').length > before - 1, 8000);
  await sleep(500);
  check('the run settles after the abort and the child stays alive', !c.exited && c.log.some(m => m.type === 'agent_settled'));
  c.stop();
}
console.log('-- E2 orderly shutdown over the side channel while idle');
{
  const c = await runChild({ tools: TOOLS }); await ready(c);
  c.send({ type: 'prompt', text: 'spawnbg now' }); const gc = await c.until(m => m.type === 'grandchild'); await c.until(c.ipc('settled'));
  c.send({ type: 'shutdown' });
  await c.until(m => m.type === 'shutdown_event', 8000); await sleep(1500);
  check('session_shutdown fires and the child exits cleanly', !!c.exited && c.exited.exitCode === 0, JSON.stringify(c.exited));
  info('grandchild alive after orderly shutdown', alive(gc.pid)); if (alive(gc.pid)) leaked.push(gc.pid);
  c.stop();
}
console.log('-- E3 shutdown requested while a tool is blocked');
{
  const c = await runChild({ tools: TOOLS }); await ready(c);
  c.send({ type: 'prompt', text: 'hang again' }); await c.until(m => m.type === 'hang_started');
  c.send({ type: 'shutdown' }); await sleep(3000);
  info('child exited 3 s after shutdown with the tool still blocked', !!c.exited);
  info('shutdown_event seen', c.log.some(m => m.type === 'shutdown_event'));
  if (!c.exited) { c.send({ type: 'abort' }); await sleep(3000); info('child exited after an additional abort', !!c.exited); }
  c.stop();
}
console.log('-- E4 PTY owner kills the child (pty.kill)');
{
  const c = await runChild({ tools: TOOLS }); await ready(c);
  c.send({ type: 'prompt', text: 'spawnbg now' }); const gc = await c.until(m => m.type === 'grandchild'); await c.until(c.ipc('settled'));
  check('grandchild is running before the kill', alive(gc.pid));
  c.ptyKill(); await sleep(2500);
  info('child exited after pty.kill', !!c.exited);
  info('grandchild alive after pty.kill', alive(gc.pid)); if (alive(gc.pid)) leaked.push(gc.pid);
  c.stop();
}
console.log('-- E5 tree kill by pid (taskkill /T /F, what Subagent/Fork use on Windows)');
{
  const c = await runChild({ tools: TOOLS }); await ready(c);
  c.send({ type: 'prompt', text: 'spawnbg now' }); const gc = await c.until(m => m.type === 'grandchild'); await c.until(c.ipc('settled'));
  check('grandchild is running before the tree kill', alive(gc.pid));
  // Never signal a pid that is not a real Pi process: pid 0 is the System Idle Process and would make taskkill walk the system tree.
  if (!Number.isInteger(c.pid) || c.pid <= 4) throw new Error(`refusing to taskkill invalid pid ${c.pid}`);
  const ppid = Number(spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${gc.pid}").ParentProcessId`], { encoding: 'utf8' }).stdout.trim());
  check('c.pid is the Pi process (it is the grandchild parent)', ppid === c.pid, `grandchild ppid=${ppid} c.pid=${c.pid}`);
  spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); await sleep(2500);
  check('tree kill stops the child', !!c.exited || !alive(c.pid));
  check('tree kill also stops the grandchild', !alive(gc.pid));
  if (alive(gc.pid)) leaked.push(gc.pid);
  c.stop();
}
for (const pid of leaked) { try { process.kill(pid); } catch {} }
info('leaked grandchildren cleaned up by the harness', leaked.length);

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
