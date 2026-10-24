import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { chromium } from 'playwright';
import { FetchService, MAX_SUBRESOURCE_REQUESTS } from '../../src/fetch/service.js';

// Every network request a subresource makes counts against the per-fetch budget, including each hop of a redirect
// chain: a page whose scripts redirect 19 times must not be able to turn 200 admitted requests into thousands.
const HOPS = 19; // the proxy follows at most 20 requests per subresource (19 redirects)
const SUBRESOURCES = 20; // 20 x 20 = 400 requests if hops were free, far above the 200 budget

test('redirect hops of subresources count against the request budget', async (t) => {
  let redirectHits = 0;
  const server = http.createServer((req, res) => {
    const match = /^\/r\/(\d+)\/(\d+)$/.exec(req.url ?? '');
    if (!match) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><p>hello</p></body></html>'); return; }
    redirectHits++;
    const hop = Number(match[2]);
    if (hop < HOPS) { res.writeHead(302, { location: `/r/${match[1]}/${hop + 1}` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('1');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let handler: ((route: any) => Promise<void>) | undefined;
  const mainFrame = {};
  const requestOf = (url: string, navigation: boolean, type: string) => ({
    url: () => url, method: () => 'GET', isNavigationRequest: () => navigation, frame: () => mainFrame,
    resourceType: () => type, headers: () => ({}), postDataBuffer: () => null,
  });
  const routeOf = (request: unknown) => ({ request: () => request, abort: async () => {}, fulfill: async () => {} });
  const page = {
    on() {}, mainFrame: () => mainFrame, url: () => `${base}/page`, waitForTimeout: async () => {},
    evaluate: async () => '<html><body><p>hello</p></body></html>',
    goto: async (url: string) => {
      await handler!(routeOf(requestOf(url, true, 'document')));
      for (let i = 0; i < SUBRESOURCES; i++) await handler!(routeOf(requestOf(`${base}/r/${i}/0`, false, 'script')));
      return { status: () => 200 };
    },
  };
  const context = {
    on() {}, close: async () => {}, cookies: async () => [], addCookies: async () => {}, newPage: async () => page,
    routeWebSocket: async () => {}, route: async (_pattern: string, fn: (route: any) => Promise<void>) => { handler = fn; },
  };
  const browser = { isConnected: () => true, on() {}, close: async () => {}, newContext: async () => context };
  t.mock.method(chromium, 'launch', async () => browser);

  const service = new FetchService({ channel: 'chromium', timeoutMs: 20_000, maxConcurrency: 1, idleTimeoutMs: 0 }, { allowPrivateNetwork: true });
  try {
    await service.fetch({ url: `${base}/page` });
  } finally { await service.close(); }
  assert.ok(redirectHits <= MAX_SUBRESOURCE_REQUESTS, `subresource requests (incl. redirect hops) stay within the budget; got ${redirectHits}`);
  assert.ok(redirectHits > MAX_SUBRESOURCE_REQUESTS / 2, 'the scenario really did issue many requests');
});
