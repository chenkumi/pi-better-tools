import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * Bounded transport for the browser path. Playwright's `route.fetch()` buffers and decompresses the
 * whole body in the host process with no byte cap, so a small gzip body can expand to hundreds of
 * MiB before any size check runs. Here every response is read through a wire-size limit, the
 * decoder and a decoded-size limit, so reading stops as soon as a limit is crossed.
 */

/** Per-fetch allowance shared by all subresource responses (request count and decoded bytes). */
export class ResponseBudget {
  requests = 0;
  bytes = 0;
  constructor(readonly maxRequests: number, readonly maxBytes: number) {}
  admit(): void {
    if (++this.requests > this.maxRequests) throw new Error('TOO_LARGE: Too many subresource requests for one page.');
  }
  take(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.maxBytes) throw new Error('TOO_LARGE: Subresources exceed the cumulative size budget.');
  }
}

export type BoundedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
};

export type BoundedResponse = {
  status: number;
  /** Lower-cased names; repeated headers joined with ", " (set-cookie with "\n"). */
  headers: Record<string, string>;
  setCookies: string[];
  /** Actual remote address of the connected socket. */
  remoteAddress: string | undefined;
  /** Read the (decoded) body, failing with TOO_LARGE as soon as `limit` is crossed. */
  readBody(limit: number, budget?: ResponseBudget): Promise<Buffer>;
  dispose(): Promise<void>;
};

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade', 'accept-encoding']);

function reasonOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('CANCELLED: Fetch was cancelled.');
}

function limiter(limit: number, message: string, onChunk?: (bytes: number) => void): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    try { onChunk?.(chunk.length); } catch (error) { done(error as Error); return; }
    done(bytes > limit ? new Error(message) : null, chunk);
  } });
}

export async function requestBounded(input: BoundedRequest): Promise<BoundedResponse> {
  const { signal } = input;
  if (signal.aborted) throw reasonOf(signal);
  const url = new URL(input.url);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  // identity alone would not help (a server may ignore it); decoding below is bounded either way.
  headers['accept-encoding'] = 'gzip, deflate, br';
  const request = (url.protocol === 'https:' ? https : http).request(url, { agent: false, signal, method: input.method, headers, rejectUnauthorized: true });
  const closed = new Promise<void>((resolve) => { request.once('close', resolve); });
  const destroy = async () => { request.destroy(); await closed; };
  let incoming: IncomingMessage;
  try {
    incoming = await new Promise<IncomingMessage>((resolve, reject) => {
      let pending = true;
      const settle = (error?: Error, value?: IncomingMessage) => {
        if (!pending) return;
        pending = false;
        signal.removeEventListener('abort', onCancel);
        request.off('upgrade', onUpgrade);
        request.off('close', onClose);
        if (error) reject(error); else resolve(value!);
      };
      const onCancel = () => settle(reasonOf(signal));
      // A 101 Upgrade emits neither 'response' nor 'error'; destroy the detached socket explicitly.
      const onUpgrade = (_response: IncomingMessage, socket: Duplex) => {
        socket.destroy();
        settle(new Error('UNSUPPORTED_CONTENT: The server switched to another protocol (HTTP 101 Upgrade).'));
      };
      const onClose = () => settle(new Error('NETWORK_ERROR: The connection closed before any response.'));
      request.once('response', (value: IncomingMessage) => settle(undefined, value));
      request.once('upgrade', onUpgrade);
      request.once('close', onClose);
      signal.addEventListener('abort', onCancel, { once: true });
      // Stays attached so a late socket error is never unhandled.
      request.on('error', (error: Error) => settle(error));
      request.end(input.body && input.body.byteLength ? input.body : undefined);
    });
  } catch (error) {
    await destroy();
    if (signal.aborted) throw reasonOf(signal);
    throw error;
  }
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (name === 'set-cookie') continue;
    if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const setCookies = incoming.headers['set-cookie'] ?? [];
  if (setCookies.length) flat['set-cookie'] = setCookies.join('\n');
  let reading = false;
  return {
    status: incoming.statusCode ?? 0,
    headers: flat,
    setCookies,
    remoteAddress: incoming.socket?.remoteAddress,
    async readBody(limit, budget) {
      if (reading) throw new Error('NETWORK_ERROR: Response body was already consumed.');
      reading = true;
      const encoding = (flat['content-encoding'] ?? 'identity').trim().toLowerCase();
      const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
        : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      if (!decoder && encoding !== 'identity' && encoding !== '') throw new Error('UNSUPPORTED_CONTENT: Unsupported HTTP content encoding.');
      const declared = Number(flat['content-length']);
      if (Number.isFinite(declared) && declared > limit) throw new Error('TOO_LARGE: Response exceeds the size limit.');
      const chunks: Buffer[] = [];
      const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
      const message = 'TOO_LARGE: Response exceeds the size limit.';
      const wire = limiter(limit, message);
      const decoded = limiter(limit, message, budget ? (bytes) => budget.take(bytes) : undefined);
      try {
        if (decoder) await pipeline(incoming, wire, decoder, decoded, sink, { signal });
        else await pipeline(incoming, wire, decoded, sink, { signal });
      } catch (error) {
        if (signal.aborted) throw reasonOf(signal);
        if (error instanceof Error && /^(TOO_LARGE|UNSUPPORTED_CONTENT):/.test(error.message)) throw error;
        throw new Error('NETWORK_ERROR: Could not read the response body.');
      }
      return Buffer.concat(chunks);
    },
    async dispose() { incoming.destroy(); await destroy(); },
  };
}

/** Minimal Set-Cookie parser (best effort) for cookies sent on redirect hops. */
export function parseSetCookie(value: string, requestUrl: string): { name: string; value: string; domain?: string; path: string; expires?: number; httpOnly: boolean; secure: boolean; sameSite?: 'Strict' | 'Lax' | 'None' } | undefined {
  const [pair, ...attributes] = value.split(';');
  const eq = pair!.indexOf('=');
  if (eq <= 0) return undefined;
  const url = new URL(requestUrl);
  const cookie: NonNullable<ReturnType<typeof parseSetCookie>> = { name: pair!.slice(0, eq).trim(), value: pair!.slice(eq + 1).trim(), domain: url.hostname, path: '/', httpOnly: false, secure: false };
  if (!cookie.name) return undefined;
  const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
  cookie.path = defaultPath;
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const val = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (key === 'path' && val.startsWith('/')) cookie.path = val;
    else if (key === 'domain' && val) {
      const domain = val.replace(/^\./, '').toLowerCase();
      // Reject cookies for other sites; Playwright treats a leading dot as a domain cookie.
      if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) cookie.domain = `.${domain}`;
      else return undefined;
    } else if (key === 'expires') { const time = Date.parse(val); if (Number.isFinite(time)) cookie.expires = Math.floor(time / 1000); }
    else if (key === 'max-age') { const seconds = Number(val); if (Number.isFinite(seconds)) maxAge = seconds; }
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') { const lower = val.toLowerCase(); cookie.sameSite = lower === 'strict' ? 'Strict' : lower === 'none' ? 'None' : 'Lax'; }
  }
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 1 : Math.floor(Date.now() / 1000) + maxAge;
  return cookie;
}
