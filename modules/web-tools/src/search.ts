import type { Config } from './config.ts';
import { resolveKey } from './config.ts';
import { describeNetworkFailure } from './fetch/failure.ts';
import { isRecord as record } from './record.ts';

export interface SearchResult { title: string; url: string; snippet?: string; publishedAt?: string }
export const REST_PROVIDERS = ['brave', 'exa', 'deepseek'] as const;
export type RestProvider = (typeof REST_PROVIDERS)[number];
export const isRestProvider = (provider: string): provider is RestProvider => (REST_PROVIDERS as readonly string[]).includes(provider);
/** Input bounds shared by the web_search schema and the runtime check below. */
export const MAX_QUERY_CHARS = 2000;
export const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET_CHARS = 1500;
const MAX_TITLE_CHARS = 300;
const MAX_PUBLISHED_CHARS = 100;
export interface SearchResponse { provider: RestProvider; query: string; results: SearchResult[]; warnings: string[] }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** Reads a credential from Pi's stored provider login; only DeepSeek has one of the search providers. */
export type PiCredentialResolver = (provider: 'deepseek') => Promise<string | undefined>;
class SearchError extends Error {}
/** Provider returned something unusable: say so, and what the agent can do instead. Never includes payload content. */
const malformed = (what: string) => new SearchError(`UPSTREAM_ERROR: ${what}. The provider returned malformed data; retry once later, or use web_fetch on a known URL instead.`);
const KEY_SOURCE: Record<RestProvider, string> = {
  brave: 'ask the user to check the brave search service API key in the web tools configuration', exa: 'ask the user to check the exa search service API key in the web tools configuration',
  deepseek: 'ask the user to run /login for DeepSeek or check the deepseek search service API key in the web tools configuration',
};
/** Linear tag removal, bounded retained output. Unclosed '<' stays literal,
 * matching the old replacement semantics without retrying every '<' suffix. */
