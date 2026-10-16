import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FetchService } from '../../src/fetch/service.js';

const hits: string[] = [];
let reached!: () => void;
const holding = new Promise<void>(resolve => { reached = resolve; });
let connectionClosed!: () => void;
const closedConnection = new Promise<void>(resolve => { connectionClosed = resolve; });
const server = createServer((req, res) => {
  hits.push(req.url!);
  if (req.url === '/hold') { res.once('close', connectionClosed); reached(); return; }
  if (req.url === '/error') { res.writeHead(503); res.end('error'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<main>Static article</main><script>document.querySelector("main").textContent="DYNAMIC";fetch("/script-request")</script><img src="/image">');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const service = new FetchService({ channel: 'chromium', timeoutMs: 30_000, maxConcurrency: 2, idleTimeoutMs: 0 }, { allowPrivateNetwork: true });
try {
  const results = await Promise.all([service.fetch({ url, format: 'text' }), service.fetch({ url, format: 'text' })]);
  for (const result of results) {
    assert.equal(result.content, 'Static article');
    assert.match(result.warnings.join(' '), /Static HTTP mode.*JavaScript.*executable was not found/);
  }
  assert.deepEqual(hits, ['/', '/']);
  await assert.rejects(service.fetch({ url: url + '/selector', waitForSelector: 'main' }), /Static HTTP cannot honor waitForSelector/);
  assert.equal(hits.includes('/selector'), false);
  await assert.rejects(service.fetch({ url: url + '/error' }), /HTTP_ERROR.*503/);
  assert.equal(hits.filter(hit => hit === '/error').length, 1, 'HTTP errors are not retried');
  const active = service.fetch({ url: url + '/hold' });
  const rejected = assert.rejects(active, /CLOSED:/);
  await holding;
  const queued = service.fetch({ url: url + '/hold' });
  const queuedRejected = assert.rejects(queued, /CLOSED:/);
  await service.close();
  await Promise.all([rejected, queuedRejected, closedConnection]);
  assert.equal(service['operationCleanup'].size, 0);
  assert.equal(service['operations'].size, 0);
  await assert.rejects(service.fetch({ url }), /CLOSED:/);
  console.log('Missing-browser checks passed');
} finally {
  await service.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
