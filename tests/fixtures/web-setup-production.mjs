import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run only in the isolated production installation, with no development loader.
const packageRoot = resolve(process.argv[2]);
const hostRoot = resolve(process.env.PI_BETTER_TOOLS_HOST);
const browserCache = resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
assert.ok(browserCache.startsWith(resolve(process.cwd())), 'browser cache must be inside owned fixture cwd');
await mkdir(browserCache, { recursive: true });
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(manifest.bin['pi-better-tools'], 'setup/cli.mjs');
const hostRequire = createRequire(join(hostRoot, 'package.json'));
// jiti is the actual production host loader dependency, not tsx/typescript from the checkout.
const { createJiti } = hostRequire('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const { FetchService } = await jiti.import(pathToFileURL(join(packageRoot, 'modules/web-tools/src/fetch/service.ts')).href);
let requests = 0;
const server = createServer((_request, response) => {
  requests++;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<title>Packaged static page</title><main><h1>STATIC_PRODUCTION</h1><p>繁體中文</p></main><script>document.querySelector("main").textContent="DYNAMIC_ONLY"</script>');
});
const heartbeat = setInterval(() => console.error('[web-setup] Packaged no-browser verification still running...'), 10000);
let service;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  // Explicit code-only fixture seam; no model-callable/config private-network bypass.
  service = new FetchService({ channel: 'chromium', timeoutMs: 30000, maxConcurrency: 1, idleTimeoutMs: 0 }, { allowPrivateNetwork: true });
  const result = await service.fetch({ url, format: 'text' });
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Packaged static page');
  assert.match(result.content, /STATIC_PRODUCTION/);
  assert.match(result.content, /繁體中文/);
  assert.doesNotMatch(result.content, /DYNAMIC_ONLY/);
  assert.match(result.warnings.join(' '), /static|HTTP/i);
  assert.equal(requests, 1);
  await assert.rejects(service.fetch({ url, waitForSelector: 'main' }), /BROWSER_UNAVAILABLE:/);
  assert.equal(requests, 1, 'selector requires browser and must not send an HTTP downgrade request');
  await service.close();
  const publicOnly = new FetchService({ channel: 'chromium', timeoutMs: 30000, maxConcurrency: 1, idleTimeoutMs: 0 });
  try { await assert.rejects(publicOnly.fetch({ url }), /NETWORK_BLOCKED:/); }
  finally { await publicOnly.close(); }
  assert.equal(requests, 1, 'production private-network policy remains enforced');
  console.log(JSON.stringify({ status: 'passed', cases: ['production-host-loader', 'missing-browser-static', 'unicode', 'no-javascript', 'selector-no-request', 'private-network-blocked'], requests }));
} finally {
  await service?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  clearInterval(heartbeat);
}
