import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import test from 'node:test';
import { LIMITS, generateCode } from '../src/protocol.js';
import { RawPeer, fingerprintOf, otherTlsFixture, startClient, startHub, tlsFixture } from './helpers.js';

const send = (to: string, body: string, id = `id-${Math.random().toString(36).slice(2)}`) => ({ t: 'send' as const, id, to, kind: 'message' as const, body });

test('server, two clients and the server itself exchange messages through one roster', async t => {
  const code = generateCode();
  const { hub, port, inbox } = await startHub(t, { code });
  const alpha = startClient(t, { port, code, name: 'alpha' });
  const beta = startClient(t, { port, code, name: 'beta' });
  await Promise.all([alpha.connected(), beta.connected()]);
  await alpha.changes.until(() => alpha.peers().length === 3, 'alpha sees three peers');
  assert.deepEqual(alpha.peers(), ['srv', 'alpha', 'beta']);
  assert.deepEqual(hub.roster().map(p => p.name), ['srv', 'alpha', 'beta']);
  assert.ok(hub.roster().every(entry => !('instanceId' in entry)), 'instance ids are not shared');

  assert.deepEqual(await alpha.client.send(send('beta', 'hello beta')), { status: 'delivered', count: 1 });
  await beta.changes.until(() => beta.inbox.length === 1, 'beta received');
  assert.equal(beta.inbox[0]!.from, 'alpha');
  assert.equal(beta.inbox[0]!.body, 'hello beta');

  assert.equal((await alpha.client.send(send('srv', 'to the server'))).status, 'delivered');
  assert.equal(inbox[0]!.from, 'alpha');
  assert.deepEqual(hub.send(send('alpha', 'from the server', 'H1')), { t: 'ack', id: 'H1', status: 'delivered', count: 1 });
  await alpha.changes.until(() => alpha.inbox.length === 1, 'alpha received from server');

  assert.deepEqual(await alpha.client.send(send('*', 'everyone')), { status: 'delivered', count: 2 });
  assert.deepEqual(await alpha.client.send(send('ghost', 'nobody')), { status: 'offline' });
  assert.deepEqual(await alpha.client.send(send('alpha', 'myself')), { status: 'rejected' });
  assert.equal((await alpha.client.send(send('beta', 'a\u0000b\u001b'))).status, 'delivered');
  await beta.changes.until(() => beta.inbox.length === 3, 'beta received sanitized text');
  assert.equal(beta.inbox.at(-2)!.body, 'everyone');
  assert.equal(beta.inbox.at(-1)!.body, 'ab');
});

test('sync messages carry git details and replyTo through the hub', async t => {
  const code = generateCode();
  const { port } = await startHub(t, { code });
  const a = startClient(t, { port, code, name: 'a' }), b = startClient(t, { port, code, name: 'b' });
  await Promise.all([a.connected(), b.connected()]);
  await a.client.send({ t: 'send', id: 'S1', to: 'b', kind: 'sync', body: 'pushed', git: { branch: 'main', commit: 'abc123' }, replyTo: 'R0' });
  await b.changes.until(() => b.inbox.length === 1, 'sync received');
  assert.deepEqual(b.inbox[0], { id: 'S1', from: 'a', kind: 'sync', body: 'pushed', git: { branch: 'main', commit: 'abc123' }, replyTo: 'R0' });
});

