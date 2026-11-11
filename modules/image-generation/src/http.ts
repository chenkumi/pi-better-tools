import { ToolError } from '../../../shared/src/tool-error/index.ts';
import { clean } from './text.ts';

export interface HttpOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  /** The response body is counted while it streams and the request is stopped past this size. */
  maxBytes: number;
  fetchImpl?: typeof fetch;
}
export interface HttpResult { status: number; json?: unknown; text: string; requestId?: string }

/**
 * One POST with a JSON body. Fixed endpoint chosen by the caller (never user-provided), no redirects, an absolute timer,
 * a bounded response. It never retries: a paid request that timed out or failed with a 5xx may still have been processed.
 */
export async function postJson(options: HttpOptions): Promise<HttpResult> {
  const timer = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
  const stopped = (): ToolError => options.signal?.aborted
    ? new ToolError('IMAGE_CANCELLED', 'The request was cancelled. The provider may still have processed it.')
    : new ToolError('IMAGE_TIMEOUT', `No complete response within ${Math.round(options.timeoutMs / 1000)} s. The provider may still have processed (and billed) the request; it was not retried.`);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.url, { method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(options.body) });
  } catch (error) {
    if (signal.aborted) throw stopped();
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    throw new ToolError('IMAGE_NETWORK', `The request could not be sent${typeof code === 'string' ? ` (${clean(code, 40)})` : ''}.`);
  }
  if (response.status >= 300 && response.status < 400) throw new ToolError('IMAGE_NETWORK', `The server answered with a redirect (HTTP ${response.status}); redirects are not followed.`);
  const requestId = clean(response.headers.get('x-request-id') ?? response.headers.get('x-goog-request-id') ?? '', 100) || undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      size += next.value.byteLength;
      if (size > options.maxBytes) {
        await reader!.cancel().catch(() => undefined);
        throw new ToolError('IMAGE_RESPONSE_TOO_LARGE', `The response is larger than ${Math.round(options.maxBytes / 1048576)} MiB and was dropped.`);
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (signal.aborted) throw stopped();
    throw new ToolError('IMAGE_NETWORK', 'The response was interrupted.');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, ...(json !== undefined ? { json } : {}), text, ...(requestId ? { requestId } : {}) };
}

/** Maps a non-2xx answer to a coded failure. Only the provider's message (bounded and cleaned) is shown; never request headers. */
export function providerError(label: string, result: HttpResult): ToolError {
  const root = result.json && typeof result.json === 'object' ? (result.json as Record<string, unknown>) : {};
  const err = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : {};
  const providerCode = clean(err.code ?? err.status, 60), param = clean(err.param, 60);
  const message = clean(err.message ?? (typeof root.error === 'string' ? root.error : result.text), 300) || 'no message';
  const detail = `${label} returned HTTP ${result.status}${providerCode || param ? ` (${[providerCode, param].filter(Boolean).join(', ')})` : ''}: ${message}${result.requestId ? ` [request ${result.requestId}]` : ''}`;
  const status = result.status;
  if (status === 401 || status === 403) return new ToolError('IMAGE_AUTH_FAILED', `${detail}. Check the ${label} login in Pi (/login).`);
  if (status === 429) return new ToolError('IMAGE_RATE_LIMITED', `${detail}. It was not retried.`);
  if (/moderation|safety|blocked/i.test(providerCode)) return new ToolError('IMAGE_BLOCKED', detail);
  if (status >= 500) return new ToolError('IMAGE_PROVIDER_ERROR', `${detail}. The request may have been processed and billed; it was not retried.`);
  if (status === 400 || status === 404 || status === 422) return new ToolError('IMAGE_REQUEST_REJECTED', detail);
  return new ToolError('IMAGE_PROVIDER_ERROR', detail);
}
