import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, defaults, parseConfig, resolveKey } from '../../src/config.ts';
import { search } from '../../src/search.ts';
import { injectNativeSearch } from '../../src/native-openai.ts';
import { injectGeminiSearch } from '../../src/native-google.ts';
import { injectAnthropicSearch } from '../../src/native-anthropic.ts';
import { NetworkPolicy, parseWebUrl } from '../../src/fetch/network.js';
import { describeNetworkFailure, httpStatusAdvice } from '../../src/fetch/failure.js';
import { FetchService } from '../../src/fetch/service.js';
import { registerWebTools } from '../../src/index.ts';

const message = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return assert.fail('expected throw'); };
const rejection = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return (e as Error).message; } return assert.fail('expected rejection'); };
const config = () => { const c = defaults(); c.provider = 'brave'; c.providers.brave = { apiKey: 'SECRETKEY' }; return c; };
// Agent-facing text may name tool args and error codes only; never settings keys, environment variables or config paths.
const FORBIDDEN = /apiKey|apiKeyEnv|providers\.|CONFIG_PATH|timeoutMs\)|fetch\.timeoutMs|\.json|[A-Z]+_API_KEY|PI_WEB_TOOLS|enabled"|"provider"|web-search\.json/;
const agentSafe = (text: string): void => { assert.doesNotMatch(text, FORBIDDEN); assert.ok(!text.includes(CONFIG_PATH)); };

test('INVALID_URL messages name the parameter, rule and fix without echoing credentials', () => {
  assert.match(message(() => parseWebUrl('not a url')), /INVALID_URL:.*"url".*absolute.*https:\/\//);
  const scheme = message(() => parseWebUrl('file:///etc/passwd'));
  assert.match(scheme, /file:/); assert.match(scheme, /public http/i); assert.ok(!scheme.includes('passwd'));
  const creds = message(() => parseWebUrl('https://user:SECRETPW@example.org/'));
  assert.match(creds, /credentials/); assert.match(creds, /remove/i); assert.ok(!creds.includes('SECRETPW'));
});

test('NETWORK_BLOCKED and DNS errors name the host the caller supplied, never resolved addresses', async () => {
  const policy = new NetworkPolicy(false, async () => [{ address: '10.9.8.7' }]);
  const local = await rejection(policy.validate('http://localhost:8080/'));
  assert.match(local, /NETWORK_BLOCKED:.*"localhost"/); assert.match(local, /public/);
  const literal = await rejection(policy.validate('http://192.168.1.5/'));
  assert.match(literal, /"192\.168\.1\.5"/); assert.match(literal, /private/i);
  const resolved = await rejection(policy.validate('https://rebind.example/'));
  assert.match(resolved, /"rebind\.example"/); assert.ok(!resolved.includes('10.9.8.7'));
  const failing = new NetworkPolicy(false, async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND secret-internal'), { code: 'ENOTFOUND' }); });
  const dns = await rejection(failing.validate('https://nope.example/'));
  assert.match(dns, /NETWORK_ERROR:.*DNS.*"nope\.example"/); assert.ok(!dns.includes('secret-internal'));
  assert.match(await rejection(failing.resolveTarget('https://nope.example/')), /DNS.*"nope\.example"/);
  assert.match(await rejection(policy.resolveTarget('http://x.local/')), /"x\.local".*public/);
});

test('failure classifiers give safe categories and per-status advice', () => {
  assert.match(describeNetworkFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), /refused/);
  assert.match(describeNetworkFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('y'), { code: 'ENOTFOUND' }) })), /DNS/);
  assert.match(describeNetworkFailure(Object.assign(new Error('z'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })), /TLS/);
  assert.match(describeNetworkFailure(new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://t/?token=SECRET')), /TLS/);
  assert.ok(!describeNetworkFailure(new Error('SECRET log')).includes('SECRET'));
  for (const [status, re] of [[401, /login|credential/i], [403, /blocked|forbidden|login/i], [404, /check the url/i], [429, /retry later|rate/i], [503, /retry/i]] as const) assert.match(httpStatusAdvice(status), re);
});

test('web_search input errors are INVALID_INPUT naming the parameter, rule and received size', async () => {
  const blank = await rejection(search(config(), { query: '   ' }, undefined, async () => { throw new Error('unreachable'); }));
  assert.match(blank, /^INVALID_INPUT:.*`query`.*1.*2000/);
  const long = await rejection(search(config(), { query: 'a'.repeat(2001) }));
  assert.match(long, /^INVALID_INPUT:.*`query`.*2001/);
  const n = await rejection(search(config(), { query: 'x', numResults: 25 }));
  assert.match(n, /^INVALID_INPUT:.*`numResults`.*1.*10.*25/);
});

