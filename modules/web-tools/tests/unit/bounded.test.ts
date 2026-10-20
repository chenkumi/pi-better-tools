import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createGzip, gzipSync } from 'node:zlib';
import { parseSetCookie, requestBounded, ResponseBudget } from '../../src/fetch/bounded.js';

const MiB = 1024 * 1024;

async function server(handler: (path: string, response: ServerResponse) => void) {
  const instance = createServer((request, response) => handler(new URL(request.url ?? '/', 'http://x').pathname, response));
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
    async close() { instance.closeAllConnections(); await new Promise<void>((resolve) => instance.close(() => resolve())); } };
}
const get = (url: string, signal = new AbortController().signal) => requestBounded({ url, method: 'GET', headers: {}, signal });

test('gzip bomb is rejected while decoding, not after buffering, and the server connection is closed', async (t) => {
  let closed = false;
  let written = 0;
  const site = await server((path, response) => {
    if (path !== '/bomb') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' });
    const gzip = createGzip(); gzip.pipe(response);
    response.on('close', () => { closed = true; gzip.destroy(); });
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => {
      while (!closed && written < 2048 * MiB) { written += chunk.length; if (!gzip.write(chunk)) { gzip.once('drain', pump); return; } }
    };
    pump();
  });
  t.after(site.close);
  const response = await get(`${site.url}/bomb`);
  const before = process.memoryUsage().rss;
  await assert.rejects(response.readBody(5 * MiB), /^Error: TOO_LARGE:/);
  assert.ok(process.memoryUsage().rss - before < 100 * MiB, 'decoding must stop near the limit');
  await response.dispose();
  assert.equal(closed, true);
});

test('identity wire limit, declared length, budget, unsupported encoding and abort', async (t) => {
  const site = await server((path, response) => {
    if (path === '/big') { response.writeHead(200); response.write(Buffer.alloc(3 * MiB)); response.end(Buffer.alloc(3 * MiB)); return; }
    if (path === '/declared') { response.writeHead(200, { 'content-length': String(6 * MiB) }); response.end(Buffer.alloc(6 * MiB)); return; }
    if (path === '/zstd') { response.writeHead(200, { 'content-encoding': 'zstd' }); response.end('x'); return; }
    if (path === '/ok') { response.writeHead(200, { 'content-encoding': 'gzip', 'set-cookie': ['a=1', 'b=2'] }); response.end(gzipSync('hello')); return; }
    if (path === '/hang') { response.writeHead(200); response.write('x'); return; }
    response.writeHead(404); response.end();
  });
  t.after(site.close);
  let response = await get(`${site.url}/big`);
  await assert.rejects(response.readBody(5 * MiB), /^Error: TOO_LARGE:/); await response.dispose();
  response = await get(`${site.url}/declared`);
  await assert.rejects(response.readBody(5 * MiB), /^Error: TOO_LARGE:/); await response.dispose();
  response = await get(`${site.url}/zstd`);
  await assert.rejects(response.readBody(5 * MiB), /^Error: UNSUPPORTED_CONTENT:/); await response.dispose();
  response = await get(`${site.url}/ok`);
  assert.deepEqual(response.setCookies, ['a=1', 'b=2']);
  assert.equal((await response.readBody(MiB)).toString(), 'hello'); await response.dispose();
  // cumulative budget across responses, and request-count budget
  const budget = new ResponseBudget(2, 8 * MiB);
  for (const expected of [/./, /^Error: TOO_LARGE:/]) {
    response = await get(`${site.url}/big`);
    await (expected.source === '.' ? response.readBody(10 * MiB, budget) : assert.rejects(response.readBody(10 * MiB, budget), expected));
    await response.dispose();
  }
  budget.admit(); budget.admit();
  assert.throws(() => budget.admit(), /TOO_LARGE:.*requests/);
  // cancellation while the body is stalled
  const controller = new AbortController();
  response = await get(`${site.url}/hang`, controller.signal);
  const pending = response.readBody(MiB);
  controller.abort(new Error('CANCELLED: test'));
  await assert.rejects(pending, /CANCELLED: test/);
  await response.dispose();
});

test('Set-Cookie parsing is host-scoped and best effort', () => {
  const cookie = parseSetCookie('sid=abc; Path=/x; Domain=.example.org; Secure; HttpOnly; SameSite=None; Max-Age=60', 'https://a.example.org/dir/page');
  assert.equal(cookie?.name, 'sid'); assert.equal(cookie?.domain, '.example.org'); assert.equal(cookie?.path, '/x');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'None' && cookie.expires! > Date.now() / 1000);
  assert.equal(parseSetCookie('sid=abc; Domain=evil.com', 'https://a.example.org/'), undefined);
  assert.equal(parseSetCookie('novalue', 'https://a.example.org/'), undefined);
  assert.equal(parseSetCookie('h=1', 'https://a.example.org/dir/page')?.domain, 'a.example.org');
  assert.equal(parseSetCookie('h=1', 'https://a.example.org/dir/page')?.path, '/dir');
});