test('wss works with a self-signed certificate because the proof binds the certificate fingerprint', async t => {
  const code = generateCode();
  const { port } = await startHub(t, { code, tls: true });
  const a = startClient(t, { port, code, name: 'a', tls: true }), b = startClient(t, { port, code, name: 'b', tls: true });
  await Promise.all([a.connected(), b.connected()]);
  assert.equal((await a.client.send(send('b', 'over wss'))).status, 'delivered');
  await b.changes.until(() => b.inbox.length === 1, 'received over wss');

  // A proof computed for a different certificate (what an intercepting server would cause) or for plain ws is refused.
  const interception = RawPeer.open(t, port, true);
  assert.deepEqual(await interception.hello({ name: 'mitm', code, fingerprint: fingerprintOf(otherTlsFixture.cert) }), { t: 'error', code: 'auth_failed' });
  const downgrade = RawPeer.open(t, port, true);
  assert.deepEqual(await downgrade.hello({ name: 'down', code, fingerprint: '' }), { t: 'error', code: 'auth_failed' });
  const genuine = RawPeer.open(t, port, true);
  assert.equal((await genuine.hello({ name: 'genuine', code, fingerprint: fingerprintOf(tlsFixture.cert) })).t, 'welcome');
});

test('a wrong pairing code ends in auth_failed without retrying; the wrong peer never appears in the roster', async t => {
  const code = generateCode();
  const { hub, port } = await startHub(t, { code });
  let backoffCalls = 0;
  const intruder = startClient(t, { port, code: generateCode(), name: 'intruder', backoff: () => { backoffCalls += 1; return 1; } });
  await intruder.changes.until(() => intruder.client.state === 'auth_failed', 'auth_failed');
  assert.deepEqual(hub.roster().map(p => p.name), ['srv']);
  // The refused socket closes right after the error frame; give a retry (backoff 1 ms) ample time to show up.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(backoffCalls, 0);
  assert.equal(intruder.client.state, 'auth_failed');
});

test('five failed handshakes block that address, even for the right code', async t => {
  const code = generateCode();
  const { hub, port } = await startHub(t, { code });
  for (let i = 0; i < 5; i += 1) {
    const raw = RawPeer.open(t, port);
    assert.deepEqual(await raw.hello({ name: 'bad', code, proof: 'f'.repeat(64) }), { t: 'error', code: 'auth_failed' });
  }
  const blocked = RawPeer.open(t, port);
  assert.deepEqual(await blocked.frame('error'), { t: 'error', code: 'blocked' });
  assert.deepEqual(hub.roster().map(p => p.name), ['srv']);
});

test('garbage, binary frames and out-of-order frames are refused before any peer joins', async t => {
  const code = generateCode();
  const { hub, port } = await startHub(t, { code });
  const junk = RawPeer.open(t, port);
  await junk.frame('challenge');
  junk.send('not json');
  assert.deepEqual(await junk.frame('error'), { t: 'error', code: 'protocol' });
  const early = RawPeer.open(t, port);
  await early.frame('challenge');
  early.send(send('srv', 'before hello'));
  assert.deepEqual(await early.frame('error'), { t: 'error', code: 'protocol' });
  const binary = RawPeer.open(t, port);
  await binary.frame('challenge');
  binary.socket.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(await binary.frame('error'), { t: 'error', code: 'protocol' });
  assert.deepEqual(hub.roster().map(p => p.name), ['srv']);
});

test('after joining, a malformed frame closes only that peer', async t => {
  const code = generateCode();
  const { hub, port } = await startHub(t, { code });
  const keeper = startClient(t, { port, code, name: 'keeper' });
  await keeper.connected();
  const rude = RawPeer.open(t, port);
  assert.equal((await rude.hello({ name: 'rude', code })).t, 'welcome');
  rude.send({ t: 'send', id: 'X', to: 'keeper', kind: 'shout', body: 'x' });
  await rude.until(() => rude.closed, 'rude closed');
  await keeper.changes.until(() => keeper.peers().join() === 'srv,keeper', 'roster without rude');
  assert.deepEqual(hub.roster().map(p => p.name), ['srv', 'keeper']);
});

