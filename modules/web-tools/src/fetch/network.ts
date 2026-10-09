import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type AddressResolver = (hostname: string) => Promise<readonly { address: string }[]>;

/** Defense in depth, NOT a sandbox: the pre-flight lookup and the real connection resolve independently
 * (DNS rebinding), so the connected peer address is re-checked after the fact (see assertConnectedAddress),
 * but the request itself may already have been sent. Browser background traffic and non-HTTP transports
 * require OS/network isolation. */
export function isPublicAddress(address: string): boolean {
  try {
    if (address.includes('%')) return false;
    const parsed = ipaddr.process(address);
    // ipaddr classifies loopback, private, link-local, multicast, documentation,
    // transition and reserved ranges separately from ordinary unicast.
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv6') {
      // Fail closed outside currently allocated IPv6 global unicast space.
      const bytes = parsed.toByteArray();
      return (bytes[0]! & 0xe0) === 0x20;
    }
    return true;
  } catch {
    return false;
  }
}

export function parseWebUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_URL: Provide an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('INVALID_URL: Only HTTP(S) URLs are supported.');
  }
  if (url.username || url.password) throw new Error('INVALID_URL: URL credentials are not allowed.');
  return url;
}

/** Per-fetch memo of hostname checks so one page's subresources resolve each host once. */
export type ValidationCache = Map<string, Promise<void>>;

export class NetworkPolicy {
  constructor(
    private readonly allowPrivateNetwork = false,
    private readonly resolve: AddressResolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  ) {}

  /** Reject a connection whose actual remote address (Playwright `serverAddr()`) is not public.
   * A missing address fails closed: it cannot be shown to be public. */
  assertConnectedAddress(address: string | undefined): void {
    if (this.allowPrivateNetwork) return;
    if (!address || !isPublicAddress(address)) {
      throw new Error('NETWORK_BLOCKED: The connection reached a non-public address. Private and local addresses cannot be fetched; use a public URL.');
    }
  }

  async validate(value: string, cache?: ValidationCache): Promise<URL> {
    const url = parseWebUrl(value);
    if (this.allowPrivateNetwork) return url;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('NETWORK_BLOCKED: Local network destinations are not allowed. Private and local addresses cannot be fetched; use a public URL.');
    }
    if (ipaddr.isValid(hostname)) {
      if (!isPublicAddress(hostname)) throw new Error('NETWORK_BLOCKED: Non-public addresses are not allowed. Private and local addresses cannot be fetched; use a public URL.');
      return url;
    }
    let check = cache?.get(hostname);
    if (!check) {
      check = this.checkResolved(hostname);
      cache?.set(hostname, check);
    }
    await check;
    return url;
  }

  private async checkResolved(hostname: string): Promise<void> {
    let addresses: readonly { address: string }[];
    try { addresses = await this.resolve(hostname); } catch {
      throw new Error('NETWORK_ERROR: Could not resolve the destination.');
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error('NETWORK_BLOCKED: Every resolved address must be public. Private and local addresses cannot be fetched; use a public URL.');
    }
  }
}
