import test from 'node:test';
import assert from 'node:assert/strict';
import { execMonitorCommand, requireMonitorArgvConfig } from '../src/monitor-exec.ts';
import { EventEmitter } from 'node:events';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { pathToFileURL } from 'node:url';
test('Monitor refuses legacy stdin command transport before spawn and never falls back', () => {
  assert.throws(() => requireMonitorArgvConfig({ shell: 'legacy-wsl', args: ['-s'], commandTransport: 'stdin' }), /stdin command transport/);
  assert.doesNotThrow(() => requireMonitorArgvConfig({ shell: 'bash', args: ['-c'] }));
});
const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'exec-review', getSessionFile: () => undefined } };
const callbacks = () => { const seen: any[] = []; return { seen, events: { stdout: (b: Buffer) => seen.push(['stdout', b.toString()]), stderr: (b: Buffer) => seen.push(['stderr', b.toString()]), started: () => seen.push(['spawn']), closed: (...args: any[]) => seen.push(['close', ...args]) } }; };
test('review adapter W2: effective shell normalization/prefix, helper cancellation and actual close vs exit', async () => {
  const shell = getShellConfig().shell, controller = new AbortController(), c = callbacks();
  const child: any = new EventEmitter(); child.pid = 43210; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const helpers: any[] = []; let spawnArgs: any[], entered!: () => void; const spawned = new Promise<void>(r => { entered = r; });
  const backend = { getShellEnv: () => ({ FIXTURE_ENV: 'effective' }), trackDetachedChildPid: (pid: number) => helpers.push(['track', pid]), killProcessTree: (pid: number) => helpers.push(['kill', pid]), untrackDetachedChildPid: (pid: number) => helpers.push(['untrack', pid]) };
  let settled = false;
  const done = execMonitorCommand({ getSettings: () => ({ shellPath: pathToFileURL(shell).href, shellCommandPrefix: 'export OFFLINE_PREFIX=effective' }) } as any, ctx, 'bash', 'printf command', controller.signal, c.events, { loadBackend: async () => backend, spawn: ((...args: any[]) => { spawnArgs = args; entered(); return child; }) as any }).then(() => { settled = true; });
  await spawned; assert.equal(spawnArgs![0], shell); assert.equal(spawnArgs![1].at(-1), 'export OFFLINE_PREFIX=effective\nprintf command'); assert.deepEqual(spawnArgs![2].stdio, ['ignore', 'pipe', 'pipe']); assert.equal(spawnArgs![2].env.FIXTURE_ENV, 'effective');
  child.emit('spawn'); child.stdout.emit('data', Buffer.from('output')); child.stderr.emit('data', Buffer.from('diagnostic'));
  controller.abort(); assert.deepEqual(helpers, [['track', 43210], ['kill', 43210]]);
  child.emit('exit', 0, null); await Promise.resolve(); assert.equal(settled, false); assert.equal(c.seen.some(x => x[0] === 'close'), false);
  child.emit('close', 0, null); await done; assert.deepEqual(c.seen, [['spawn'], ['stdout', 'output'], ['stderr', 'diagnostic'], ['close', 0, null, false]]); assert.deepEqual(helpers.at(-1), ['untrack', 43210]); assert.equal(child.stdout.listenerCount('data'), 0);
});
test('review adapter W2: pre-abort and abort during held backend load never spawn; missing backend fails closed', async () => {
  let spawns = 0, loads = 0; const spawn = (() => { spawns++; throw new Error('MUST_NOT_SPAWN'); }) as any;
  const pre = new AbortController(); pre.abort(); const c = callbacks();
  await execMonitorCommand({ getSettings: () => { throw new Error('MUST_NOT_READ_SETTINGS'); } } as any, ctx, 'bash', 'never', pre.signal, c.events, { spawn }); assert.equal(spawns, 0); assert.equal(c.seen.length, 1);
  let release!: (backend: Record<string, unknown>) => void, entered!: () => void; const loading = new Promise<void>(r => { entered = r; });
  const held = new AbortController(), d = callbacks(); const pi = { getSettings: () => ({}) } as any;
  const pending = execMonitorCommand(pi, ctx, 'bash', 'never', held.signal, d.events, { spawn, loadBackend: () => { loads++; entered(); return new Promise(r => { release = r; }); } });
  await loading; held.abort(); release({ getShellEnv() {}, killProcessTree() {}, trackDetachedChildPid() {}, untrackDetachedChildPid() {} }); await pending; assert.equal(spawns, 0); assert.equal(loads, 1); assert.equal(d.seen[0][0], 'close');
  await assert.rejects(execMonitorCommand(pi, ctx, 'bash', 'never', new AbortController().signal, callbacks().events, { spawn, loadBackend: async () => ({}) }), /lacks required/); assert.equal(spawns, 0);
});
