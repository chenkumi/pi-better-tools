import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ClientOptions } from 'ws';
import { isPublicAddress } from '../../web-tools/src/fetch/network.js';
export interface Endpoint { url: URL; hostname: string; addresses: readonly { address: string; family: number }[] }
export interface NetworkSource { url: string; allowPrivateNetwork?: boolean; allowInsecure?: boolean }
const FORM = 'use ws:// or wss://host[:port]/path without userinfo';
const invalidUrl = (rule: string) => new Error(`INVALID_URL: websocket source "url" ${rule}`);
/** Messages never echo the URL (it may carry credentials in the query) or a resolved address. */
export function parseEndpoint(source: NetworkSource) {
  if (typeof source.url !== 'string') throw invalidUrl(`must be a string; ${FORM}`);
  if (source.url.length > 8192 || Buffer.byteLength(source.url) > 8192) throw invalidUrl(`is ${Buffer.byteLength(source.url)} bytes, over the 8192 limit; shorten it`);
  let url: URL; try { url = new URL(source.url); } catch { throw invalidUrl(`is not an absolute URL; ${FORM}`); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw invalidUrl(`scheme "${url.protocol.slice(0, 20)}" is unsupported; ${FORM}`);
  if (!url.hostname) throw invalidUrl(`has no host; ${FORM}`);
  if (url.username || url.password) throw invalidUrl('must not contain userinfo; remove user:password@ from the URL');
  if (url.port && (+url.port < 1 || +url.port > 65535)) throw invalidUrl('port must be 1-65535');
  if (url.protocol === 'ws:' && source.allowInsecure !== true) throw new Error('websocket source "allowInsecure" must be true for plain ws:// (unencrypted); set allowInsecure:true or use wss://');
  url.hash = ''; return url;
}
export async function prepareEndpoint(source: NetworkSource, resolve: (host: string) => Promise<readonly { address: string; family: number }[]> = host => lookup(host, { all: true, verbatim: true })): Promise<Endpoint> {
  const url = parseEndpoint(source), hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (source.allowPrivateNetwork !== true && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) throw new Error(`NETWORK_BLOCKED: websocket source "url" host "${hostname.slice(0, 100)}" is local; set allowPrivateNetwork:true to opt in`);
  let addresses: readonly { address: string; family: number }[];
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname); } catch { throw new Error(`NETWORK_ERROR: DNS resolution failed for host "${hostname.slice(0, 100)}"; check the host name spelling and network access`); }
  if (!addresses.length || addresses.length > 64 || addresses.some(a => !isIP(a.address) || isIP(a.address) !== a.family || (source.allowPrivateNetwork !== true && !isPublicAddress(a.address)))) throw new Error(`NETWORK_BLOCKED: websocket source "url" host "${hostname.slice(0, 100)}" resolves to a private, loopback or otherwise non-public address (or to an empty or invalid set); set allowPrivateNetwork:true to opt in`);
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
