import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ClientOptions } from 'ws';
import { isPublicAddress } from '../../web-tools/src/fetch/network.js';
export interface Endpoint { url: URL; hostname: string; addresses: readonly { address: string; family: number }[] }
export interface NetworkSource { url: string; allowPrivateNetwork?: boolean; allowInsecure?: boolean }
export function parseEndpoint(source: NetworkSource) {
  if (typeof source.url !== 'string' || source.url.length > 8192 || Buffer.byteLength(source.url) > 8192) throw new Error('INVALID_URL');
  let url: URL; try { url = new URL(source.url); } catch { throw new Error('INVALID_URL'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || (url.port && (+url.port < 1 || +url.port > 65535))) throw new Error('INVALID_URL: only ws/wss without userinfo');
  if (url.protocol === 'ws:' && source.allowInsecure !== true) throw new Error('ws requires explicit allowInsecure:true');
  url.hash = ''; return url;
}
export async function prepareEndpoint(source: NetworkSource, resolve: (host: string) => Promise<readonly { address: string; family: number }[]> = host => lookup(host, { all: true, verbatim: true })): Promise<Endpoint> {
  const url = parseEndpoint(source), hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (source.allowPrivateNetwork !== true && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) throw new Error('NETWORK_BLOCKED');
  let addresses: readonly { address: string; family: number }[];
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname); } catch { throw new Error('NETWORK_ERROR: DNS resolution failed'); }
  if (!addresses.length || addresses.length > 64 || addresses.some(a => !isIP(a.address) || isIP(a.address) !== a.family || (source.allowPrivateNetwork !== true && !isPublicAddress(a.address)))) throw new Error('NETWORK_BLOCKED: every resolved address must be authorized');
  return Object.freeze({ url, hostname, addresses: Object.freeze(addresses.map(a => Object.freeze({ ...a }))) });
}
export type PinnedOptions = ClientOptions & { lookup: (hostname: string, options: any, callback: any) => void; servername?: string };
export function pinnedOptions(endpoint: Endpoint, timeout: number): PinnedOptions {
  const selected = endpoint.addresses[0]!;
  return { agent: false, family: selected.family, autoSelectFamily: false,
    lookup: ((hostname: string, options: any, callback: any) => {
      if (hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase() !== endpoint.hostname) { callback(new Error('Unvalidated DNS lookup denied')); return; }
      const addresses = endpoint.addresses.filter(a => !options?.family || a.family === options.family);
      if (!addresses.length) { callback(new Error('No validated address for requested family')); return; }
      // No second resolver call: actual transport uses exactly this verified set.
      if (options?.all) callback(null, addresses.map(a => ({ ...a })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }),
    ...(endpoint.url.protocol === 'wss:' && !isIP(endpoint.hostname) ? { servername: endpoint.hostname } : {}),
    rejectUnauthorized: true, followRedirects: false, perMessageDeflate: false, maxPayload: 16384,
    maxFragments: 128, maxBufferedChunks: 128, skipUTF8Validation: false, handshakeTimeout: Math.max(1, Math.min(15000, timeout)), closeTimeout: 1000,
  } as unknown as PinnedOptions; // ws@8.22.0 forwards Node request/lookup options; @types/ws omits them.
}
