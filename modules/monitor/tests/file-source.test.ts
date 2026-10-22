import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import monitorExtension from '../src/index.ts';
import { fileLaunch, resolveFilePath } from '../src/sources.ts';
import { validateStart } from '../src/schema.ts';
import type { Clock, MonitorRuntime } from '../src/core.ts';

function manual() {
  const tasks = new Map<number, () => void>(); let next = 0;
  const clock: Clock = { now: () => 0, set: (fn) => { const id = ++next; tasks.set(id, fn); return id; }, clear: (id) => { tasks.delete(id as number); } };
  const fire = () => { const entry = [...tasks][0]; if (!entry) return false; tasks.delete(entry[0]); entry[1](); return true; };
  return { clock, fire, pending: () => tasks.size };
}
function sink() {
  const events: any[] = [];
  return { events, started: () => events.push(['started']), data: (_t: unknown, _p: boolean, snapshot?: unknown) => events.push(['data', snapshot]), stderr: () => {}, fault: (kind: string) => events.push(['fault', kind]), closed: (evidence: unknown, failed?: boolean) => events.push(['closed', evidence, failed ?? false]) };
}
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-file-')));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const changes = (s: ReturnType<typeof sink>) => s.events.filter(e => e[0] === 'data').map(e => e[1].change);

test('file source accepts a bounded path and refuses unknown fields or an unbounded interval', () => {
  assert.equal(validateStart({ source: { kind: 'file', path: 'a.txt' } }).source.kind, 'file');
  assert.equal((validateStart({ source: { kind: 'file', path: 'a.txt', intervalMs: 1000 } }).source as any).intervalMs, 1000);
  assert.throws(() => validateStart({ source: { kind: 'file' } }), /bounded text/);
  assert.throws(() => validateStart({ source: { kind: 'file', path: '' } }));
  assert.throws(() => validateStart({ source: { kind: 'file', path: 'a.txt', intervalMs: 999 } }), /integer 1000/);
  assert.throws(() => validateStart({ source: { kind: 'file', path: 'a.txt', content: true } }), /Unknown Monitor parameter/);
  assert.throws(() => validateStart({ source: { kind: 'file', path: 'a\nb' } }), /control/);
});

test('resolveFilePath keeps the target inside the canonical workspace root', () => {
  const w = workspace();
  try {
    assert.equal(resolveFilePath(w.root, 'notes.txt').relative, 'notes.txt');
    assert.equal(resolveFilePath(w.root, join(w.root, 'sub', 'a.txt')).relative, join('sub', 'a.txt'));
    assert.throws(() => resolveFilePath(w.root, '../outside.txt'), /outside/);
    assert.throws(() => resolveFilePath(w.root, join(tmpdir(), 'elsewhere.txt')), /outside/);
    assert.throws(() => resolveFilePath(w.root, '.'), /file/);
    mkdirSync(join(w.root, 'dir'));
    assert.throws(() => resolveFilePath(w.root, 'dir'), /regular file/);
  } finally { w.done(); }
});

// A directory junction needs no privilege on Windows (a file symlink does) and is a plain directory symlink elsewhere.
test('resolveFilePath rejects a link that leaves the workspace, for existing and not-yet-created targets', () => {
  const w = workspace(), outside = workspace();
  try {
    writeFileSync(join(outside.root, 'secret.txt'), 'x');
    symlinkSync(outside.root, join(w.root, 'link'), 'junction');
    assert.throws(() => resolveFilePath(w.root, join('link', 'secret.txt')), /outside/);
    assert.throws(() => resolveFilePath(w.root, join('link', 'missing.txt')), /outside/);
  } finally { w.done(); outside.done(); }
});

