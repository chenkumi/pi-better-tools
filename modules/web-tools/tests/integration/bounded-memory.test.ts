import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createGzip } from 'node:zlib';
import { extractHtmlIsolated } from '../../src/fetch/extract.js';
import { FetchService, type FetchOptions } from '../../src/fetch/service.js';

const MiB = 1024 * 1024;
const BOMB_BYTES = 160 * MiB;
const options: FetchOptions = { channel: 'chromium', timeoutMs: 30_000, maxConcurrency: 1, idleTimeoutMs: 60_000 };

/** Streams `bytes` zero bytes through gzip (no Content-Length), so the wire size is tiny. */
function bomb(response: import('node:http').ServerResponse, contentType: string, bytes: number, ended: { value: boolean }): void {
  response.writeHead(200, { 'content-type': contentType, 'content-encoding': 'gzip' });
  const gzip = createGzip();
  gzip.pipe(response);
  response.on('close', () => { ended.value = true; gzip.destroy(); });
  const chunk = Buffer.alloc(64 * 1024);
  let remaining = bytes;
  const pump = () => {
    while (remaining > 0 && !ended.value) {
      remaining -= chunk.length;
      if (!gzip.write(chunk)) { gzip.once('drain', pump); return; }
    }
    if (!ended.value) gzip.end();
  };
  pump();
}

async function fixture() {
  const state = { mainEnded: { value: false }, scriptEnded: { value: false }, cookieSeen: undefined as string | undefined };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    if (path === '/bomb-main') return bomb(response, 'text/html; charset=utf-8', BOMB_BYTES, state.mainEnded);
    if (path === '/bomb-sub') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<main>Readable despite a hostile script.</main><script src="/bomb.js"></script>'); }
    if (path === '/cookie-page') { response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['sid=abc; Path=/', 'other=1; Path=/'] }); return response.end('<main>Cookie page</main><script src="/cookie.js"></script>'); }
    if (path === '/cookie.js') { state.cookieSeen = request.headers.cookie; response.writeHead(200, { 'content-type': 'application/javascript' }); return response.end('1'); }
    if (path === '/bomb.js') return bomb(response, 'application/javascript', BOMB_BYTES, state.scriptEnded);
    response.writeHead(404, { 'content-type': 'text/html' }); response.end('<main>Not found</main>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** Peak RSS growth of this (host) process while `run` executes. */
async function peakRssGrowth<T>(run: () => Promise<T>): Promise<{ result?: T; error?: unknown; growth: number }> {
  if (global.gc) global.gc();
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  try { return { result: await run(), growth: Math.max(peak, process.memoryUsage().rss) - base }; }
  catch (error) { return { error, growth: Math.max(peak, process.memoryUsage().rss) - base }; }
  finally { clearInterval(timer); }
}

test('browser path bounds wire and decoded bytes while reading (gzip bomb)', { timeout: 120_000 }, async (t) => {
  const site = await fixture();
  const service = new FetchService(options, { allowPrivateNetwork: true });
  t.after(async () => { await service.close(); await site.close(); });
  await extractHtmlIsolated('<main>warm</main>', 'https://example.org/', 'text', 'main', new AbortController().signal);
  // Warm the browser so Chromium/Playwright startup is not part of the measured growth.
  await service.fetch({ url: `${site.url}/missing-warmup` }).catch(() => {});

  await t.test('main document: stops reading at the 5 MiB limit with TOO_LARGE', async () => {
    const outcome = await peakRssGrowth(() => service.fetch({ url: `${site.url}/bomb-main` }));
    assert.match(String((outcome.error as Error | undefined)?.message), /^TOO_LARGE:/);
    assert.ok(outcome.growth < 64 * MiB, `host RSS grew by ${(outcome.growth / MiB).toFixed(0)} MiB (limit 64 MiB)`);
    assert.equal(site.state.mainEnded.value, true, 'the server connection must be closed after the limit');
  });

  await t.test('subresource: oversized script is blocked, page still renders, memory stays bounded', async () => {
    const outcome = await peakRssGrowth(() => service.fetch({ url: `${site.url}/bomb-sub`, extraction: 'main' }));
    assert.equal(outcome.error, undefined);
    assert.match(outcome.result!.content, /Readable despite/);
    assert.ok(outcome.result!.warnings.some((warning) => /subresources/.test(warning)));
    assert.ok(outcome.growth < 64 * MiB, `host RSS grew by ${(outcome.growth / MiB).toFixed(0)} MiB (limit 64 MiB)`);
    assert.equal(site.state.scriptEnded.value, true);
  });
});

test('bounded transport keeps document Set-Cookie flowing to later subresource requests', { timeout: 60_000 }, async (t) => {
  const site = await fixture();
  const service = new FetchService(options, { allowPrivateNetwork: true });
  t.after(async () => { await service.close(); await site.close(); });
  await service.fetch({ url: `${site.url}/cookie-page`, waitForSelector: 'main' });
  assert.match(site.state.cookieSeen ?? '', /sid=abc/);
  assert.match(site.state.cookieSeen ?? '', /other=1/);
});
