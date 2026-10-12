import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { isolatedEnv } from '../helpers/environment.mjs';

// Exercise the actual production fixture's barrier without starting Pi, sockets or timers.
const fixture = await readFile(new URL('../fixtures/monitor-production.mjs', import.meta.url), 'utf8');
const start = fixture.indexOf('const observations = [], waiters = new Map();');
const end = fixture.indexOf('const server = new WebSocketServer', start);
assert.ok(start >= 0 && end > start, 'production notification-barrier anchors must exist');
function barrier() {
  let notify;
  const context = { assert, session: { subscribe: listener => { notify = listener; } } };
  runInNewContext(fixture.slice(start, end) + '\nglobalThis.subject = { terminal, waiters };', context);
  return { ...context.subject, send: row => notify({ type: 'message_end', message: { customType: 'monitor_event', details: { monitors: [row] } } }) };
}
const row = (state, extra = {}) => ({ monitorId: 'OWNED-MONITOR', state, stopReason: state === 'completed' ? 'source_closed' : 'source_error',
  cleanupPending: false, cleanupEvidence: { sourceClosed: true }, ...extra });
async function observe(promise) {
  const result = { state: 'pending' };
  promise.then(() => { result.state = 'resolved'; }, error => { result.state = 'rejected'; result.error = error; });
  await Promise.resolve();
  return result;
}

test('isolated env preserves only the required OS install directories, not credentials/settings/child markers', () => {
  const values = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    OPENAI_API_KEY: 'inert-test-only', PI_WEB_TOOLS_CONFIG: 'inert-settings-path', PI_SUBAGENTS_GUARD: 'inert-child-marker' };
  const saved = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    const env = isolatedEnv('isolated-test-home');
    assert.equal(env.ProgramFiles, values.ProgramFiles);
    assert.equal(env['ProgramFiles(x86)'], values['ProgramFiles(x86)']);
    for (const key of ['OPENAI_API_KEY', 'PI_WEB_TOOLS_CONFIG', 'PI_SUBAGENTS_GUARD']) assert.equal(env[key], undefined);
    assert.equal(env.HOME, 'isolated-test-home');
    assert.equal(env.PI_CODING_AGENT_DIR, join('isolated-test-home', '.pi/agent'));
    assert.equal(env.PI_BLACKHOLE_PASSIVE, 'true');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

for (const state of ['failed', 'stopped', 'expired', 'limited']) {
  test(`production barrier rejects ${state} notifications received before wait registration`, async () => {
    const b = barrier();
    b.send(row(state, { cleanupPending: true, cleanupEvidence: { sourceClosed: false, startupFailed: true } }));
    const result = await observe(b.terminal('OWNED-MONITOR'));
    assert.equal(result.state, 'rejected');
    assert.match(String(result.error), new RegExp(`OWNED-MONITOR.*${state}.*source_error`));
    assert.match(String(result.error), /cleanupPending.*true.*sourceClosed.*false/);
    assert.equal(b.waiters.size, 0);
  });
  test(`production barrier rejects ${state} notifications received after wait registration`, async () => {
    const b = barrier();
    const promise = b.terminal('OWNED-MONITOR');
    b.send(row(state));
    const result = await observe(promise);
    assert.equal(result.state, 'rejected');
    assert.match(String(result.error), new RegExp(`OWNED-MONITOR.*${state}.*source_error`));
    assert.equal(b.waiters.size, 0);
  });
}

test('completed barrier still requires actual source close and no pending cleanup', async () => {
  const b = barrier();
  b.send(row('completed', { cleanupEvidence: { sourceClosed: false } }));
  const promise = b.terminal('OWNED-MONITOR');
  const result = await observe(promise);
  assert.equal(result.state, 'pending');
  b.send(row('completed', { cleanupPending: true }));
  await Promise.resolve(); assert.equal(result.state, 'pending');
  b.send(row('completed')); await Promise.resolve();
  assert.equal(result.state, 'resolved'); assert.equal(b.waiters.size, 0);
});

test('success already observed resolves; starting/running/stopping remain pending', async () => {
  const b = barrier();
  for (const state of ['starting', 'running', 'stopping']) b.send(row(state));
  const promise = b.terminal('OWNED-MONITOR');
  const result = await observe(promise);
  assert.equal(result.state, 'pending');
  b.send(row('completed')); await Promise.resolve(); assert.equal(result.state, 'resolved');
  assert.equal((await observe(b.terminal('OWNED-MONITOR'))).state, 'resolved');
});
