import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import test from 'node:test';
import { extractHtml, MAX_EXTRACTED_BYTES, MAX_HTML_BYTES } from '../../src/fetch/extract.js';
import { isPublicAddress, NetworkPolicy, parseWebUrl } from '../../src/fetch/network.js';
import { certificateOrEmpty, installPlaywrightTlsCompatibility } from '../../src/fetch/playwright-tls-compat.js';
import { FetchQueue, FetchService } from '../../src/fetch/service.js';

const article = `<!doctype html><title>Fixture article</title><nav>Discard navigation</nav><main>
<h1>Useful heading</h1><p>A real paragraph about testing rendered documents and extracting useful readable information.</p>
<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Answer</td><td>42</td></tr></tbody></table>
<pre><code class="language-js">const answer = 42;\nconsole.log(answer);</code></pre>
<a href="../safe?q=one">Relative link</a><a href="javascript:alert(1)">Unsafe link</a>
<a href="https://user:password@example.org/">Credential link</a>
</main><script>document.querySelector('main').textContent = 'SCRIPT_EXECUTED_BY_EXTRACTOR';</script><footer>Discard footer</footer>`;

test('Playwright TLS compatibility handles a destroyed socket certificate result', () => {
  const socket = new TLSSocket(new Socket());
  socket.destroy();
  assert.equal(socket.getPeerCertificate(), null);
  assert.deepEqual(certificateOrEmpty(null), {});
  installPlaywrightTlsCompatibility();
  installPlaywrightTlsCompatibility();
  assert.deepEqual(socket.getPeerCertificate(), {});
});

test('HTML extraction suppresses jsdom diagnostics from malformed CSS', () => {
  const originalError = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    const result = extractHtml('<style>}</style><main>Readable content</main>', 'https://example.org/', 'text');
    assert.equal(result.content, 'Readable content');
    assert.deepEqual(messages, []);
  } finally {
    console.error = originalError;
  }
});

test('main extraction preserves GFM tables, fenced code and absolute safe links', () => {
  const result = extractHtml(article, 'https://example.org/path/page', 'markdown', 'main');
  assert.equal(result.title, 'Fixture article');
  assert.equal(result.extraction, 'main');
  assert.match(result.content, /\| Name\s*\| Value\s*\|/);
  assert.match(result.content, /\| Answer\s*\| 42\s*\|/);
  assert.match(result.content, /```(?:js)?\nconst answer = 42;/);
  assert.match(result.content, /\[Relative link\]\(https:\/\/example.org\/safe\?q=one\)/);
  assert.doesNotMatch(result.content, /javascript:|password|Discard navigation|Discard footer|SCRIPT_EXECUTED_BY_EXTRACTOR/);
});

test('body/text mode strips noise and does not trust a supplied base URL', () => {
  const result = extractHtml(`<base href="https://attacker.invalid/"><nav>Menu</nav><div>Plain body</div><a href="next">Next</a><footer>Footer</footer>`, 'https://example.org/path/', 'markdown', 'body');
  assert.match(result.content, /https:\/\/example.org\/path\/next/);
  assert.doesNotMatch(result.content, /attacker|Menu|Footer/);
  const text = extractHtml(article, 'https://example.org/', 'text', 'main').content;
  assert.match(text, /Useful heading/);
  assert.match(text, /const answer = 42;\nconsole.log\(answer\);/);
  assert.doesNotMatch(text, /```|<table>|Discard/);
});

test('automatic extraction and missing-main fallback return usable content', () => {
  const automatic = extractHtml(article, 'https://example.org/');
  assert.ok(['readability', 'main', 'body'].includes(automatic.extraction));
  assert.match(automatic.content, /Useful heading/);
  const fallback = extractHtml('<body><div>Small fallback content.</div></body>', 'https://example.org/', 'text', 'main');
  assert.equal(fallback.extraction, 'body');
  assert.equal(fallback.content, 'Small fallback content.');
  assert.match(fallback.warnings.join(' '), /main/);
});

test('challenge and login detection warn without claiming authenticated content', () => {
  const result = extractHtml('<title>Just a moment</title><h1>Verify you are human</h1><input type="password"><p>Sign in to continue</p>', 'https://example.org/');
  assert.ok(result.warnings.some((warning) => /challenge/.test(warning)));
  assert.ok(result.warnings.some((warning) => /login/.test(warning)));
});

