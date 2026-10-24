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
  try { url = new URL(value); } catch {
    // Echo a short, control-free prefix to help the caller spot the typo; skip it when the text may carry credentials.
    const shown = value.includes('@') ? '' : ` (received "${value.replace(/[^ -~]/g, '?').slice(0, 80)}${value.length > 80 ? '...' : ''}")`;
    throw new Error(`INVALID_URL: Parameter "url" is not an absolute URL${shown}. Use a public http:// or https:// URL, for example https://example.com/page.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`INVALID_URL: Parameter "url" uses scheme "${url.protocol}", which is not supported. Use a public http:// or https:// URL.`);
  }
  if (url.username || url.password) throw new Error('INVALID_URL: Parameter "url" contains credentials (user:password@); remove them. Pages that need login cannot be fetched, so use a public URL.');
  return url;
}

/** Bare, lower-case hostname: IPv6 brackets and one trailing root dot removed. */
function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}
const isLocalHostname = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local');

/** Per-fetch memo of hostname checks so one page's subresources resolve each host once. */
export type ValidationCache = Map<string, Promise<void>>;

// Hosts below are the ones the caller (or a redirect from the page it asked for) supplied; resolved addresses are never echoed.
const localMessage = (host: string) => `NETWORK_BLOCKED: Host "${host}" is a local-network name (localhost, *.localhost or *.local); web_fetch only reaches public internet hosts. This may be the url itself or a redirect target; use a public http(s) URL.`;
const literalMessage = (host: string) => {
  let kind = 'non-public';
  try { kind = ipaddr.process(host).range(); } catch { /* keep generic */ }
  return `NETWORK_BLOCKED: Address "${host}" is not a public internet address (${kind}); private, loopback and link-local addresses cannot be fetched; use a public http(s) URL.`;
};
const dnsMessage = (host: string) => `NETWORK_ERROR: DNS lookup failed for host "${host}". Check the hostname spelling; the domain may not exist or DNS may be temporarily unavailable. This may be the url itself or a redirect target.`;
const resolvedMessage = (host: string) => `NETWORK_BLOCKED: Host "${host}" resolves to a non-public address (every resolved address must be public), so it cannot be fetched. This may be the url itself or a redirect target; use a different public http(s) URL.`;

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
      throw new Error('NETWORK_BLOCKED: The connection (possibly after a redirect or DNS change) reached a non-public address. Private and local addresses cannot be fetched; use a different public http(s) URL.');
    }
  }

  async validate(value: string, cache?: ValidationCache): Promise<URL> {
    const url = parseWebUrl(value);
    if (this.allowPrivateNetwork) return url;
    const hostname = normalizedHostname(url);
    if (isLocalHostname(hostname)) {
      throw new Error(localMessage(hostname));
    }
    if (ipaddr.isValid(hostname)) {
      if (!isPublicAddress(hostname)) throw new Error(literalMessage(hostname));
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

  /** Fresh, all-address validation for a single HTTP connection; callers must pin this address. */
  async resolveTarget(value: string): Promise<{ url: URL; address: string }> {
    const url = parseWebUrl(value);
    const hostname = normalizedHostname(url);
    if (!this.allowPrivateNetwork && isLocalHostname(hostname)) {
      throw new Error(localMessage(hostname));
    }
    let addresses: readonly { address: string }[];
    try { addresses = ipaddr.isValid(hostname) ? [{ address: hostname }] : await this.resolve(hostname); }
    catch { throw new Error(dnsMessage(hostname)); }
    if (!addresses.length || addresses.some(({ address }) => !ipaddr.isValid(address) || (!this.allowPrivateNetwork && !isPublicAddress(address)))) {
      throw new Error(resolvedMessage(hostname));
    }
    return { url, address: addresses[0]!.address };
  }

  private async checkResolved(hostname: string): Promise<void> {
    let addresses: readonly { address: string }[];
    try { addresses = await this.resolve(hostname); } catch {
      throw new Error(dnsMessage(hostname));
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error(resolvedMessage(hostname));
    }
  }
}