test('file source reports metadata only and never the file content', async () => {
  const w = workspace(); const target = join(w.root, 'a.txt'); writeFileSync(target, 'SECRET-CONTENT');
  const { clock, fire } = manual(); const s = sink(); const controller = new AbortController();
  try {
    const done = fileLaunch(w.root, resolveFilePath(w.root, 'a.txt'), 1000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(s.events, [['started']], 'baseline sample must not emit an event');
    writeFileSync(target, 'SECRET-CONTENT-LONGER'); utimesSync(target, new Date(2030, 0, 1), new Date(2030, 0, 1));
    fire();
    const event = (s.events.filter(e => e[0] === 'data') as any[][])[0]![1];
    assert.equal(event.change, 'modified'); assert.equal(event.path, 'a.txt'); assert.equal(event.exists, true); assert.equal(event.sizeBytes, 21);
    assert.equal(typeof event.mtimeMs, 'number');
    assert.equal(JSON.stringify(s.events).includes('SECRET'), false);
    controller.abort(); await done;
  } finally { controller.abort(); w.done(); }
});

test('file source reports created, deleted and recreated transitions and nothing when unchanged', async () => {
  const w = workspace(); const target = join(w.root, 'a.txt');
  const { clock, fire } = manual(); const s = sink(); const controller = new AbortController();
  try {
    const done = fileLaunch(w.root, resolveFilePath(w.root, 'a.txt'), 1000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    fire(); assert.deepEqual(changes(s), [], 'absent and unchanged emits nothing');
    writeFileSync(target, 'one'); fire();
    fire(); assert.deepEqual(changes(s), ['created'], 'unchanged tick emits nothing');
    unlinkSync(target); fire();
    writeFileSync(target, 'two'); fire();
    assert.deepEqual(changes(s), ['created', 'deleted', 'created']);
    assert.deepEqual(s.events.filter(e => e[0] === 'data').map(e => e[1].exists), [true, false, true]);
    controller.abort(); await done;
  } finally { controller.abort(); w.done(); }
});

test('file source faults when its directory is swapped for a link that leaves the workspace', async () => {
  const w = workspace(), outside = workspace(); mkdirSync(join(w.root, 'd')); const target = join(w.root, 'd', 'a.txt'); writeFileSync(target, 'one');
  const { clock, fire } = manual(); const s = sink(); const controller = new AbortController();
  try {
    const done = fileLaunch(w.root, resolveFilePath(w.root, join('d', 'a.txt')), 1000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    writeFileSync(join(outside.root, 'a.txt'), 'x'); unlinkSync(target); rmSync(join(w.root, 'd'), { recursive: true });
    symlinkSync(outside.root, join(w.root, 'd'), 'junction');
    fire(); await done;
    assert.deepEqual(s.events.filter(e => e[0] === 'fault'), [['fault', 'path_outside_workspace']]);
    assert.equal(s.events.some(e => e[0] === 'data'), false);
    assert.equal(s.events.at(-1)[0], 'closed');
  } finally { controller.abort(); w.done(); outside.done(); }
});

test('file source abort leaves no timer and reports a source close without cancelling anything', async () => {
  const w = workspace(); writeFileSync(join(w.root, 'a.txt'), 'x');
  const { clock, pending, fire } = manual(); const s = sink(); const controller = new AbortController();
  try {
    const done = fileLaunch(w.root, resolveFilePath(w.root, 'a.txt'), 1000, clock)(s as any, controller.signal, Number.MAX_SAFE_INTEGER);
    assert.equal(pending(), 1);
    controller.abort(); await done;
    assert.deepEqual(s.events.at(-1), ['closed', { sourceClosed: true, timerCleared: true }, false]);
    assert.equal(pending(), 0); assert.equal(fire(), false);
    assert.equal(s.events.filter(e => e[0] === 'closed').length, 1);
  } finally { controller.abort(); w.done(); }
});

test('monitor_start accepts a file inside the workspace and rejects one outside before acceptance', async () => {
  const w = workspace(), outside = workspace(); writeFileSync(join(w.root, 'a.txt'), 'x'); writeFileSync(join(outside.root, 'b.txt'), 'x');
  const tools = new Map<string, any>(), handlers = new Map<string, any>(); let runtime!: MonitorRuntime;
  const { clock } = manual();
  monitorExtension({ registerMessageRenderer() {}, registerTool: (t: any) => tools.set(t.name, t), on: (name: string, fn: any) => handlers.set(name, fn), getActiveTools: () => ['monitor_start', 'monitor_status', 'monitor_stop'], sendMessage() {} } as any, { clock, onRuntime: r => { runtime = r; } });
  const ctx = { cwd: w.root, sessionManager: { getSessionId: () => 'file-source-extension' } };
  try {
    await handlers.get('session_start')({}, ctx);
    const start = (path: string) => tools.get('monitor_start').execute('direct', { source: { kind: 'file', path }, wakeAgent: false }, undefined, undefined, ctx);
    const rejected = await start(join(outside.root, 'b.txt'));
    assert.equal(rejected.isError, true); assert.match(rejected.structuredContent.error, /outside the workspace/);
    assert.equal((await start('../escape.txt')).isError, true);
    assert.deepEqual((await tools.get('monitor_status').execute('direct', {}, undefined, undefined, ctx)).structuredContent, { monitors: [] }, 'a rejected path must not leave a receipt');
    const accepted = await start('a.txt');
    assert.equal(accepted.isError, undefined); assert.equal(accepted.structuredContent.source, 'file'); assert.equal(accepted.structuredContent.sourcePreview, 'a.txt');
    await tools.get('monitor_stop').execute('direct', { monitorId: accepted.structuredContent.monitorId }, undefined, undefined, ctx);
    await runtime.settled(accepted.structuredContent.monitorId);
    assert.equal(runtime.status(accepted.structuredContent.monitorId).cleanupEvidence.sourceClosed, true);
  } finally { await handlers.get('session_shutdown')({}, ctx); w.done(); outside.done(); }
});
