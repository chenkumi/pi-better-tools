// Agent-facing error text: each message names the parameter, the violated rule, a bounded received value and the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import monitorExtension from '../src/index.ts';
import { MonitorRuntime, type Clock } from '../src/core.ts';
import { parseEndpoint, prepareEndpoint } from '../src/network.ts';
import { startSchema, validateMonitorId, validateStart } from '../src/schema.ts';
import { resolveFilePath, websocketLaunch } from '../src/sources.ts';

test('monitorId validation splits missing, wrong type, empty, too long and unknown keys', () => {
  assert.throws(() => validateMonitorId({}, true, 'monitor_stop'), /monitor_stop: "monitorId" is required; pass the monitorId returned by monitor_start \(list ids with monitor_status\)/);
  assert.throws(() => validateMonitorId({ monitorId: 5 }, false, 'monitor_status'), /monitor_status: "monitorId" must be a string; received 5/);
  assert.throws(() => validateMonitorId({ monitorId: '' }, true, 'monitor_stop'), /"monitorId" must not be empty/);
  assert.throws(() => validateMonitorId({ monitorId: 'x'.repeat(129) }, false, 'monitor_status'), /"monitorId" is 129 characters, over the 128 limit/);
  assert.throws(() => validateMonitorId({ monitorId: 'A', other: 1 }, false, 'monitor_status'), /Unknown Monitor parameter "other": monitor_status accepts monitorId/);
  assert.throws(() => validateMonitorId(null, false, 'monitor_status'), /monitor_status arguments must be an object; received null/);
  assert.deepEqual(validateMonitorId({}, false, 'monitor_status'), { monitorId: undefined });
});

test('stopAfterEvents range is a count, source kind lists every source, label rules are distinguished', () => {
  const err = (value: unknown) => { try { validateStart(value); } catch (e) { return (e as Error).message; } return ''; };
  const file = { kind: 'file', path: 'a.txt' };
  assert.match(err({ source: file, stopAfterEvents: 0 }), /"stopAfterEvents" 0 is out of range: use an integer 1–600 \(counts adopted data events\)/);
  assert.doesNotMatch(err({ source: file, stopAfterEvents: 0 }), / ms/);
  assert.match(err({ source: { kind: 'nope' } }), /use command, websocket, shell_job, subagent_job, fork_job, file/);
  assert.match(err({ source: file, label: 5 }), /"label" must be a string; received 5/);
  assert.match(err({ source: file, label: 'x'.repeat(81) }), /"label" is 81 characters \(81 bytes\), over the 80 character \/ 320 byte limit; shorten it or omit label/);
  assert.equal(Value.Check(startSchema, { source: { kind: 'nope' } }), true, 'kind is checked by validateStart so its message reaches the agent');
});

