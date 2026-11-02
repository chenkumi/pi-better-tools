import assert from 'node:assert/strict';
import test from 'node:test';
import { FetchService } from '../../src/fetch/service.js';
import { decodeDocument, fetchStatic, pinnedOptions } from '../../src/fetch/http.js';
import { NetworkPolicy } from '../../src/fetch/network.js';
import { extractHtml } from '../../src/fetch/extract.js';

const signal = () => new AbortController().signal;
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
