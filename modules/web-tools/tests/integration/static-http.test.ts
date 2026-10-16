import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import https from 'node:https';
import { cert, key } from '../fixtures/tls-material.js';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { fetchStatic, pinnedOptions } from '../../src/fetch/http.js';
import { MAX_HTML_BYTES } from '../../src/fetch/extract.js';
import { NetworkPolicy } from '../../src/fetch/network.js';

const signal = () => new AbortController().signal;
test('real TLS rejects untrusted certificates and pinned sockets preserve hostname verification and SNI', { timeout: 15_000 }, async t => {
  let requests = 0;
  let servername: string | undefined;
  const server = https.createServer({ cert, key }, (_req, res) => { requests++; res.end('trusted fixture'); });
  server.on('secureConnection', socket => { servername = (socket as typeof socket & { servername?: string }).servername; });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as AddressInfo).port;
  const policy = new NetworkPolicy(true, async () => [{ address: '127.0.0.1' }]);
  await assert.rejects(fetchStatic(`https://monitor.test:${port}/`, policy, signal()), /NETWORK_ERROR:.*TLS/);
  assert.equal(requests, 0, 'untrusted TLS must reject before sending HTTP');
  // Test-only CA on the actual pinned options proves validation uses the original hostname, not its IP.
  const trustedRequest = (hostname: string) => new Promise<void>((resolve, reject) => {
    const url = new URL(`https://${hostname}:${port}/`);
    const req = https.request(url, { ...pinnedOptions(url, '127.0.0.1', signal()), ca: cert }, response => {
      response.resume(); response.on('end', resolve); response.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
  await trustedRequest('monitor.test');
  assert.equal(servername, 'monitor.test');
  assert.equal(requests, 1);
  await assert.rejects(trustedRequest('wrong.test'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal(requests, 1);
});
test('static HTTP real sockets: pinning, redirects, streaming limits and cleanup', { timeout: 45_000 }, async t => {
  const hits: string[] = [];
  let held!: ServerResponse;
  let holdReached!: () => void;
  const reached = new Promise<void>(resolve => { holdReached = resolve; });
  const server = createServer((req, res) => {
    hits.push(req.url!);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    if (req.url === '/hold') { held = res; res.writeHead(200, { 'content-type': 'text/html' }); res.write('<main>'); holdReached(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/article', 'set-cookie': 'secret=x' }); res.end(); return; }
    if (req.url === '/blocked') { res.writeHead(302, { location: 'http://127.0.0.1/never' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (req.url === '/no-type') { res.end('<main>untyped</main>'); return; }
    if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('pdf'); return; }
    if (req.url === '/attachment') { res.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'attachment' }); res.end('download'); return; }
    if (req.url === '/error') { res.writeHead(503); res.end('secret'); return; }
    if (req.url === '/large') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(Buffer.alloc(MAX_HTML_BYTES + 1, 120)); return; }
    if (req.url === '/bomb') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(MAX_HTML_BYTES + 1, 120))); return; }
    if (req.url === '/broken') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end('not gzip'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' });
    res.end(brotliCompressSync(Buffer.from(`<main>${req.headers.host}</main>`)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as AddressInfo).port;
  const base = `http://does-not-resolve.invalid:${port}`;
  let lookups = 0;
  const policy = new NetworkPolicy(true, async () => { lookups++; return [{ address: '127.0.0.1' }]; });
  const result = await fetchStatic(`${base}/redirect`, policy, signal());
  assert.equal(result.finalUrl, `${base}/article`);
  assert.match(result.html, new RegExp(`does-not-resolve.invalid:${port}`));
  assert.equal(lookups, 2, 'each redirect resolves once, actual sockets must use the pinned lookup');
  assert.deepEqual(hits, ['/redirect', '/article']);
  for (const [path, error] of [['/no-type', /UNSUPPORTED_CONTENT/], ['/pdf', /UNSUPPORTED_CONTENT/], ['/attachment', /UNSUPPORTED_CONTENT/], ['/error', /HTTP_ERROR/], ['/large', /TOO_LARGE/], ['/bomb', /TOO_LARGE/], ['/broken', /NETWORK_ERROR/], ['/loop', /Too many redirects/]] as const) {
    await assert.rejects(fetchStatic(base + path, policy, signal()), error);
  }
  // Permit only the fixture's first connection; every redirect is then checked by production policy.
  const resolveTarget = policy.resolveTarget.bind(policy);
  t.mock.method(policy, 'resolveTarget', (value: string) => value.endsWith('/blocked') ? resolveTarget(value) : new NetworkPolicy().resolveTarget(value));
  await assert.rejects(fetchStatic(`${base}/blocked`, policy, signal()), /NETWORK_BLOCKED/);
  assert.equal(hits.includes('/never'), false);
  t.mock.restoreAll();
  const controller = new AbortController();
  const pending = fetchStatic(`${base}/hold`, policy, controller.signal);
  const rejected = assert.rejects(pending, /CANCELLED: test/);
  await reached;
  const closed = once(held, 'close');
  controller.abort(new Error('CANCELLED: test'));
  await Promise.all([rejected, closed]);
  assert.equal((await fetchStatic(`${base}/article`, policy, signal())).status, 200);
});

test('real missing Chromium executable in isolated process and empty browser cache', { timeout: 60_000 }, async () => {
  const cache = await mkdtemp(join(tmpdir(), 'pi-web-empty-browser-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/missing-browser.ts', import.meta.url))], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /Missing-browser checks passed/);
  } finally { await rm(cache, { recursive: true, force: true }); }
});
