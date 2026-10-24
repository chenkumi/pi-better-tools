// Edge cases of the foreground auto-background safety net. Real extension + real host bash definition; only
// createLocalBashOperations is replaced by a controllable fake process backend. Event driven: autoBackgroundMs is 20 ms.
// Run: node --experimental-test-module-mocks --import tsx auto-background-edge-host.mjs <workdir>
import { mock } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const workDir = process.argv[2];
const home = join(workDir, 'home'), cwd = join(workDir, 'ws');
mkdirSync(join(home, '.pi/agent'), { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
delete process.env.PI_SHELL_TOOLS_CHILD; delete process.env.PI_SUBAGENTS_GUARD;

const sdk = await import('@earendil-works/pi-coding-agent');
const procs = new Map();
let seq = 0;
const fakeOps = () => ({
  async exec(command, _cwd, { onData, signal }) {
    if (command !== 'SLOW' && command !== 'SLOWBG') throw new Error(`unexpected fake command ${command}`);
    const id = ++seq;
    onData(Buffer.from('early\n'));
    return await new Promise((resolve, reject) => {
      const entry = { id, command, finish: code => { procs.delete(id); resolve({ exitCode: code ?? 0 }); } };
      procs.set(id, entry);
      signal?.addEventListener('abort', () => { procs.delete(id); reject(new Error('aborted')); }, { once: true });
    });
  },
});
mock.module('@earendil-works/pi-coding-agent', { exports: { ...sdk, createLocalBashOperations: fakeOps } });

const tools = new Map();
const pi = {
  registerTool: t => tools.set(t.name, t), registerShortcut() {}, registerMessageRenderer() {}, registerCommand() {},
  on() {}, sendMessage() {}, getActiveTools: () => ['bash', 'shell_job_status', 'shell_job_cancel'],
  getSettings: () => ({ 'pi-shell-tools': { autoBackgroundMs: 20 } }), events: { on() {}, emit() {} },
};
const { default: factory } = await import(new URL('../../extensions/timeout-ms.ts', import.meta.url).href);
factory(pi);
const { isForegroundDetachable } = await import(new URL('../../src/manual-detach.ts', import.meta.url).href);
const { MAX_TIMEOUT_MS } = await import(new URL('../../src/timeout-ms.mjs', import.meta.url).href);

const base = { cwd, mode: 'print', model: undefined, sessionManager: { getSessionId: () => 'S1', getSessionFile: () => undefined }, signal: undefined, isIdle: () => true };
const ctx = { ...base, hasUI: false, ui: {} };
const uiCtx = { ...base, hasUI: true, ui: { notify() {}, setStatus() {} } };
const bash = tools.get('bash');
const text = r => (r.content ?? []).map(b => b.text ?? '').join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (check, label) => { for (let i = 0; i < 20000; i++) { if (check()) return; await new Promise(r => setImmediate(r)); } throw new Error(`timeout waiting for ${label}`); };
const out = {};

// The documented "no timeout" sentinel is the same unbounded run as omitting timeoutMs: the safety net must apply.
let sentinelSettled = false;
const sentinel = bash.execute('s', { command: 'SLOW', timeoutMs: MAX_TIMEOUT_MS }, undefined, undefined, ctx).then(r => { sentinelSettled = true; return r; });
await waitFor(() => procs.size === 1, 'sentinel process start');
await Promise.race([sentinel, sleep(1500)]);
out.sentinel = { settled: sentinelSettled };
if (sentinelSettled) { const r = await sentinel; out.sentinel.receipt = Boolean(r.structuredContent?.jobId); out.sentinel.text = text(r).split('\n')[0]; }
for (const entry of [...procs.values()]) entry.finish(0);
await Promise.race([sentinel, sleep(500)]);
await sleep(300); // the adopted sentinel job completes and gives its slot back

// A rejected handoff (registry full) must not be final: the call stays detachable and is adopted once room appears.
const receipts = [];
for (let i = 0; i < 8; i++) {
  const r = await bash.execute(`c${i}`, { command: 'SLOWBG', background: true }, undefined, undefined, ctx);
  receipts.push(r.structuredContent?.jobId);
}
out.capacity = { activeReceipts: receipts.filter(Boolean).length };
let fgSettled = false;
const fg = bash.execute('c9', { command: 'SLOW' }, undefined, undefined, uiCtx).then(r => { fgSettled = true; return r; });
await waitFor(() => procs.size === 9, 'foreground process start');
await sleep(150);
out.capacity.settledWhileFull = fgSettled;
out.capacity.detachableWhileFull = isForegroundDetachable('c9');
// Free one slot: finish one background job's process (never the foreground one).
[...procs.values()].find(entry => entry.command === 'SLOWBG').finish(0);
await Promise.race([fg, sleep(1500)]);
out.capacity.settledAfterRoom = fgSettled;
if (fgSettled) { const r = await fg; out.capacity.receipt = Boolean(r.structuredContent?.jobId); out.capacity.text = text(r).split('\n')[0]; }
for (const entry of [...procs.values()]) entry.finish(0);
await Promise.race([fg, sleep(500)]);

console.log('AUTO_BG_EDGE_RESULT ' + JSON.stringify(out));
process.exit(0);
