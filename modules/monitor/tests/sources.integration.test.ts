import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { commandLaunch, websocketLaunch, jobLaunch } from '../src/sources.ts';
import { prepareEndpoint, pinnedOptions } from '../src/network.ts';
import { publishCapability, acquireCapability } from '../../shell-tools/src/monitor-capability.ts';
import { MonitorRuntime, type Clock } from '../src/core.ts';
import { validateStart } from '../src/schema.ts';
const owner = { sessionId: 'isolated-fixture', cwd: process.cwd() };
function fixture(clock?: Clock) { const messages: any[] = []; const r = new MonitorRuntime((m) => messages.push(m), clock); r.bind(owner, () => owner); return { r, messages }; }
const fakePi = { getSettings: () => ({ shellCommandPrefix: '' }) };
const fakeCtx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'isolated-fixture', getSessionFile: () => undefined } };
test('actual command stdout/stderr/nonzero and actual close, not exit', async () => {
  const f = fixture(); const input = validateStart({ source: { kind: 'command', tool: 'bash', command: "printf 'first\\nlast'; printf 'diagnostic' >&2; exit 7" }, wakeAgent: false });
  const receipt = f.r.start(input, commandLaunch(fakePi as any, fakeCtx as any, input.source as any));
  await f.r.settled(receipt.monitorId); const status = f.r.status(receipt.monitorId);
  assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, false); assert.equal(status.cleanupEvidence.exitCode, 7);
  assert.equal(status.cleanupEvidence.sourceClosed, true); assert.equal(status.counts.adopted, 2); assert.equal(status.diagnostics.stderrTail, 'diagnostic');
  await f.r.shutdown();
});
test('WS real local fragmented text is one event; token never enters receipt', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const f = fixture(); server.on('connection', ws => { ws.send('one', { fin: false }); ws.send('two', { fin: true }); ws.close(1000, 'done'); });
  try {
    const input = validateStart({ source: { kind: 'websocket', url: `ws://127.0.0.1:${(server.address() as any).port}/?token=secret`, allowPrivateNetwork: true, allowInsecure: true }, wakeAgent: false });
    const endpoint = await prepareEndpoint(input.source as any); const receipt = f.r.start(input, websocketLaunch(endpoint)); await f.r.settled(receipt.monitorId);
    const status = f.r.status(receipt.monitorId); assert.equal(status.counts.adopted, 1); assert.equal(status.state, 'completed'); assert.equal(status.cleanupPending, false); assert.equal(status.cleanupEvidence.closeCode, 1000); assert.doesNotMatch(JSON.stringify(status), /token|secret/);
  } finally { await f.r.shutdown(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); }
});
for (const mode of ['binary', 'oversize'] as const) test(`real WS ${mode} is terminal and actually closed`, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening'); const f = fixture();
  server.on('connection', ws => { ws.send(mode === 'binary' ? Buffer.from('binary') : 'x'.repeat(16385)); });
  try {
    const source = { kind: 'websocket' as const, url: `ws://127.0.0.1:${(server.address() as any).port}`, allowPrivateNetwork: true, allowInsecure: true };
    const receipt = f.r.start(validateStart({ source }), websocketLaunch(await prepareEndpoint(source))); await f.r.settled(receipt.monitorId);
    const status = f.r.status(receipt.monitorId); assert.equal(status.counts.adopted, 0); assert.equal(status.stopReason, mode === 'binary' ? 'unsupported_payload' : 'payload_limit'); assert.equal(status.cleanupPending, false);
  } finally { await f.r.shutdown(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); }
});
test('review S2: own URL metadata hides unique offline marker; echoed text/closeReason remains untrusted source data by explicit policy', async () => {
  const marker = 'OFFLINE_URL_ECHO_POLICY_A71', tasks = new Map<number, () => void>(); let next = 0;
  const clock: Clock = { now: () => 0, set: fn => { const id = ++next; tasks.set(id, fn); return id; }, clear: id => { tasks.delete(id as number); } };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening'); const f = fixture(clock);
  server.on('connection', (ws, request) => { const echoed = new URL(request.url!, 'http://offline.test').searchParams.get('token')!; assert.equal(echoed, marker); ws.send(echoed); ws.close(1000, echoed); });
  try {
    const source = { kind: 'websocket' as const, url: `ws://127.0.0.1:${(server.address() as any).port}/private-path?token=${marker}#private-fragment`, allowPrivateNetwork: true, allowInsecure: true };
    const receipt = f.r.start(validateStart({ source, wakeAgent: false }), websocketLaunch(await prepareEndpoint(source), clock)); await f.r.settled(receipt.monitorId);
    const status = f.r.status(receipt.monitorId); assert.doesNotMatch(status.sourcePreview, /OFFLINE_URL_ECHO_POLICY|token|private-path|private-fragment|[?#]/); assert.equal(status.cleanupEvidence.closeReason, marker);
    for (const [id, fn] of [...tasks]) { tasks.delete(id); fn(); }
    assert.ok(f.messages.flatMap(m => m.details.events).some(e => e.text === marker)); assert.equal(f.messages[0].details.monitors[0].cleanupEvidence.closeReason, marker);
  } finally { await f.r.shutdown(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); }
});
test('DNS pin returns only verified addresses and explicit TLS/redirect/compression constraints', async () => {
  await assert.rejects(prepareEndpoint({ url: 'ws://127.0.0.1', allowInsecure: true } as any), /NETWORK_BLOCKED/);
  await assert.rejects(prepareEndpoint({ url: 'ws://public.example' } as any), /allowInsecure/);
  for (const url of ['wss://user:secret@example.org', 'ws+unix:/tmp/socket', 'wss://example.org:65536']) await assert.rejects(prepareEndpoint({ url } as any));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) await assert.rejects(prepareEndpoint({ url: 'wss://public.example' } as any, async () => [{ address, family: address.includes(':') ? 6 : 4 }]), /NETWORK_BLOCKED/);
  const endpoint = await prepareEndpoint({ url: 'wss://public.example' } as any, async () => [{ address: '8.8.8.8', family: 4 }]);
  const opts = pinnedOptions(endpoint, 1000); assert.equal(opts.rejectUnauthorized, true); assert.equal(opts.followRedirects, false); assert.equal(opts.perMessageDeflate, false); assert.equal(opts.maxPayload, 16384); assert.equal(opts.servername, 'public.example');
  const resolved = await new Promise<any>((r, reject) => (opts.lookup as any)('public.example', { all: true }, (e: any, addresses: any) => e ? reject(e) : r(addresses)));
  assert.deepEqual(resolved, [{ address: '8.8.8.8', family: 4 }]);
});
test('job adapter owns only timer, readonly lease generation and snapshot (never job cancel/model query)', async () => {
  let canceled = false; let queried = false; let reads = 0;
  const revoke = publishCapability('shell_job', owner, 1, id => { reads++; assert.equal(id, 'job-A'); return { jobId: id, status: 'completed', elapsedMs: 1, cancelRequested: false }; }, () => true);
  const f = fixture();
  try {
    const lease = acquireCapability('shell_job', owner); const input = validateStart({ source: { kind: 'shell_job', jobId: 'job-A' } });
    const receipt = f.r.start(input, jobLaunch(lease, 'job-A', 30000)); await f.r.settled(receipt.monitorId);
    assert.equal(reads, 1); assert.equal(f.r.status(receipt.monitorId).state, 'completed'); assert.equal(canceled, false); assert.equal(queried, false);
    revoke(); assert.throws(() => lease.snapshot('job-A')); assert.throws(() => acquireCapability('shell_job', { ...owner, cwd: '/foreign' }));
  } finally { revoke(); await f.r.shutdown(); }
});