export function cleanSearchField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const output: string[] = [];
  let unclosed = false;
  for (let index = 0; index < value.length && output.length < max; index++) {
    const char = value.charAt(index);
    if (char === '<' && !unclosed) {
      const end = value.indexOf('>', index + 1);
      if (end >= 0) { index = end; continue; }
      unclosed = true;
    }
    const code = value.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) continue;
    output.push(char);
  }
  return output.join('');
}
const clean = cleanSearchField;
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw malformed('empty search response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SEARCH_RESPONSE_BYTES) throw malformed('search response too large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw malformed('invalid search JSON'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const SEARCH_ENDPOINTS = { brave: 'https://api.search.brave.com/res/v1/web/search', exa: 'https://api.exa.ai/search', deepseek: 'https://api.deepseek.com/v1/tools/search' } as const;
/** An explicit config credential wins; DeepSeek otherwise reuses Pi's provider login. */
async function resolveSearchKey(config: Config, provider: RestProvider, piCredential?: PiCredentialResolver): Promise<string> {
  const credential = config.providers[provider];
  if (credential.apiKey || credential.apiKeyEnv) return resolveKey(credential, process.env, provider);
  const fromPi = provider === 'deepseek' ? await piCredential?.('deepseek') : undefined;
  if (fromPi?.trim()) return fromPi.trim();
  // Brave/Exa have no Pi login provider, so resolveKey reports their existing AUTH_REQUIRED message.
  if (provider === 'deepseek') throw new Error('AUTH_REQUIRED: no DeepSeek credential; ask the user to run /login for DeepSeek or set a DeepSeek search service API key in the web tools configuration, then run /reload.');
  return resolveKey(credential, process.env, provider);
}
function sendSearchRequest(provider: RestProvider, query: string, limit: number, key: string, signal: AbortSignal, http: FetchLike): Promise<Response> {
  if (provider === 'brave') {
    const url = new URL(SEARCH_ENDPOINTS.brave);
    url.search = new URLSearchParams({ q: query, count: String(limit), extra_snippets: 'true' }).toString();
    return http(url.href, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal, redirect: 'error' });
  }
  if (provider === 'exa') {
    return http(SEARCH_ENDPOINTS.exa, {
      method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, numResults: limit, type: 'auto', contents: { highlights: { maxCharacters: MAX_SNIPPET_CHARS } } }),
      signal, redirect: 'error',
    });
  }
  return http(SEARCH_ENDPOINTS.deepseek, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, count: limit }), signal, redirect: 'error',
  });
}
function assertSearchStatus(provider: RestProvider, response: Response): void {
  if (response.status === 401 || response.status === 403) throw new SearchError(`AUTH_REQUIRED: ${provider} rejected the credential or its permissions (HTTP ${response.status}); ${KEY_SOURCE[provider]} and the account plan/permissions, then /reload.`);
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    const wait = retry && /^\d{1,6}$/.test(retry) ? `${retry} seconds` : 'about 60 seconds';
    throw new SearchError(`RATE_LIMITED: ${provider} rate limit or quota reached; wait ${wait} before retrying, and reduce the number of searches.`);
  }
  if (!response.ok) {
    const advice = response.status >= 500 ? 'a provider-side failure; retry later' : 'the request was rejected; try a shorter or simpler query, or check the provider plan/quota';
    throw new SearchError(`UPSTREAM_ERROR: ${provider} HTTP ${response.status}: ${advice}.`);
  }
}
/** The provider-specific result array, after validating the payload shape. */
function rawSearchItems(provider: RestProvider, payload: unknown): unknown[] {
  if (!record(payload)) throw malformed('invalid search response shape');
  if (provider === 'brave' && payload.web !== undefined && !record(payload.web)) throw malformed('invalid Brave web section');
  const raw = provider === 'brave' ? (record(payload.web) ? payload.web.results : undefined) : payload.results;
  // Brave may omit the web section for a legitimate empty result set.
  if (raw !== undefined && !Array.isArray(raw)) throw malformed('invalid results shape');
  if (provider === 'exa' && !Array.isArray(raw)) throw malformed('missing Exa results');
  if (provider === 'deepseek' && !Array.isArray(raw)) throw malformed('missing DeepSeek results');
  return (raw ?? []) as unknown[];
}
/** Keeps up to `limit` unique public HTTP(S) results; counts entries that are not usable sources. */
function collectResults(provider: RestProvider, items: unknown[], limit: number): { results: SearchResult[]; invalid: number } {
  const results: SearchResult[] = [], seen = new Set<string>();
  let invalid = 0;
  for (const item of items) {
    if (!record(item) || typeof item.url !== 'string') { invalid++; continue; }
    let url: URL;
    try { url = new URL(item.url); } catch { invalid++; continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { invalid++; continue; }
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const snippet = provider === 'brave' ? clean(item.description, MAX_SNIPPET_CHARS) : provider === 'exa' ?
      clean(Array.isArray(item.highlights) ? item.highlights.filter(v => typeof v === 'string').join('\n') : undefined, MAX_SNIPPET_CHARS) :
      clean(item.snippet, MAX_SNIPPET_CHARS) ?? clean(item.summary, MAX_SNIPPET_CHARS);
    const published = provider === 'deepseek' ? item.date : item.publishedDate;
    results.push({ title: clean(item.title, MAX_TITLE_CHARS) || url.hostname, url: url.href, ...(snippet ? { snippet } : {}),
      ...(typeof published === 'string' ? { publishedAt: clean(published, MAX_PUBLISHED_CHARS) } : {}) });
    if (results.length === limit) break;
  }
  return { results, invalid };
}
export async function search(
  config: Config, input: { query: string; numResults?: number },
  signal?: AbortSignal, http: FetchLike = fetch, piCredential?: PiCredentialResolver,
): Promise<SearchResponse> {
  if (!config.enabled) throw new Error('CONFIG_INVALID: search is disabled in the web tools configuration; ask the user to enable it and run /reload.');
  // The configured provider is authoritative; the model cannot choose one.
  const provider = config.provider;
  if (!isRestProvider(provider)) throw new Error(`PROVIDER_UNSUPPORTED: provider "${provider}" uses the model's native hosted search, not this tool; to use web_search, ask the user to switch the web search service to brave, exa or deepseek in the web tools configuration and run /reload.`);
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > MAX_QUERY_CHARS) {
    const received = typeof input.query === 'string' ? `${input.query.length} characters${input.query.trim() ? '' : ', blank'}` : typeof input.query;
    throw new Error(`INVALID_INPUT: parameter \`query\` must be 1 to ${MAX_QUERY_CHARS} non-blank characters (received ${received}). Provide concise search keywords.`);
  }
  const limit = input.numResults ?? config.numResults;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw new Error(`INVALID_INPUT: parameter \`numResults\` must be an integer from 1 to ${MAX_SEARCH_RESULTS} (received ${typeof limit === 'number' ? limit : typeof limit}). Omit it to use the configured default.`);
  const key = await resolveSearchKey(config, provider, piCredential);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searchTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let response: Response | undefined;
  try {
    combined.throwIfAborted();
    const query = input.query.trim();
    response = await sendSearchRequest(provider, query, limit, key, combined, http);
    assertSearchStatus(provider, response);
    const payload = await readJson(response);
    combined.throwIfAborted();
    const { results, invalid } = collectResults(provider, rawSearchItems(provider, payload), limit);
    combined.throwIfAborted();
    return { provider, query, results, warnings: invalid ? [`Discarded ${invalid} invalid source entries.`] : [] };
  } catch (e) {
    if (signal?.aborted) throw new Error('CANCELLED: search cancelled');
    if (controller.signal.aborted) throw new Error(`TIMEOUT: ${provider} search exceeded the ${config.searchTimeoutMs} ms deadline (searchTimeoutMs); retry, or simplify the query.`);
    // Only our fixed error messages escape. Never serialize upstream error bodies, headers or request objects.
    if (e instanceof SearchError && !(key && e.message.includes(key))) throw e;
    throw new Error(`UPSTREAM_ERROR: ${provider} request failed: ${describeNetworkFailure(e)}. Retry later; if it persists, check connectivity or use web_fetch on a known URL.`);
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => {});
  }
}