test('AUTH_REQUIRED names provider and neutral fix; no config keys, env vars, paths or key material', () => {
  const brave = message(() => resolveKey({ apiKeyEnv: 'BRAVE_API_KEY' }, {}, 'brave'));
  assert.match(brave, /AUTH_REQUIRED:.*brave/i); assert.match(brave, /search service API key/); assert.match(brave, /web tools configuration/); assert.match(brave, /\/reload/); agentSafe(brave);
  const exa = message(() => resolveKey({ apiKeyEnv: 'EXA_API_KEY' }, {}, 'exa'));
  assert.match(exa, /exa/); agentSafe(exa);
  const blank = message(() => resolveKey({ apiKey: ' ' }, {}, 'brave')); agentSafe(blank);
  agentSafe(message(() => resolveKey({}, {}, 'brave')));
  agentSafe(message(() => resolveKey({})));
});

test('credential rejection and DeepSeek login messages are agent-safe', async () => {
  const rejected = await rejection(search(config(), { query: 'q' }, undefined, async () => new Response('', { status: 401 })));
  assert.match(rejected, /AUTH_REQUIRED: brave/); agentSafe(rejected);
  const c = config(); c.provider = 'deepseek'; c.providers.deepseek = {};
  const login = await rejection(search(c, { query: 'q' }, undefined, async () => { throw new Error('unreachable'); }));
  assert.match(login, /AUTH_REQUIRED/); assert.match(login, /\/login/); agentSafe(login);
  for (const provider of ['exa', 'deepseek'] as const) {
    const k = config(); k.provider = provider; k.providers[provider] = { apiKey: 'SECRETKEY' };
    agentSafe(await rejection(search(k, { query: 'q' }, undefined, async () => new Response('', { status: 403 }))));
  }
});

test('search failures state provider, safe cause category and advice without leaking secrets', async () => {
  const dns = await rejection(search(config(), { query: 'q' }, undefined, async () => { throw new TypeError('fetch failed SECRETKEY', { cause: Object.assign(new Error('SECRETKEY'), { code: 'ENOTFOUND' }) }); }));
  assert.match(dns, /UPSTREAM_ERROR: brave request failed/); assert.match(dns, /DNS/); assert.ok(!dns.includes('SECRETKEY'));
  const unknown = await rejection(search(config(), { query: 'q' }, undefined, async () => { throw new Error('SECRET network log'); }));
  assert.match(unknown, /brave request failed/); assert.ok(!unknown.includes('SECRET'));
  const http500 = await rejection(search(config(), { query: 'q' }, undefined, async () => new Response('SECRET body', { status: 502 })));
  assert.match(http500, /HTTP 502/); assert.match(http500, /retry/i); assert.ok(!http500.includes('SECRET'));
  const http400 = await rejection(search(config(), { query: 'q' }, undefined, async () => new Response('SECRET body', { status: 400 })));
  assert.match(http400, /HTTP 400/); assert.match(http400, /query|quota|plan/i);
  const auth = await rejection(search(config(), { query: 'q' }, undefined, async () => new Response('', { status: 401 })));
  assert.match(auth, /AUTH_REQUIRED: brave/); agentSafe(auth);
  const rate = await rejection(search(config(), { query: 'q' }, undefined, async () => new Response('', { status: 429 })));
  assert.match(rate, /RATE_LIMITED: brave/); assert.match(rate, /wait|retry/i);
  const bad = await rejection(search(config(), { query: 'q' }, undefined, async () => new Response('SECRET not json')));
  assert.match(bad, /invalid search JSON/); assert.match(bad, /retry|web_fetch/i); assert.ok(!bad.includes('SECRET'));
  const c = config(); c.searchTimeoutMs = 1000;
  const timeout = await rejection(search(c, { query: 'q' }, undefined, (_u, init) => new Promise((_r, rej) => { init.signal!.addEventListener('abort', () => rej(new Error('aborted'))); })));
  assert.match(timeout, /^TIMEOUT:.*1000/);
});

test('disabled and native-selected search explain how to enable the tool', async () => {
  const off = config(); off.enabled = false;
  const disabled = await rejection(search(off, { query: 'q' }));
  assert.match(disabled, /^CONFIG_INVALID:.*disabled.*enable.*\/reload/s); agentSafe(disabled);
  const native = config(); native.provider = 'native';
  const unsupported = await rejection(search(native, { query: 'q' }));
  assert.match(unsupported, /^PROVIDER_UNSUPPORTED:.*brave.*exa.*deepseek.*\/reload/s); agentSafe(unsupported);
});

