import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalMonitorCwd, requestScheduledMonitor } from '../../../shared/src/background/index.ts';
import monitorExtension from '../src/index.ts';
import type { Clock } from '../src/core.ts';

const clock: Clock = { now: () => 0, set: () => 1, clear: () => {} };

async function load(active: string[], id: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-sched-')));
  writeFileSync(join(root, 'a.txt'), 'x');
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  monitorExtension({ registerMessageRenderer() {}, registerTool() {}, on: (name: string, fn: any) => handlers.set(name, fn), getActiveTools: () => [...active], sendMessage: (m: any) => sent.push(m) } as any, { clock });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => id } };
  await handlers.get('session_start')({}, ctx);
  const scope = { sessionId: id, cwd: canonicalMonitorCwd(root) };
  return { root, scope, sent, starter: requestScheduledMonitor(scope)!, done: async () => { await handlers.get('session_shutdown')({}, ctx); rmSync(root, { recursive: true, force: true }); } };
}

test('a starter is published per owner and revoked at shutdown', async () => {
  const m = await load(['monitor_start'], 'sched-owner');
  assert.ok(m.starter);
  assert.equal(requestScheduledMonitor({ sessionId: 'someone-else', cwd: m.scope.cwd }), undefined);
  await m.done();
  assert.equal(requestScheduledMonitor(m.scope), undefined);
});

test('start works for a file source, defaults wakeAgent to false, and isActive follows the monitor', async () => {
  const m = await load(['monitor_start'], 'sched-file');
  try {
    assert.equal(m.starter.validate({ source: { kind: 'file', path: 'a.txt' } }), undefined);
    const result = m.starter.start({ source: { kind: 'file', path: 'a.txt' }, label: 'scheduled' });
    assert.ok('monitorId' in result, JSON.stringify(result));
    assert.equal(m.starter.isActive((result as { monitorId: string }).monitorId), true);
    assert.equal(m.starter.isActive('does-not-exist'), false);
  } finally { await m.done(); }
});

test('refusals: monitor_start not enabled, shell tool not enabled, foreign sources, bad parameters', async () => {
  const off = await load([], 'sched-off');
  try {
    const result = off.starter.start({ source: { kind: 'file', path: 'a.txt' } });
    assert.match((result as { error: string }).error, /monitor_start is registered but not enabled/);
  } finally { await off.done(); }

  const m = await load(['monitor_start'], 'sched-refuse');
  try {
    assert.match((m.starter.start({ source: { kind: 'command', tool: 'bash', command: 'printf x' } }) as { error: string }).error, /MONITOR_SHELL_DISABLED/);
    assert.match(m.starter.validate({ source: { kind: 'websocket', url: 'wss://example.com/x' } }) ?? '', /not available to schedules/);
    assert.match((m.starter.start({ source: { kind: 'shell_job', jobId: 'x' } }) as { error: string }).error, /not available to schedules/);
    assert.match(m.starter.validate({ source: { kind: 'file', path: '../outside.txt' } }) ?? '', /outside the canonical workspace/);
    assert.ok(m.starter.validate({ source: { kind: 'bogus' } }));
  } finally { await m.done(); }
});