test('empty and byte-oversized documents are errors rather than successful empty output', () => {
  assert.throws(() => extractHtml('<script>secret()</script><nav>Only navigation</nav>', 'https://example.org/'), /EMPTY_CONTENT:/);
  assert.throws(() => extractHtml('x'.repeat(MAX_HTML_BYTES + 1), 'https://example.org/'), /TOO_LARGE:/);
  assert.throws(() => extractHtml(`<main>${'é'.repeat(MAX_EXTRACTED_BYTES / 2 + 1)}</main>`, 'https://example.org/', 'text', 'main'), /TOO_LARGE:/);
});

test('public-address policy rejects special IPv4, IPv6 and mapped IPv4 ranges', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', 'fe80::1%lo0', 'garbage']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address), true, address);
});

test('URL policy rejects credentials, unsafe protocols, normalized private IPs and local names', async () => {
  const policy = new NetworkPolicy();
  for (const url of ['file:///etc/passwd', 'data:text/html,hello', 'ftp://example.org/', 'https://user:secret@example.org/', 'not a URL']) {
    assert.throws(() => parseWebUrl(url), /INVALID_URL:/, url);
  }
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://localhost./', 'http://host.localhost/', 'http://machine.local/']) {
    await assert.rejects(policy.validate(url), /NETWORK_BLOCKED:/, url);
  }
  assert.equal((await new NetworkPolicy(true).validate('http://127.0.0.1/')).hostname, '127.0.0.1');
  await assert.rejects(new NetworkPolicy(true).validate('http://user:secret@127.0.0.1/'), /INVALID_URL:/);
});

test('DNS policy checks every result and sanitizes lookup errors', async () => {
  const mixed = new NetworkPolicy(false, async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }]);
  await assert.rejects(mixed.validate('https://example.org/'), /NETWORK_BLOCKED:/);
  const empty = new NetworkPolicy(false, async () => []);
  await assert.rejects(empty.validate('https://example.org/'), /NETWORK_BLOCKED:/);
  const publicOnly = new NetworkPolicy(false, async () => [{ address: '8.8.8.8' }, { address: '2606:4700:4700::1111' }]);
  assert.equal((await publicOnly.validate('https://example.org/')).hostname, 'example.org');
  const failed = new NetworkPolicy(false, async () => { throw new Error('token=SUPER_SECRET'); });
  await assert.rejects(failed.validate('https://example.org/?token=SUPER_SECRET'), (error: Error) => {
    assert.match(error.message, /^NETWORK_ERROR:/);
    assert.doesNotMatch(error.message, /SUPER_SECRET/);
    return true;
  });
});

test('queue is bounded, FIFO, abort-aware and releases slots only once', async () => {
  const queue = new FetchQueue(1, 2);
  const first = await queue.acquire(new AbortController().signal);
  const cancelled = new AbortController();
  const second = queue.acquire(cancelled.signal);
  const cancelledCheck = assert.rejects(second, /Cancelled waiter/);
  const third = queue.acquire(new AbortController().signal);
  await assert.rejects(queue.acquire(new AbortController().signal), /BUSY:/);
  cancelled.abort(new Error('Cancelled waiter'));
  await cancelledCheck;
  first(); first();
  const releaseThird = await third;
  let granted = false;
  const fourth = queue.acquire(new AbortController().signal).then((release) => { granted = true; return release; });
  await Promise.resolve();
  assert.equal(granted, false);
  releaseThird();
  (await fourth)();
});

test('pre-abort, default private-network rejection, and close do not require browser startup', async () => {
  const service = new FetchService({ channel: 'chromium', timeoutMs: 1000, maxConcurrency: 1, idleTimeoutMs: 10 });
  try {
    const controller = new AbortController();
    controller.abort(new Error('external secret'));
    await assert.rejects(service.fetch({ url: 'https://example.org/' }, controller.signal), /^Error: CANCELLED:/);
    await assert.rejects(service.fetch({ url: 'http://127.0.0.1/' }), /NETWORK_BLOCKED:/);
    await assert.rejects(service.fetch({ url: 'http://user:secret@example.org/' }), (error: Error) => !error.message.includes('secret') && error.message.startsWith('INVALID_URL:'));
  } finally { await service.close(); }
  await service.close();
  await assert.rejects(service.fetch({ url: 'https://example.org/' }), /CLOSED:/);
});
