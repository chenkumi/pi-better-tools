import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { FetchService } from '../../src/fetch/service.js';
import { decodeDocument, fetchStatic, pinnedOptions } from '../../src/fetch/http.js';
import { NetworkPolicy } from '../../src/fetch/network.js';
import { extractHtml } from '../../src/fetch/extract.js';

const signal = () => new AbortController().signal;
test('only missing executables reach static transport; selector, unknown, permission, deps and timeout never do', async t => {
  for (const [message, expected] of [
    ["Executable doesn't exist at SECRET", /Static HTTP cannot honor waitForSelector/],
    ["Chromium distribution 'chrome' is not found at SECRET", /Static HTTP cannot honor waitForSelector/],
    ['unknown SECRET', /Browser startup failed/], ['spawn EACCES', /permission was denied/],
    ['Host system is missing dependencies', /system dependencies are missing/],
    ['timeout', /Browser startup timed out/],
  ] as const) {
    const launch = t.mock.method(chromium, 'launch', async () => { throw Object.assign(new Error(message), { name: message === 'timeout' ? 'TimeoutError' : 'Error' }); });
    const service = new FetchService({ channel: 'chromium', timeoutMs: 30_000, maxConcurrency: 1, idleTimeoutMs: 0 }, { allowPrivateNetwork: true });
    const resolve = t.mock.method(service['policy'], 'resolveTarget', async () => { throw new Error('UNEXPECTED_TRANSPORT'); });
    try {
      await assert.rejects(service.fetch({ url: 'http://127.0.0.1/', waitForSelector: 'main' }), expected);
      assert.equal(resolve.mock.callCount(), 0);
    } finally { launch.mock.restore(); await service.close(); }
  }
});
test('fallback retains the original deadline rather than resetting it after launch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolving!: () => void;
  const started = new Promise<void>(resolve => { resolving = resolve; });
  t.mock.method(chromium, 'launch', async () => {
    t.mock.timers.tick(600);
    throw new Error("Executable doesn't exist at SECRET");
  });
  const service = new FetchService({ channel: 'chromium', timeoutMs: 1000, maxConcurrency: 1, idleTimeoutMs: 0 }, { allowPrivateNetwork: true });
  let releaseLookup!: (value: { url: URL; address: string }) => void;
  t.mock.method(service['policy'], 'resolveTarget', () => new Promise(resolve => { releaseLookup = resolve; resolving(); }));
  try {
    const pending = service.fetch({ url: 'http://127.0.0.1/' });
    const rejected = assert.rejects(pending, /TIMEOUT:/);
    await started;
    t.mock.timers.tick(400);
    await rejected;
    releaseLookup({ url: new URL('http://127.0.0.1/'), address: '127.0.0.1' });
    assert.equal(service['operations'].size, 0);
  } finally { await service.close(); }
});

test('HTTP target validation rejects all mixed DNS sets and special IPv4/IPv6 before connecting', async () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254', 'garbage']) {
    const policy = new NetworkPolicy(false, async () => [{ address: '8.8.8.8' }, { address }]);
    await assert.rejects(fetchStatic('https://public.example/', policy, signal()), /NETWORK_BLOCKED:/);
  }
  for (const url of ['http://127.1/', 'http://[::1]/', 'http://host.local/', 'https://u:p@example.org/', 'file:///tmp/file']) {
    await assert.rejects(fetchStatic(url, new NetworkPolicy(), signal()), /NETWORK_BLOCKED:|INVALID_URL:/);
  }
});

test('pinned lookup does not re-resolve; Host/SNI identity remains the URL hostname for IPv4 and IPv6', async () => {
  let calls = 0;
  const policy = new NetworkPolicy(false, async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1' }]);
  const target = await policy.resolveTarget('https://public.example/path');
  for (const address of [target.address, '2606:4700:4700::1111']) {
    const options = pinnedOptions(target.url, address, signal());
    assert.equal(options.hostname, 'public.example');
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.autoSelectFamily, false);
    const lookup = options.lookup!;
    await new Promise<void>((resolve, reject) => lookup('public.example', { all: false }, (error, actual, family) => {
      if (error) return reject(error);
      assert.equal(actual, address); assert.equal(family, address.includes(':') ? 6 : 4); resolve();
    }));
    await new Promise<void>((resolve, reject) => lookup('public.example', { all: true }, (error, actual) => {
      if (error) return reject(error);
      assert.deepEqual(actual, [{ address, family: address.includes(':') ? 6 : 4 }]); resolve();
    }));
  }
  assert.equal(calls, 1);
  await assert.rejects(policy.resolveTarget('https://public.example/redirect'), /NETWORK_BLOCKED:/);
});

test('charset/BOM decoding and text/plain escaping preserve text rather than interpret HTML', () => {
  const plain = '<script>not executable</script><h1>literal</h1>& text';
  const html = decodeDocument(Buffer.from(plain), 'text/plain; charset=utf-8');
  assert.equal(extractHtml(html, 'https://example.org/', 'text', 'main').content, plain);
  assert.match(decodeDocument(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=windows-1252'), /café/);
  assert.match(decodeDocument(Buffer.from('\ufeff<main>你好</main>', 'utf16le'), 'text/html; charset=ascii'), /你好/);
  assert.match(decodeDocument(Buffer.concat([Buffer.from('<meta charset="windows-1252"><main>caf'), Buffer.from([0xe9]), Buffer.from('</main>')]), 'text/html'), /café/);
  assert.throws(() => decodeDocument(Buffer.from('x'), 'text/html; charset=invalid-charset'), /UNSUPPORTED_CONTENT:/);
});

test('abort rejects a pending DNS lookup immediately and prevents late connection', async () => {
  let finish!: (value: { address: string }[]) => void;
  const policy = new NetworkPolicy(false, () => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = fetchStatic('https://public.example/', policy, controller.signal);
  const rejected = assert.rejects(pending, /CANCELLED: test/);
  controller.abort(new Error('CANCELLED: test'));
  await rejected;
  finish([{ address: '8.8.8.8' }]);
  await Promise.resolve();
});
