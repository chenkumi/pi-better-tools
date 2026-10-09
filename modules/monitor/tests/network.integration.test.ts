import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { prepareEndpoint, pinnedOptions } from '../src/network.ts';
import { cert, key } from './fixtures/tls-material.ts';
test('installed ws8.22 actual connect pins DNS and preserves verified TLS/SNI; untrusted CA and wrong name fail', async () => {
  const server = createServer({ cert, key }); const wss = new WebSocketServer({ server });
  let sni: string | false | null | undefined; server.on('secureConnection', socket => { sni = socket.servername; });
  wss.on('connection', ws => ws.close(1000, 'done'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let resolutions = 0;
  const endpoint = await prepareEndpoint({ url: `wss://monitor.test:${(server.address() as any).port}`, allowPrivateNetwork: true }, async host => { resolutions++; assert.equal(host, 'monitor.test'); return [{ address: '127.0.0.1', family: 4 }]; });
  try {
    const success = new WebSocket(endpoint.url, { ...pinnedOptions(endpoint, 1000), ca: cert });
    const closed = once(success, 'close'); await once(success, 'open'); await closed;
    assert.equal(sni, 'monitor.test'); assert.equal(resolutions, 1);
    for (const extra of [{}, { ca: cert, servername: 'wrong.test' }]) {
      const rejected = new WebSocket(endpoint.url, { ...pinnedOptions(endpoint, 1000), ...extra });
      const close = new Promise<void>(r => rejected.once('close', () => r()));
      const [error] = await once(rejected, 'error'); await close;
      assert.match(error.code, /DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID/);
    }
  } finally { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); }
});
test('installed ws transport does not follow redirect to another endpoint', async () => {
  let targetConnections = 0;
  const target = httpServer((_req, res) => { targetConnections++; res.end(); }); target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const redirect = httpServer((_req, res) => { res.writeHead(302, { Location: `ws://127.0.0.1:${(target.address() as any).port}` }); res.end(); }); redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  try {
    const endpoint = await prepareEndpoint({ url: `ws://127.0.0.1:${(redirect.address() as any).port}`, allowPrivateNetwork: true, allowInsecure: true });
    const client = new WebSocket(endpoint.url, pinnedOptions(endpoint, 1000)); const close = new Promise<void>(r => client.once('close', () => r()));
    const [error] = await once(client, 'error'); await close; assert.match(error.message, /302/); assert.equal(targetConnections, 0);
  } finally { await new Promise<void>(r => redirect.close(() => r())); await new Promise<void>(r => target.close(() => r())); }
});