test('a taken name gets a suffix; the same instance reconnecting takes its name back from a stale socket', async t => {
  const code = generateCode();
  const { hub, port } = await startHub(t, { code });
  const first = RawPeer.open(t, port);
  assert.equal((await first.hello({ name: 'dup', instanceId: 'X', code })).name, 'dup');
  const other = RawPeer.open(t, port);
  assert.equal((await other.hello({ name: 'dup', instanceId: 'Y', code })).name, 'dup-2');
  const sameInstance = RawPeer.open(t, port);
  assert.equal((await sameInstance.hello({ name: 'dup', instanceId: 'X', code })).name, 'dup');
  await first.until(() => first.closed, 'stale socket closed');
  assert.deepEqual(hub.roster().map(p => p.name), ['srv', 'dup-2', 'dup']);
  // The server's own name is never given away.
  const claimsServer = RawPeer.open(t, port);
  assert.equal((await claimsServer.hello({ name: 'srv', instanceId: 'Z', code })).name, 'srv-2');
});

test('oversized bodies are refused, an oversized frame drops the connection, and bursts are rate limited', async t => {
  const code = generateCode();
  const { hub, port, changes } = await startHub(t, { code });
  const a = startClient(t, { port, code, name: 'a' }), b = startClient(t, { port, code, name: 'b' });
  await Promise.all([a.connected(), b.connected()]);
  assert.deepEqual(await a.client.send(send('b', 'x'.repeat(LIMITS.bodyChars + 1))), { status: 'too_large' });
  assert.deepEqual(await a.client.send(send('b', '   ')), { status: 'rejected' });

  const flood = RawPeer.open(t, port);
  assert.equal((await flood.hello({ name: 'flood', code })).t, 'welcome');
  flood.send(JSON.stringify({ ...send('b', 'y'.repeat(LIMITS.frameBytes)) }));
  await flood.until(() => flood.closed, 'oversized frame closes the peer');
  await changes.until(() => hub.roster().length === 3, 'hub drops the flooding peer');
  assert.deepEqual(hub.roster().map(p => p.name), ['srv', 'a', 'b']);

  const statuses: string[] = [];
  for (let i = 0; i < LIMITS.sendBurst + 3; i += 1) statuses.push((await a.client.send(send('b', `m${i}`))).status);
  assert.equal(statuses.filter(s => s === 'rate_limited').length >= 3, true, statuses.join());
  assert.equal(statuses.filter(s => s === 'delivered').length <= LIMITS.sendBurst, true);
});

test('unauthenticated connections are capped', async t => {
  const code = generateCode();
  const { port } = await startHub(t, { code });
  for (let i = 0; i < LIMITS.maxPending; i += 1) await RawPeer.open(t, port).frame('challenge');
  const refused = RawPeer.open(t, port);
  assert.deepEqual(await refused.frame('error'), { t: 'error', code: 'full' });
});

test('clients reconnect on their own when the hub restarts, and keep working afterwards', async t => {
  const code = generateCode();
  const first = await startHub(t, { code });
  const a = startClient(t, { port: first.port, code, name: 'a' });
  await a.connected();
  await first.hub.stop();
  await a.changes.until(() => a.client.state === 'reconnecting', 'a notices the hub is gone');
  assert.deepEqual(await a.client.send(send('srv', 'nobody home')), { status: 'offline' });
  const second = await startHub(t, { code, port: first.port });
  await a.changes.until(() => a.client.state === 'connected', 'a reconnects');
  assert.equal((await a.client.send(send('srv', 'back'))).status, 'delivered');
  assert.equal(second.inbox[0]!.body, 'back');
});

test('stopping the hub closes every peer and releases the port; stopping a client stops reconnecting', async t => {
  const code = generateCode();
  const { hub, port } = await startHub(t, { code });
  const a = startClient(t, { port, code, name: 'a' });
  await a.connected();
  const pendingAck = a.client.send(send('srv', 'one'));
  await pendingAck;
  await hub.stop();
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection({ port, host: '127.0.0.1' });
    probe.once('connect', () => { probe.destroy(); reject(new Error('port still accepting connections')); });
    probe.once('error', () => resolve());
  });
  a.client.stop();
  assert.equal(a.client.state, 'stopped');
  assert.deepEqual(await a.client.send(send('srv', 'after stop')), { status: 'offline' });
});