test('browser startup timeout and fetch deadline messages are agent-safe', () => {
  const src = readFileSync(new URL('../../src/fetch/service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch\.timeoutMs/);
});

test('config errors give the rule and allowed values', () => {
  assert.match(message(() => parseConfig({ numResults: 99 })), /CONFIG_INVALID: numResults.*integer.*1.*10/);
  assert.match(message(() => parseConfig({ provider: 'gemini' })), /provider.*one of.*brave.*exa.*deepseek/);
  assert.match(message(() => parseConfig({ fetch: { channel: 'firefox' } })), /fetch\.channel.*chromium.*chrome/);
  assert.match(message(() => parseConfig({ enabled: 'yes' })), /enabled.*true or false/);
  assert.match(message(() => parseConfig({ bogus: 1 })), /root.*unknown field.*allowed/);
  assert.match(message(() => parseConfig({ providers: { brave: { apiKeyEnv: 'bad name' } } })), /providers\.brave\.apiKeyEnv.*environment variable name/);
});

test('invalid browser fetch options name the field', () => {
  assert.throws(() => new FetchService({ channel: 'chromium', timeoutMs: 1000, maxConcurrency: 99, idleTimeoutMs: 10 }), /CONFIG_ERROR:.*maxConcurrency.*1.*32/);
  assert.throws(() => new FetchService({ channel: 'firefox' as never, timeoutMs: 1000, maxConcurrency: 1, idleTimeoutMs: 10 }), /CONFIG_ERROR:.*channel/);
});

test('waitForSelector limit matches the schema (500) and fetch input errors list valid values', async () => {
  const service = new FetchService({ channel: 'chromium', timeoutMs: 1000, maxConcurrency: 1, idleTimeoutMs: 10 });
  try {
    assert.match(await rejection(service.fetch({ url: 'https://example.org/', waitForSelector: 'a'.repeat(501) })), /INVALID_INPUT:.*waitForSelector.*1.*500.*501/);
    assert.match(await rejection(service.fetch({ url: 'https://example.org/', format: 'html' as never })), /INVALID_INPUT:.*format.*markdown.*text/);
    assert.match(await rejection(service.fetch({ url: 'https://example.org/', extraction: 'x' as never })), /INVALID_INPUT:.*extraction.*auto.*main.*body/);
  } finally { await service.close(); }
});

test('static charset errors show the received charset and a fix', async () => {
  const { decodeDocument } = await import('../../src/fetch/http.js');
  const m = message(() => decodeDocument(Buffer.from('x'), 'text/html; charset=bogus-9'));
  assert.match(m, /UNSUPPORTED_CONTENT:.*"bogus-9"/); assert.match(m, /UTF-8|another|different/i);
});

test('web_fetch tells the agent why web_search is missing only when the configuration is invalid', () => {
  const build = (read: () => ReturnType<typeof defaults>) => {
    const defs = new Map<string, { promptGuidelines?: string[] }>();
    const pi = { getActiveTools: () => [], registerTool: (t: { name: string }) => defs.set(t.name, t as never), on() {}, registerCommand() {}, appendEntry() {} } as never;
    registerWebTools(pi, read, () => {});
    return defs;
  };
  const bad = build(() => { throw new Error('CONFIG_INVALID: providers.brave.apiKeyEnv: must be an environment variable name'); });
  assert.ok(!bad.has('web_search'));
  const guidelines = (bad.get('web_fetch')!.promptGuidelines ?? []).join('\n');
  assert.match(guidelines, /web_search is unavailable/); assert.match(guidelines, /CONFIG_INVALID/); assert.match(guidelines, /\/reload/); agentSafe(guidelines);
  const unreadable = build(() => { throw new Error('CONFIG_INVALID: invalid JSON (values omitted for security)'); });
  const unreadableText = (unreadable.get('web_fetch')!.promptGuidelines ?? []).join('\n');
  assert.match(unreadableText, /invalid JSON/); agentSafe(unreadableText);
  const ok = build(() => config());
  assert.ok(!(ok.get('web_fetch')!.promptGuidelines ?? []).join('\n').includes('web_search is unavailable'));
});

test('native PROVIDER_UNSUPPORTED says what was unexpected and how to switch', () => {
  for (const fn of [() => injectNativeSearch({ tools: 'bad' }), () => injectGeminiSearch({ config: { tools: 'bad' } }), () => injectAnthropicSearch({ tools: 'bad' })]) {
    const m = message(fn);
    assert.match(m, /PROVIDER_UNSUPPORTED:.*expected an array/); assert.match(m, /skipped/); assert.match(m, /brave.*exa.*deepseek/s); agentSafe(m);
  }
});