test('websocket URL errors state the rule and the expected form without echoing the URL', () => {
  const err = (source: any) => { try { parseEndpoint(source); } catch (e) { return (e as Error).message; } return ''; };
  assert.match(err({ url: 7 }), /^INVALID_URL: websocket source "url" must be a string; use ws:\/\/ or wss:\/\/host\[:port\]\/path/);
  assert.match(err({ url: 'wss://h/' + 'a'.repeat(9000) }), /^INVALID_URL: websocket source "url" is \d+ bytes, over the 8192 limit; shorten it/);
  assert.match(err({ url: 'not a url' }), /^INVALID_URL: websocket source "url" is not an absolute URL; use ws:\/\/ or wss:\/\//);
  assert.match(err({ url: 'https://example.org/' }), /^INVALID_URL: websocket source "url" scheme "https:" is unsupported; use ws:\/\/ or wss:\/\//);
  assert.match(err({ url: 'wss://user:secret@example.org/' }), /^INVALID_URL: websocket source "url" must not contain userinfo/);
  assert.doesNotMatch(err({ url: 'wss://user:secret@example.org/' }), /secret/);
  assert.match(err({ url: 'wss://example.org:0/' }), /^INVALID_URL: websocket source "url" port must be 1-65535/);
  assert.match(err({ url: 'ws://example.org/' }), /websocket source "allowInsecure" must be true for plain ws:\/\/ \(unencrypted\); set allowInsecure:true or use wss:\/\//);
});

test('endpoint preparation failures say how to proceed and never reveal resolved addresses', async () => {
  const err = async (source: any, resolve?: any) => { try { await prepareEndpoint(source, resolve); } catch (e) { return (e as Error).message; } return ''; };
  assert.match(await err({ url: 'wss://localhost/' }), /^NETWORK_BLOCKED: websocket source "url" host "localhost" is local; set allowPrivateNetwork:true to opt in/);
  assert.match(await err({ url: 'wss://x.example/' }, async () => { throw new Error('ENOTFOUND'); }), /^NETWORK_ERROR: DNS resolution failed for host "x\.example"; check the host name/);
  const blocked = await err({ url: 'wss://x.example/' }, async () => [{ address: '10.1.2.3', family: 4 }]);
  assert.match(blocked, /^NETWORK_BLOCKED: websocket source "url" host "x\.example" resolves to a private, loopback or otherwise non-public address \(or to an empty or invalid set\); set allowPrivateNetwork:true to opt in/);
  assert.doesNotMatch(blocked, /10\.1\.2\.3/);
});

test('websocket startup failure after acceptance records a bounded reason in the close evidence', async () => {
  const calls: any[] = [];
  const sink: any = { started() {}, data() {}, stderr() {}, fault: (r: string) => calls.push(['fault', r]), closed: (e: unknown, failed?: boolean) => calls.push(['closed', e, failed]) };
  await websocketLaunch({ kind: 'websocket', url: 'wss://127.0.0.1/' } as any)(sink, new AbortController().signal, Date.now() + 10_000);
  assert.deepEqual(calls[0], ['fault', 'source_error']);
  assert.equal(calls[1][1].startupFailed, true);
  assert.match(calls[1][1].startupError, /^NETWORK_BLOCKED: websocket source "url" host "127\.0\.0\.1" resolves to a private, loopback or otherwise non-public address \(or to an empty or invalid set\); set allowPrivateNetwork:true/);
  const timeout: any[] = [];
  await websocketLaunch({ kind: 'websocket', url: 'wss://monitor-timeout.invalid/' } as any)({ ...sink, fault() {}, closed: (e: unknown) => timeout.push(e) }, new AbortController().signal, Date.now());
  assert.match(String(timeout[0].startupError), /^NETWORK_TIMEOUT: /);
});

test('file path errors name the parameter, echo the path and say what to change', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-msg-')));
  try {
    mkdirSync(join(root, 'dir')); writeFileSync(join(root, 'ok.txt'), 'x');
    assert.throws(() => resolveFilePath(root, '.'), /file source "path" "\." is the workspace root itself; name a file inside it/);
    assert.throws(() => resolveFilePath(root, '../out.txt'), /file source "path" "\.\.\/out\.txt" resolves outside the canonical workspace; symlinks are followed\. Use a path under the project directory/);
    assert.throws(() => resolveFilePath(root, 'dir'), /file source "path" "dir" is not a regular file; directories and special files are not supported, name a file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime capacity and ownership errors give the next step', () => {
  const clock: Clock = { now: () => 0, set: () => 1, clear: () => {} };
  const owner = { sessionId: 'S', cwd: '/w' };
  const runtime = new MonitorRuntime(() => {}, clock);
  assert.throws(() => runtime.status('X'), /Monitor owner is disposed\/replaced: the session was replaced or reloaded; call monitor_start again from the current session/);
  runtime.bind(owner, () => owner);
  assert.throws(() => runtime.status('MISSING'), /Unknown Monitor "MISSING" in this owner\/cwd\/generation; ids do not survive reload or a session change, call monitor_status without monitorId to list current monitors/);
  const launch = async () => { await new Promise(() => {}); };
  for (let i = 0; i < 4; i++) runtime.start(validateStart({ source: { kind: 'command', tool: 'bash', command: `c${i}` } }), launch as never);
  assert.throws(() => runtime.start(validateStart({ source: { kind: 'command', tool: 'bash', command: 'c5' } }), launch as never), /Monitor active capacity is 4: .*monitor_stop.*monitor_status/);
});

test('agent-facing messages name tool args only, never settings, flags or environment variables', async () => {
  const forbidden = /--tools|allowlist|exclusion|manual disable|settings|pi-monitor|pi-fork|pi-subagents|\bPI_[A-Z]|\.pi\/agent|config/i;
  const tools = new Map<string, any>();
  const pi: any = { getActiveTools: () => [], registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, on() {} };
  monitorExtension(pi);
  const ctx: any = { cwd: tmpdir(), sessionManager: { getSessionId: () => 'S' } };
  const result = await tools.get('monitor_status').execute('id', {}, undefined, undefined, ctx);
  const text = JSON.stringify(result);
  assert.match(text, /monitor_status is registered but not enabled for this session; ask the user to enable it/);
  assert.doesNotMatch(text, forbidden);
  for (const tool of tools.values()) assert.doesNotMatch(`${tool.description} ${JSON.stringify(tool.parameters)}`, forbidden, tool.name);
  const messages: string[] = [];
  for (const source of [{ url: 'ws://example.org/' }, { url: 'wss://localhost/' }, { url: 'wss://x.example/' }]) {
    try { await prepareEndpoint(source as any, async () => [{ address: '10.1.2.3', family: 4 }]); } catch (e) { messages.push((e as Error).message); }
  }
  assert.equal(messages.length, 3);
  for (const m of messages) assert.doesNotMatch(m, forbidden);
});
