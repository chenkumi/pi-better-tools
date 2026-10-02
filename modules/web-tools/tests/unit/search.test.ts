import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../../src/config.ts';
import { search } from '../../src/search.ts';
const config = () => { const c = defaults(); c.provider = 'brave'; c.providers.brave = { apiKey: 'SECRET' }; c.providers.exa = { apiKey: 'EXASECRET' }; return c; };
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

test('Brave query encoding, header, snippets and source deduplication', async () => {
  const result = await search(config(), { query: 'a & b 中文', numResults: 5 }, undefined, async (url, init) => {
    assert.equal(new URL(url).searchParams.get('q'), 'a & b 中文');
    assert.equal(new URL(url).searchParams.get('count'), '5');
    assert.equal(new Headers(init.headers).get('X-Subscription-Token'), 'SECRET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return json({ web: { results: [
      { title: '<b>Title</b>', url: 'https://example.com/a#one', description: '<b>snippet</b>' },
      { title: 'duplicate', url: 'https://example.com/a#two' },
      { title: 'bad', url: 'javascript:alert(1)' },
    ] } });
  });
  assert.deepEqual(result.results, [{ title: 'Title', url: 'https://example.com/a', snippet: 'snippet' }]);
  assert.equal(result.warnings.length, 1);
});
test('Exa uses auto search and highlights without extra model synthesis', async () => {
  const result = await search(config(), { query: 'topic', provider: 'exa', numResults: 2 }, undefined, async (url, init) => {
    assert.equal(url, 'https://api.exa.ai/search');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('x-api-key'), 'EXASECRET');
    const body = JSON.parse(init.body as string);
    assert.equal(body.type, 'auto'); assert.equal(body.numResults, 2); assert.ok(body.contents.highlights);
    return json({ results: [{ title: 'Page', url: 'https://example.com', highlights: ['first', 'second'], publishedDate: '2026-01-01' }] });
  });
  assert.equal(result.results[0]?.snippet, 'first\nsecond');
  assert.equal(result.results[0]?.publishedAt, '2026-01-01');
});
test('HTTP errors and invalid payloads never leak upstream secrets; no retries', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM_ERROR']] as const) {
    let calls = 0;
    await assert.rejects(search(config(), { query: 'topic' }, undefined, async () => { calls++; return new Response('SECRET upstream data', { status }); }),
      (e: Error) => e.message.includes(code) && !e.message.includes('SECRET'));
    assert.equal(calls, 1);
  }
  await assert.rejects(search(config(), { query: 'topic' }, undefined, async () => { throw new Error('SECRET network log'); }), /UPSTREAM_ERROR: brave request failed/);
  await assert.rejects(search(config(), { query: 'topic' }, undefined, async () => new Response('SECRET invalid JSON')), /invalid search JSON/);
});
test('cancellation reaches HTTP and pre-aborted calls never send requests', async () => {
  const c = new AbortController(); c.abort();
  await assert.rejects(search(config(), { query: 'topic' }, c.signal, async () => { assert.fail('must not send'); }), /CANCELLED/);
  const pending = new AbortController();
  const promise = search(config(), { query: 'topic' }, pending.signal, async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  pending.abort();
  await assert.rejects(promise, /CANCELLED/);
});
test('deadline cancels and provider selection cannot silently fall back', async () => {
  const c = config(); c.searchTimeoutMs = 20;
  await assert.rejects(search(c, { query: 'topic' }, undefined, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  })), /TIMEOUT/);
  c.provider = 'openai';
  await assert.rejects(search(c, { query: 'topic' }), /PROVIDER_UNSUPPORTED/);
  await assert.rejects(search(config(), { query: '', provider: 'brave' }), /CONFIG_INVALID/);
});
test('present malformed Brave section is not confused with an empty search', async () => {
  for (const web of ['invalid', null, 42, []]) {
    await assert.rejects(search(config(), { query: 'topic' }, undefined, async () => json({ web })), /invalid Brave web section/);
  }
});
test('legitimate empty results and bounded response bodies', async () => {
  assert.deepEqual((await search(config(), { query: 'nothing' }, undefined, async () => json({}))).results, []);
  await assert.rejects(search(config(), { query: 'large' }, undefined, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /too large/);
});
