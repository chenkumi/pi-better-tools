import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { awaitResponse } from './bounded.js';
import { MAX_HTML_BYTES } from './extract.js';
import { NetworkPolicy } from './network.js';

/** Media types accepted as a page document, by both the static and the browser path. */
export const DOCUMENT_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

/** Keep the URL hostname (Host and TLS identity), but never perform a second DNS lookup. */
export function pinnedOptions(url: URL, address: string, signal: AbortSignal): RequestOptions & { rejectUnauthorized: boolean; autoSelectFamily: boolean } {
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    agent: false, signal, method: 'GET', autoSelectFamily: false,
    rejectUnauthorized: true,
    headers: { accept: DOCUMENT_CONTENT_TYPES.join(', '), 'accept-encoding': 'gzip, deflate, br' },
    lookup: (_host, options, callback) => {
      const family = isIP(address);
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
  };
}

function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }
function cancelReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('CANCELLED: Static HTTP request was cancelled.');
}
async function resolveAbortable(policy: NetworkPolicy, value: string, signal: AbortSignal) {
  aborted(signal);
  return new Promise<Awaited<ReturnType<NetworkPolicy['resolveTarget']>>>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    policy.resolveTarget(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

function byteLimit(limit: number): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    done(bytes > limit ? new Error('TOO_LARGE: HTTP response exceeds the static content limit.') : null, chunk);
  } });
}

/** Decode BOM first, then HTTP charset, then HTML's early charset declaration. */
export function decodeDocument(body: Buffer, contentType: string): string {
  contentType = contentType.trim();
  let encoding: string | undefined;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) encoding = 'utf-8';
  else if (body[0] === 0xff && body[1] === 0xfe) encoding = 'utf-16le';
  else if (body[0] === 0xfe && body[1] === 0xff) encoding = 'utf-16be';
  const charset = /charset\s*=\s*["']?([^\s;"'/>]+)/i;
  encoding ??= charset.exec(contentType)?.[1];
  if (!encoding && !/^text\/plain\b/i.test(contentType)) {
    const metas = body.subarray(0, 1024).toString('latin1').match(/<meta\s[^>]*>/gi) ?? [];
    encoding = metas.map((meta) => charset.exec(meta)?.[1]).find(Boolean);
  }
  let text: string;
  try { text = new TextDecoder(encoding ?? 'utf-8').decode(body); }
  catch { throw new Error('UNSUPPORTED_CONTENT: Unsupported document charset.'); }
  if (/^text\/plain\b/i.test(contentType)) {
    text = '<!doctype html><html><body><main><pre>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre></main></body></html>';
  }
  if (Buffer.byteLength(text) > MAX_HTML_BYTES) throw new Error('TOO_LARGE: Decoded HTML exceeds the 5 MiB limit.');
  return text;
}

async function readDocument(response: IncomingMessage, signal: AbortSignal): Promise<string> {
  const type = response.headers['content-type'] ?? '';
  if (/\battachment\b/i.test(response.headers['content-disposition'] ?? '') ||
      !DOCUMENT_CONTENT_TYPES.includes(type.split(';')[0]!.trim().toLowerCase())) {
    throw new Error('UNSUPPORTED_CONTENT: Only HTML and plain text pages are supported; find an HTML version instead.');
  }
  if (Number(response.headers['content-length']) > MAX_HTML_BYTES) throw new Error('TOO_LARGE: HTTP response exceeds the 5 MiB limit.');
  const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  if (!decoder && encoding !== 'identity') throw new Error('UNSUPPORTED_CONTENT: Unsupported HTTP content encoding.');
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  const wireLimit = byteLimit(MAX_HTML_BYTES);
  const decodedLimit = byteLimit(MAX_HTML_BYTES);
  if (decoder) await pipeline(response, wireLimit, decoder, decodedLimit, sink, { signal });
  else await pipeline(response, wireLimit, decodedLimit, sink, { signal });
  return decodeDocument(Buffer.concat(chunks), type);
}

/** No cookies, auth, subresources, script/meta navigation, retry, proxy or shared connection pool. */
export async function fetchStatic(value: string, policy: NetworkPolicy, signal: AbortSignal): Promise<{ html: string; finalUrl: string; status: number }> {
  try {
    let target = value;
    for (let hop = 0; hop < 20; hop++) {
      const { url, address } = await resolveAbortable(policy, target, signal);
      aborted(signal);
      const request = (url.protocol === 'https:' ? https : http).request(url, pinnedOptions(url, address, signal));
      try {
        const response = await awaitResponse(request, signal, cancelReason,
          'UNSUPPORTED_CONTENT: The server switched to another protocol (HTTP 101 Upgrade), which static HTTP mode does not support. Look for an HTML version instead.');
        try {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            try { target = new URL(response.headers.location, url).href; }
            catch { throw new Error('INVALID_URL: Invalid redirect destination.'); }
            continue;
          }
          if (status < 200 || status >= 300 || status === 204 || status === 205) throw new Error(`HTTP_ERROR: Page returned no successful document (HTTP ${status}).`);
          const html = await readDocument(response, signal);
          aborted(signal);
          return { html, finalUrl: url.href, status };
        } finally { response.destroy(); }
      } finally {
        // Release the shared operation/queue only after the local request actually closes.
        const closed = new Promise<void>(resolve => {
          if (request.closed) resolve(); else request.once('close', resolve);
        });
        request.destroy();
        await closed;
      }
    }
    throw new Error('NETWORK_ERROR: Too many redirects.');
  } catch (error) {
    aborted(signal);
    if (error instanceof Error && /^(NETWORK_BLOCKED|NETWORK_ERROR|INVALID_URL|HTTP_ERROR|UNSUPPORTED_CONTENT|TOO_LARGE):/.test(error.message)) throw error;
    throw new Error('NETWORK_ERROR: Static HTTP request failed (check TLS, connectivity and server response).');
  }
}
