// Actual extension/host shell definition; controlled execution and event boundaries only.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [root, hostRoot] = process.argv.slice(2);
for (const dir of ['home/.pi/agent', 'workspace', 'tmp', 'sessions']) fs.mkdirSync(path.join(root, dir), { recursive: true });
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(root, 'tmp');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'home/.pi/agent');
delete process.env.PI_SUBAGENTS_GUARD;
delete process.env.PI_SHELL_TOOLS_CHILD;
const sdk = await import(pathToFileURL(path.join(hostRoot, 'dist/index.js')).href);
assert.equal(sdk.VERSION, '1.4.0');
const tui = await import(pathToFileURL(createRequire(path.join(hostRoot, 'package.json')).resolve('@earendil-works/pi-tui')).href);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const executions = [];
mock.module('@earendil-works/pi-coding-agent', { exports: { ...sdk, createLocalBashOperations: () => ({ exec(_cmd, _cwd, options) {
  const end = deferred();
  const control = { signal: options.signal, aborts: 0, finish: () => end.resolve({ exitCode: 0 }) };
  const abort = () => { control.aborts++; end.reject(new Error('aborted')); };
  if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
  executions.push(control);
  return end.promise.finally(() => options.signal.removeEventListener('abort', abort));
} }) } });
mock.module('@earendil-works/pi-tui', { exports: { ...tui } });
const { default: extension } = await import('../../src/index.ts');
const manager = sdk.SessionManager.create(path.join(root, 'workspace'), path.join(root, 'sessions'));
manager.appendMessage({ role: 'user', content: 'Offline handoff cancellation regression', timestamp: Date.now() });
const hooks = new Map(), tools = new Map(), starts = new Map(), terminals = new Map();
let refuseAcceptance = false;
const refusal = deferred();
const eventPromise = (map, id) => { if (!map.has(id)) map.set(id, deferred()); return map.get(id).promise; };
const ctx = { cwd: path.join(root, 'workspace'), mode: 'print', hasUI: false, sessionManager: manager, ui: {}, isIdle: () => true };
const pi = { registerTool: t => tools.set(t.name, t), registerMessageRenderer() {}, registerToolRenderer() {}, registerCommand() {},
  on(n, f) { const list = hooks.get(n) ?? []; list.push(f); hooks.set(n, list); },
  events: { on() {}, emit() {} }, sendMessage() {}, getActiveTools: () => ['bash', 'shell_job_cancel'],
  getSettings: () => ({ 'pi-shell-tools': { autoBackgroundMs: 180000 } }),
  appendEntry(type, data) {
    if (refuseAcceptance && data.state === 'accepted') { refusal.resolve(); throw new Error('injected acceptance refusal'); }
    manager.appendCustomEntry(type, data); for (const [map, present] of [[starts, data.started && !data.terminal], [terminals, data.terminal]]) if (present) { eventPromise(map, data.jobId); map.get(data.jobId).resolve(data); } }
};
extension(pi);
const dispatch = (name, event = {}) => Promise.all((hooks.get(name) ?? []).map(f => f(event, ctx)));
const real = { setTimeout, clearTimeout, setImmediate, clearImmediate };
let threshold, immediates = [];
globalThis.setTimeout = (f, ms, ...args) => { if (ms === 180000) { threshold = { f: () => f(...args) }; return threshold; } return real.setTimeout(f, ms, ...args); };
globalThis.clearTimeout = h => { if (h === threshold) { threshold = undefined; return; } return real.clearTimeout(h); };
globalThis.setImmediate = (f, ...args) => { const h = { f: () => f(...args) }; immediates.push(h); return h; };
globalThis.clearImmediate = h => { h.cancelled = true; };
const release = () => { const h = immediates.shift(); assert.ok(h, 'deferred runner boundary'); if (!h.cancelled) h.f(); };
const foreground = async turn => {
  const pending = tools.get('bash').execute('call', { command: 'CONTROLLED' }, turn?.signal, undefined, ctx);
  const execution = executions.at(-1);
  assert.ok(threshold); threshold.f();
  const receipt = (await pending).structuredContent;
  assert.equal(receipt.status, 'running');
  return { execution, receipt };
};
try {
  await dispatch('session_start');
  const turn = new AbortController();
  const first = await foreground(turn);
  assert.equal(executions.length, 1, 'handoff does not restart execution');
  const stopping = dispatch('session_shutdown', { reason: 'reload' });
  try {
    assert.equal(first.execution.signal.aborted, true, 'shutdown must synchronously cancel before deferred runner starts');
  } finally { release(); await stopping; first.execution.finish(); }
  assert.equal(first.execution.aborts, 1);

  await dispatch('session_start');
  const secondTurn = new AbortController();
  const second = await foreground(secondTurn);
  secondTurn.abort();
  assert.equal(second.execution.signal.aborted, false, 'accepted job is detached from turn cancellation');
  const started = eventPromise(starts, second.receipt.jobId); release(); await started;
  const ended = eventPromise(terminals, second.receipt.jobId);
  await dispatch('session_shutdown', { reason: 'quit' }); await ended;
  assert.equal(second.execution.aborts, 1, 'shutdown after runner starts also cancels');
  assert.equal((await ended).state, 'cancelled');

  await dispatch('session_start');
  const third = await foreground();
  await tools.get('shell_job_cancel').execute('cancel', { jobId: third.receipt.jobId }, undefined, undefined, ctx);
  assert.equal(third.execution.signal.aborted, true, 'explicit cancel works before deferred runner starts');
  const cancelled = eventPromise(terminals, third.receipt.jobId); release();
  assert.equal((await cancelled).state, 'cancelled');
  await dispatch('session_shutdown', { reason: 'quit' });
  await dispatch('session_start');
  refuseAcceptance = true;
  const refusedTurn = new AbortController(), before = executions.length;
  const refused = tools.get('bash').execute('refused', { command: 'CONTROLLED_REFUSAL' }, refusedTurn.signal, undefined, ctx);
  assert.ok(threshold); threshold.f(); await refusal.promise;
  const original = executions.at(-1);
  assert.equal(executions.length, before + 1, 'refused handoff never restarts the process');
  assert.equal(original.signal.aborted, false, 'refused adoption stays foreground until turn cancellation');
  refusedTurn.abort();
  await assert.rejects(refused, /aborted/);
  assert.equal(original.aborts, 1, 'turn still owns the original execution after admission refusal');
  refuseAcceptance = false;
  await dispatch('session_shutdown', { reason: 'quit' });
  console.log('HANDOFF_CANCEL_PASS shutdown-before-start shutdown-after-start cancel-before-start turn-detachment admission-refusal');
} finally {
  for (const e of executions) e.finish();
  while (immediates.length) release();
  await dispatch('session_shutdown', { reason: 'quit' });
  Object.assign(globalThis, real); mock.restoreAll();
}
