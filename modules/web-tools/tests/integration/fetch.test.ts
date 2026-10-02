import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Browser } from 'playwright';
import { FetchService, type FetchOptions } from '../../src/fetch/service.js';

const options: FetchOptions = { channel: 'chromium', timeoutMs: 10_000, maxConcurrency: 2, idleTimeoutMs: 60_000 };
const browserOf = (service: FetchService) => (service as unknown as { browser?: Browser }).browser;

async function fixture() {
  const events = new EventEmitter();
  const hits = new Map<string, number>();
  const held = new Map<string, ServerResponse>();
  let upgrades = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path.startsWith('/hold')) held.set(path, response);
    events.emit('hit', path);
    if (path.startsWith('/hold')) return;
    const html = (body: string, status = 200) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); response.end(body); };
    const redirect = (location: string) => { response.writeHead(302, { location }); response.end(); };
    if (path === '/spa') return html(`<title>Rendered fixture</title><nav>Remove navigation</nav><div id="root"></div><footer>Remove footer</footer><script>
      setTimeout(() => { document.getElementById('root').innerHTML = '<main id="ready"><h1>Hydrated article</h1><p>Content created by JavaScript, not present as rendered markup in the initial document.</p><table><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Apples</td><td>3</td></tr></tbody></table><pre><code class="language-js">const value = 3;\\nconsole.log(value);</code></pre><a href="/article">Absolute link</a></main>'; }, 50);
      </script>`);
    if (path === '/article') return html('<title>Simple article</title><main><h1>Simple article</h1><p>Stable fixture content for checking successful rendering and cleanup.</p></main>');
    if (path === '/state') {
      const id = JSON.stringify(url.searchParams.get('id'));
      return html(`<main id="state"></main><script>const before = localStorage.getItem('id') || 'empty'; const cookieBefore = document.cookie || 'empty'; localStorage.setItem('id', ${id}); document.cookie = 'id=' + ${id}; setTimeout(() => { document.querySelector('main').textContent = [before, cookieBefore, localStorage.getItem('id'), document.cookie].join('|'); document.querySelector('main').id = 'ready'; }, 100);</script>`);
    }
    if (path === '/read-state') return html(`<main id="ready"></main><script>document.querySelector('main').textContent = (localStorage.getItem('id') || 'empty') + '|' + (document.cookie || 'empty');</script>`);
    if (path === '/redirect-one') return redirect('/redirect-two');
    if (path === '/redirect-two') return redirect('/spa');
    if (path === '/redirect-unsafe-one') return redirect('/redirect-unsafe-two');
    if (path === '/redirect-unsafe-two' || path === '/redirect-resource') return redirect(`http://user:TOP_SECRET@127.0.0.1:${(server.address() as AddressInfo).port}/forbidden`);
    if (path === '/subresource') return html('<main>Readable despite a blocked subresource.</main><script src="/redirect-resource"></script>');
    if (path === '/websocket') return html(`<main>Socket test page</main><script>new WebSocket('ws://' + location.host + '/socket');</script>`);
    if (path === '/serviceworker') return html(`<main>Waiting for registration</main><script>navigator.serviceWorker.register('/worker.js').then((registration) => { document.querySelector('main').textContent = registration ? 'Unexpected registration' : 'Registration blocked'; document.querySelector('main').id = 'ready'; }).catch(() => { document.querySelector('main').textContent = 'Registration blocked'; document.querySelector('main').id = 'ready'; });</script>`);
    if (path === '/worker.js') { response.writeHead(200, { 'content-type': 'application/javascript' }); return response.end('self.addEventListener("fetch", () => {});'); }
    if (path === '/challenge') return html('<title>Just a moment</title><main>Verify you are human before proceeding. Sign in to continue.</main><input type="password">');
    if (path === '/download') { response.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="fixture.html"' }); return response.end('download'); }
    if (path === '/pdf') { response.writeHead(200, { 'content-type': 'application/pdf' }); return response.end('%PDF-1.0'); }
    if (path === '/empty') return html('<script>window.nothing = true</script>');
    if (path === '/large-render') return html('<main></main><script>document.querySelector("main").textContent = "x".repeat(5 * 1024 * 1024);</script>');
    if (path === '/error') return html('<main>This is not a successful article.</main>', 503);
    return html('<main>Not found</main>', 404);
  });
  server.on('upgrade', (_request, socket) => { upgrades++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    get upgrades() { return upgrades; },
    waitForHit(path: string): Promise<void> {
      if (hits.has(path)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const listener = (received: string) => { if (received === path) { clearTimeout(timer); events.off('hit', listener); resolve(); } };
        const timer = setTimeout(() => { events.off('hit', listener); reject(new Error(`Fixture request was not received: ${path}`)); }, 15_000);
        events.on('hit', listener);
      });
    },
    release(path: string) { held.get(path)?.end('<main>Released request</main>'); held.delete(path); },
    async close() {
      for (const response of held.values()) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test('real Chromium rendered fetch, isolation, routing and cleanup', { timeout: 90_000 }, async (t) => {
  const site = await fixture();
  const service = new FetchService(options, { allowPrivateNetwork: true });
  t.after(async () => { await service.close(); await site.close(); });

  await t.test('renders SPA content and preserves tables, code and absolute links', async () => {
    const result = await service.fetch({ url: `${site.url}/spa`, waitForSelector: '#ready', extraction: 'main' });
    assert.equal(result.status, 200);
    assert.equal(result.title, 'Rendered fixture');
    assert.equal(result.finalUrl, `${site.url}/spa`);
    assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
    assert.match(result.content, /Hydrated article/);
    assert.match(result.content, /\| Apples\s*\| 3\s*\|/);
    assert.match(result.content, /```js\nconst value = 3;\nconsole.log\(value\);\n```/);
    assert.ok(result.content.includes(`[Absolute link](${site.url}/article)`));
    assert.doesNotMatch(result.content, /Remove navigation|Remove footer|setTimeout/);
    assert.equal(browserOf(service)?.contexts().length, 0);
  });

  await t.test('follows multiple validated redirects and reports the final URL', async () => {
    const result = await service.fetch({ url: `${site.url}/redirect-one`, waitForSelector: '#ready', format: 'text' });
    assert.equal(result.finalUrl, `${site.url}/spa`);
    assert.match(result.content, /Hydrated article/);
  });

  await t.test('concurrent requests have independent cookies and localStorage', async () => {
    const results = await Promise.all(['alpha', 'beta'].map((id) => service.fetch({ url: `${site.url}/state?id=${id}`, waitForSelector: '#ready', extraction: 'main', format: 'text' })));
    assert.equal(results[0]!.content, 'empty|empty|alpha|id=alpha');
    assert.equal(results[1]!.content, 'empty|empty|beta|id=beta');
    const later = await service.fetch({ url: `${site.url}/read-state`, extraction: 'main', format: 'text' });
    assert.equal(later.content, 'empty|empty');
    assert.equal(browserOf(service)?.contexts().length, 0);
  });

  await t.test('unsafe second redirect hop and subresource redirect never reach the destination', async () => {
    await assert.rejects(service.fetch({ url: `${site.url}/redirect-unsafe-one` }), (error: Error) => {
      assert.match(error.message, /^INVALID_URL:/);
      assert.doesNotMatch(error.message, /TOP_SECRET/);
      return true;
    });
    const result = await service.fetch({ url: `${site.url}/subresource`, extraction: 'main' });
    assert.match(result.content, /Readable despite/);
    assert.ok(result.warnings.some((warning) => /subresources/.test(warning)));
    assert.equal(site.hits.get('/forbidden'), undefined);
  });

  await t.test('blocks WebSockets/service workers and warns about obvious access/login challenges', async () => {
    await service.fetch({ url: `${site.url}/websocket` });
    assert.equal(site.upgrades, 0);
    const worker = await service.fetch({ url: `${site.url}/serviceworker`, waitForSelector: '#ready', format: 'text' });
    assert.equal(worker.content, 'Registration blocked');
    assert.equal(site.hits.has('/worker.js'), false);
    const result = await service.fetch({ url: `${site.url}/challenge` });
    assert.ok(result.warnings.some((warning) => /challenge/.test(warning)));
    assert.ok(result.warnings.some((warning) => /login/.test(warning)));
  });

  await t.test('HTTP errors, downloads, PDFs, empty pages and oversized rendered HTML fail explicitly', async () => {
    for (const [path, expected] of [['/error', /HTTP_ERROR:.*503/], ['/missing', /HTTP_ERROR:.*404/], ['/download', /UNSUPPORTED_CONTENT:/], ['/pdf', /UNSUPPORTED_CONTENT:/], ['/empty', /EMPTY_CONTENT:/], ['/large-render', /TOO_LARGE:/]] as const) {
      await assert.rejects(service.fetch({ url: `${site.url}${path}` }), expected);
      assert.equal(browserOf(service)?.contexts().length, 0);
    }
  });

  await t.test('cancellation tears down an in-flight context and allows recovery', async () => {
    const controller = new AbortController();
    const pending = service.fetch({ url: `${site.url}/hold-cancel` }, controller.signal);
    const rejected = assert.rejects(pending, /CANCELLED:/);
    await site.waitForHit('/hold-cancel');
    controller.abort(new Error('external secret must not leak'));
    await rejected;
    assert.equal(browserOf(service)?.contexts().length, 0);
    site.release('/hold-cancel');
    const recovered = await service.fetch({ url: `${site.url}/article` });
    assert.equal(recovered.title, 'Simple article');
    assert.match(recovered.content, /Stable fixture content for checking successful rendering and cleanup/);
  });

  await t.test('shutdown closes the shared browser and rejects subsequent work', async () => {
    const browser = browserOf(service);
    assert.equal(browser?.isConnected(), true);
    await service.close();
    assert.equal(browser?.isConnected(), false);
    await assert.rejects(service.fetch({ url: `${site.url}/article` }), /CLOSED:/);
  });
});

test('queue cancellation and shutdown are bounded and do not start queued requests', { timeout: 45_000 }, async (t) => {
  const site = await fixture();
  const service = new FetchService({ ...options, maxConcurrency: 1 }, { allowPrivateNetwork: true });
  t.after(async () => { await service.close(); await site.close(); });
  const active = service.fetch({ url: `${site.url}/hold-queue` });
  const activeRejected = assert.rejects(active, /CLOSED:/);
  await site.waitForHit('/hold-queue');
  const controller = new AbortController();
  const queued = service.fetch({ url: `${site.url}/queued-never-requested` }, controller.signal);
  const queuedRejected = assert.rejects(queued, /CANCELLED:/);
  controller.abort();
  await queuedRejected;
  assert.equal(site.hits.has('/queued-never-requested'), false);
  assert.equal(browserOf(service)?.contexts().length, 1);
  const shutdownQueued = service.fetch({ url: `${site.url}/shutdown-never-requested` });
  const shutdownRejected = assert.rejects(shutdownQueued, /CLOSED:/);
  const browser = browserOf(service);
  await service.close();
  await Promise.all([activeRejected, shutdownRejected]);
  assert.equal(site.hits.has('/shutdown-never-requested'), false);
  assert.equal(browser?.isConnected(), false);
});

test('deadline covers queue/navigation/selector waits and idle browser is reaped', { timeout: 30_000 }, async (t) => {
  const site = await fixture();
  const service = new FetchService({ ...options, timeoutMs: 2500, maxConcurrency: 1, idleTimeoutMs: 25 }, { allowPrivateNetwork: true });
  t.after(async () => { await service.close(); await site.close(); });
  // Warm startup so this test measures the fetch deadline rather than machine startup speed.
  await service.fetch({ url: `${site.url}/article` });
  const first = service.fetch({ url: `${site.url}/article`, waitForSelector: '#never-created' });
  const firstRejected = assert.rejects(first, /TIMEOUT:/);
  const started = performance.now();
  const second = service.fetch({ url: `${site.url}/hold-deadline` });
  const secondRejected = assert.rejects(second, /TIMEOUT:/);
  await Promise.all([firstRejected, secondRejected]);
  assert.ok(performance.now() - started < 4500, 'queued work must not receive a fresh timeout after acquiring a slot');
  assert.equal(browserOf(service)?.contexts().length, 0);
  const browser = browserOf(service);
  assert.ok(browser);
  if (browser.isConnected()) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Idle browser did not disconnect')), 5000);
      browser.once('disconnected', () => { clearTimeout(timer); resolve(); });
    });
  }
  assert.equal(browser.isConnected(), false);
  const recovered = await service.fetch({ url: `${site.url}/article` });
  assert.equal(recovered.title, 'Simple article');
  assert.match(recovered.content, /Stable fixture content for checking successful rendering and cleanup/);
});
