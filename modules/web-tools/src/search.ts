import type { Config } from './config.ts';
import { resolveKey } from './config.ts';

export interface SearchResult { title: string; url: string; snippet?: string; publishedAt?: string }
export interface SearchResponse { provider: 'brave' | 'exa'; query: string; results: SearchResult[]; warnings: string[] }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
class SearchError extends Error {}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : undefined;
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SearchError('UPSTREAM_ERROR: empty search response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new SearchError('UPSTREAM_ERROR: search response too large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SearchError('UPSTREAM_ERROR: invalid search JSON'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function search(
  config: Config, input: { query: string; provider?: 'brave' | 'exa'; numResults?: number },
  signal?: AbortSignal, http: FetchLike = fetch,
): Promise<SearchResponse> {
  if (!config.enabled) throw new Error('CONFIG_INVALID: search is disabled');
  const provider = input.provider ?? config.provider;
  if (provider !== 'brave' && provider !== 'exa') throw new Error('PROVIDER_UNSUPPORTED: OpenAI uses native search, not this tool');
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000) throw new Error('CONFIG_INVALID: query must contain 1–2000 characters');
  const limit = input.numResults ?? config.numResults;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('CONFIG_INVALID: numResults must be 1–10');
  const key = resolveKey(config.providers[provider]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searchTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let response: Response | undefined;
  try {
    combined.throwIfAborted();
    const query = input.query.trim();
    if (provider === 'brave') {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.search = new URLSearchParams({ q: query, count: String(limit), extra_snippets: 'true' }).toString();
      response = await http(url.href, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: combined, redirect: 'error' });
    } else {
      response = await http('https://api.exa.ai/search', {
        method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, numResults: limit, type: 'auto', contents: { highlights: { maxCharacters: 1500 } } }),
        signal: combined, redirect: 'error',
      });
    }
    if (response.status === 401 || response.status === 403) throw new SearchError(`AUTH_REQUIRED: ${provider} rejected the credential or its permissions`);
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const safeRetry = retry && /^\d{1,6}$/.test(retry) ? `; retry after ${retry} seconds` : '';
      throw new SearchError(`RATE_LIMITED: ${provider}${safeRetry}`);
    }
    if (!response.ok) throw new SearchError(`UPSTREAM_ERROR: ${provider} HTTP ${response.status}`);
    const payload = await readJson(response);
    if (!record(payload)) throw new SearchError('UPSTREAM_ERROR: invalid search response shape');
    if (provider === 'brave' && payload.web !== undefined && !record(payload.web)) throw new SearchError('UPSTREAM_ERROR: invalid Brave web section');
    const raw = provider === 'brave' ? (record(payload.web) ? payload.web.results : undefined) : payload.results;
    // Brave may omit the web section for a legitimate empty result set.
    if (raw !== undefined && !Array.isArray(raw)) throw new SearchError('UPSTREAM_ERROR: invalid results shape');
    if (provider === 'exa' && !Array.isArray(raw)) throw new SearchError('UPSTREAM_ERROR: missing Exa results');
    const results: SearchResult[] = [], seen = new Set<string>();
    let invalid = 0;
    for (const item of (raw ?? []) as unknown[]) {
      if (!record(item) || typeof item.url !== 'string') { invalid++; continue; }
      let url: URL;
      try { url = new URL(item.url); } catch { invalid++; continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { invalid++; continue; }
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const snippet = provider === 'brave' ? clean(item.description, 1500) :
        clean(Array.isArray(item.highlights) ? item.highlights.filter(v => typeof v === 'string').join('\n') : undefined, 1500);
      results.push({ title: clean(item.title, 300) || url.hostname, url: url.href, ...(snippet ? { snippet } : {}),
        ...(typeof item.publishedDate === 'string' ? { publishedAt: clean(item.publishedDate, 100) } : {}) });
      if (results.length === limit) break;
    }
    return { provider, query, results, warnings: invalid ? [`Discarded ${invalid} invalid source entries.`] : [] };
  } catch (e) {
    if (signal?.aborted) throw new Error('CANCELLED: search cancelled');
    if (controller.signal.aborted) throw new Error('TIMEOUT: search deadline exceeded');
    // Only our fixed error messages escape. Never serialize upstream error bodies, headers or request objects.
    if (e instanceof SearchError && !e.message.includes(key)) throw e;
    throw new Error(`UPSTREAM_ERROR: ${provider} request failed`);
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => {});
  }
}
