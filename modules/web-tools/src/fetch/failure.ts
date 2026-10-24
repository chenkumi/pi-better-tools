/** Safe, fixed-vocabulary descriptions of network failures. Only error codes and `net::ERR_*` tokens are
 * inspected; raw messages, hosts resolved by DNS, headers and URLs are never copied into the result. */

const CODE_CATEGORIES: [RegExp, string][] = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_FAIL)$/, 'DNS lookup failed'],
  [/^ECONNREFUSED$/, 'connection refused'],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/, 'connection reset by the server'],
  [/^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/, 'connection timed out'],
  [/(CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO|HOSTNAME_MISMATCH)/, 'TLS/certificate failure'],
  [/^(ENETUNREACH|EHOSTUNREACH)$/, 'network unreachable'],
];
const BROWSER_CATEGORIES: [RegExp, string][] = [
  [/^ERR_NAME_NOT_RESOLVED$|^ERR_NAME_RESOLUTION_FAILED$/, 'DNS lookup failed'],
  [/^ERR_CONNECTION_REFUSED$/, 'connection refused'],
  [/^ERR_CONNECTION_RESET$|^ERR_CONNECTION_CLOSED$|^ERR_EMPTY_RESPONSE$/, 'connection reset by the server'],
  [/^ERR_(CONNECTION_)?TIMED_OUT$/, 'connection timed out'],
  [/^ERR_(CERT|SSL)/, 'TLS/certificate failure'],
  [/^ERR_(INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED)$/, 'network unreachable'],
];

function categorize(table: [RegExp, string][], value: string): string | undefined {
  return table.find(([pattern]) => pattern.test(value))?.[1];
}

/** A category such as "DNS lookup failed" or "TLS/certificate failure"; "unknown network error" when nothing safe is known. */
export function describeNetworkFailure(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') {
      const category = categorize(CODE_CATEGORIES, code);
      if (category) return category;
    }
    const token = /net::(ERR_[A-Z0-9_]{1,40})/.exec(current.message)?.[1];
    if (token) return categorize(BROWSER_CATEGORIES, token) ?? `browser network error ${token}`;
    if (/unexpected redirect/i.test(current.message)) return 'redirect blocked';
    current = current.cause;
  }
  return 'unknown network error';
}

/** One next-step sentence for an HTTP status. */
export function httpStatusAdvice(status: number): string {
  if (status === 401) return 'The page requires login or credentials, which web_fetch cannot provide; look for a public copy.';
  if (status === 403) return 'The server forbids this request (blocked, bot protection or login required); try a different public URL for the same content.';
  if (status === 404 || status === 410) return 'The page does not exist; check the URL (spelling, trailing path) or find the current URL with web_search.';
  if (status === 429) return 'The server is rate limiting requests; retry later and avoid repeated fetches of the same site.';
  if (status >= 500) return 'The server failed on its side; retry later or try a different source.';
  if (status >= 300 && status < 400) return 'The redirect did not lead to a document; try the final URL directly.';
  if (status >= 400) return 'The server rejected the request; check the URL or try a different source.';
  return 'The response contained no document; try a different URL.';
}
