import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { RemoteClient, type ClientState } from '../src/client.ts';

/** Polls until the condition holds; fails with the label instead of passing on a fixed delay. */
async function until(label: string, condition: () => boolean, limitMs = 5000) {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** A server that completes the WebSocket upgrade and then says nothing (optionally a single ping). */
async function silentServer(pingOnce: boolean) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.on('listening', resolve));
  const seen = { connections: 0, closed: 0 };
  server.on('connection', socket => { seen.connections++; socket.on('close', () => seen.closed++); if (pingOnce) socket.ping(); });
  return { seen, port: (server.address() as { port: number }).port, close: () => { for (const socket of server.clients) socket.terminate(); server.close(); } };
}

function client(port: number, states: ClientState[]) {
  return new RemoteClient({
    host: '127.0.0.1', port, tls: false, code: 'x', silenceMs: 300, backoff: () => 50,
    self: { name: 'a', platform: 'p', arch: 'a', hostname: 'h', project: 'p', instanceId: 'i' },
    onMessage() {}, onRoster() {}, onState: state => states.push(state),
  });
}

test('a hub that upgrades and never sends a frame is dropped after the silence limit, and the client reconnects', async t => {
  const server = await silentServer(false);
  const states: ClientState[] = [];
  const remote = client(server.port, states);
  t.after(() => { remote.stop(); server.close(); });
  remote.start();
  await until('a second connection after the silent one was closed', () => server.seen.closed >= 1 && server.seen.connections >= 2);
  assert.ok(states.includes('reconnecting'));
});

test('control: a single ping is enough to arm the same limit (the limit was never the problem, its start was)', async t => {
  const server = await silentServer(true);
  const states: ClientState[] = [];
  const remote = client(server.port, states);
  t.after(() => { remote.stop(); server.close(); });
  remote.start();
  await until('the pinged link to be closed by the client', () => server.seen.closed >= 1);
  assert.ok(states.includes('reconnecting'));
});
