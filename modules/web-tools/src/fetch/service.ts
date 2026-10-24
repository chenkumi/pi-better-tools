import { performance } from 'node:perf_hooks';
import { setupCommand } from '../../../../setup/commands.mjs';
import { abortReason, parseSetCookie, requestBounded, ResponseBudget, type BoundedResponse } from './bounded.js';
import { DOCUMENT_CONTENT_TYPES, fetchStatic } from './http.js';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { extractHtmlIsolated, MAX_HTML_BYTES, prewarmExtractionWorker, shutdownExtractionWorkers, type ContentFormat, type ExtractionMode } from './extract.js';
import { NetworkPolicy, parseWebUrl, type ValidationCache } from './network.js';
import { installPlaywrightTlsCompatibility } from './playwright-tls-compat.js';
import { MAX_SELECTOR_CHARS } from '../tool-schemas.ts';
import { describeNetworkFailure, httpStatusAdvice } from './failure.js';

export type FetchOptions = {
  channel: 'chromium' | 'chrome';
  timeoutMs: number;
  maxConcurrency: number;
  idleTimeoutMs: number;
};
export type FetchInput = { url: string; format?: ContentFormat; extraction?: ExtractionMode; waitForSelector?: string };
export type FetchResult = {
  url: string; finalUrl: string; title: string; status: number; fetchedAt: string;
  content: string; extraction: string; warnings: string[];
};

/** Cap for every proxied response (document or subresource), enforced while reading: wire bytes and
 * decoded bytes are limited separately in a streaming pipeline (see bounded.ts). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const CLOSE_CONTEXT_TIMEOUT_MS = 5000;
/** Per-fetch subresource allowance; in-flight bytes count too, so peak buffering is bounded by it. */
export const MAX_SUBRESOURCE_REQUESTS = 200;
export const MAX_SUBRESOURCE_BYTES = 32 * 1024 * 1024;
export function exceedsResponseLimit(headers: Record<string, string>, bodyBytes?: number, limit = MAX_RESPONSE_BYTES): boolean {
  const declared = Number(headers['content-length']);
  return (Number.isFinite(declared) && declared > limit) || (bodyBytes !== undefined && bodyBytes > limit);
}

const CLOSED_MESSAGE = 'CLOSED: Fetch service is closed.';
const CANCELLED_MESSAGE = 'CANCELLED: Fetch was cancelled.';
const HTML_TOO_LARGE_MESSAGE = 'TOO_LARGE: HTML response exceeds the 5 MiB limit.';

function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortReason(signal); }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) { promise.catch(() => {}); reject(abortReason(signal)); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** FIFO queue with bounded capacity, and cancelled waiters removed immediately. */
export class FetchQueue {
  private active = 0;
  private readonly waiting: Array<{ grant: () => void }> = [];
  constructor(private readonly concurrency: number, private readonly maxQueued = Math.max(32, concurrency * 16)) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new Error('BUSY: web_fetch queue is full (too many running and waiting fetches); wait for running fetches to finish and retry later instead of issuing more in parallel.'));
    return new Promise((resolve, reject) => {
      const entry = { grant: () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve(this.releaseOnce());
      } };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.grant();
    };
  }
}

/** Bounded, printable rendering of an agent-supplied enum value for error text. */
const shown = (value: unknown) => JSON.stringify(String(value).replace(/[^ -~]/g, '?').slice(0, 40));

function requestHost(url: string): string {
  try { return new URL(url).hostname.slice(0, 100); } catch { return 'unknown'; }
}

function validateFetchInput(input: FetchInput): void {
  if (input.format !== undefined && !['markdown', 'text'].includes(input.format)) throw new Error(`INVALID_INPUT: Parameter "format" must be "markdown" or "text" (received ${shown(input.format)}).`);
  if (input.extraction !== undefined && !['auto', 'main', 'body'].includes(input.extraction)) throw new Error(`INVALID_INPUT: Parameter "extraction" must be "auto", "main" or "body" (received ${shown(input.extraction)}).`);
  if (input.waitForSelector !== undefined && (!input.waitForSelector.trim() || input.waitForSelector.length > MAX_SELECTOR_CHARS)) {
    throw new Error(`INVALID_INPUT: Parameter "waitForSelector" must be a CSS selector of 1 to ${MAX_SELECTOR_CHARS} non-blank characters (received ${input.waitForSelector.length} characters). Shorten it or omit it.`);
  }
}

/** Read a routed response body: the main document against the HTML cap, subresources against the per-fetch budget. */
async function readRouteBody(response: BoundedResponse, mainNavigation: boolean, budget: ResponseBudget, warnings: Set<string>): Promise<Buffer> {
  if (mainNavigation) {
    const type = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type && !DOCUMENT_CONTENT_TYPES.includes(type)) {
      throw new Error('UNSUPPORTED_CONTENT: Only HTML and plain text pages are supported (PDF, images and binary files are not). Look for an HTML version or abstract page, or search for a text mirror.');
    }
    if (Number(response.headers['content-length']) > MAX_HTML_BYTES) throw new Error(HTML_TOO_LARGE_MESSAGE);
    try { return await response.readBody(MAX_HTML_BYTES); }
    catch (error) { throw error instanceof Error && error.message.startsWith('TOO_LARGE:') ? new Error(HTML_TOO_LARGE_MESSAGE) : error; }
  }
  try { return await response.readBody(MAX_RESPONSE_BYTES, budget); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('TOO_LARGE:')) warnings.add('Some subresources exceeded the size limits and were blocked; rendered content may be incomplete.');
    throw error;
  }
}

/** Wait for `promise`, but no longer than `ms`; the timer never keeps the process alive. */
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

export type BrowserLaunchReason = 'missing-executable' | 'system-dependencies' | 'permission' | 'timeout' | 'unknown';
export class BrowserLaunchError extends Error {
  constructor(readonly reason: BrowserLaunchReason, guidance: string) { super(`BROWSER_UNAVAILABLE: ${guidance}`); }
}

/** Classify known Playwright launch diagnostics without exposing paths or call logs. */
function browserLaunchError(error: unknown, channel: FetchOptions['channel']): Error {
  const message = error instanceof Error ? error.message : '';
  const summary = message.split('\n', 1)[0] ?? '';
  let guidance: string;
  let reason: BrowserLaunchReason = 'unknown';
  const install = setupCommand(['browser', 'install']);
  if (/^(?:browserType\.launch: )?(?:Executable doesn't exist at |Chromium distribution '[^']+' is not found)/.test(summary)) {
    reason = 'missing-executable';
    guidance = channel === 'chrome'
      ? `Google Chrome executable was not found. Install Google Chrome, or ask the user to switch the browser fetch engine to Chromium and run ${install}.`
      : `Playwright Chromium executable was not found. Install it with ${install} using the same user and browser-cache environment as Pi.`;
  } else if (/Host system is missing dependencies|error while loading shared libraries/.test(message)) {
    reason = 'system-dependencies';
    guidance = `Browser system dependencies are missing. On Linux/WSL, review and run ${setupCommand(['browser', 'install-deps'])} with user approval; on other systems, check the required browser runtime dependencies.`;
  } else if ((error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) || /\b(?:EACCES|EPERM)\b/.test(summary)) {
    reason = 'permission';
    guidance = 'Browser launch permission was denied. Check executable/cache permissions and OS security policy; reinstalling the browser is not necessarily required.';
  } else if (error instanceof Error && error.name === 'TimeoutError') {
    reason = 'timeout';
    guidance = 'Browser startup timed out. Check system load and browser startup restrictions; consider asking the user to increase the fetch time limit in the web tools configuration. A missing browser is not confirmed.';
  } else {
    guidance = 'Browser startup failed; a missing browser is not confirmed. Check browser runtime compatibility, OS security policy and available resources before retrying.';
  }
  return new BrowserLaunchError(reason, guidance);
}

/** Browser-side network checks are best-effort SSRF defense, not a real sandbox.
 * Use a restricted container/egress proxy when fetching actively hostile pages. */
export class FetchService {
  private readonly policy: NetworkPolicy;
  private readonly queue: FetchQueue;
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly operations = new Set<AbortController>();
  private readonly operationCleanup = new Set<Promise<void>>();
  private readonly closingBrowsers = new Set<Promise<void>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: FetchOptions, testOptions?: { allowPrivateNetwork?: boolean }) {
    installPlaywrightTlsCompatibility();
    const invalidOption =
      !['chromium', 'chrome'].includes(options.channel) ? 'channel must be "chromium" or "chrome"' :
      !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ? 'timeoutMs must be a positive number of milliseconds' :
      !Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 32 ? 'maxConcurrency must be an integer from 1 to 32' :
      !Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 0 ? 'idleTimeoutMs must be a number of milliseconds, 0 or greater' : undefined;
    if (invalidOption) throw new Error(`CONFIG_ERROR: Invalid browser fetch option: ${invalidOption} (fetch section of the web-search configuration).`);
    this.policy = new NetworkPolicy(testOptions?.allowPrivateNetwork ?? false);
    this.queue = new FetchQueue(options.maxConcurrency);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error(CLOSED_MESSAGE);
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch({
        channel: this.options.channel,
        headless: true,
        timeout: this.options.timeoutMs,
        args: ['--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      }).then(async (browser) => {
        if (this.closed) { await browser.close(); throw new Error(CLOSED_MESSAGE); }
        this.browser = browser;
        browser.on('disconnected', () => { if (this.browser === browser) this.browser = undefined; });
        this.scheduleIdle();
        return browser;
      }).catch((error: unknown) => {
        if (this.closed) throw new Error(CLOSED_MESSAGE);
        throw browserLaunchError(error, this.options.channel);
      }).finally(() => { this.launching = undefined; });
    }
    return this.launching;
  }

  private closeBrowser(browser: Browser): Promise<void> {
    const closing = browser.close().catch(() => {}).finally(() => { this.closingBrowsers.delete(closing); });
    this.closingBrowsers.add(closing);
    return closing;
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed || this.operations.size || !this.browser) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.operations.size) return;
      const browser = this.browser;
      this.browser = undefined;
      if (browser) void this.closeBrowser(browser);
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  }

  /** Without a browser executable: one static HTTP document, no JavaScript or subresources. */
  private async fetchStaticFallback(input: FetchInput, requestedUrl: string, signal: AbortSignal, remaining: () => number, browserError: BrowserLaunchError): Promise<FetchResult> {
    const document = await fetchStatic(requestedUrl, this.policy, signal);
    remaining();
    const extracted = await extractHtmlIsolated(document.html, document.finalUrl, input.format, input.extraction, signal);
    remaining();
    return { url: input.url, finalUrl: document.finalUrl, status: document.status, fetchedAt: new Date().toISOString(), ...extracted,
      warnings: [...extracted.warnings, `Static HTTP mode: JavaScript and subresources were not loaded; content may be incomplete. ${browserError.message}`] };
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult> {
    if (this.closed) throw new Error(CLOSED_MESSAGE);
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    const controller = new AbortController();
    const localSignal = controller.signal;
    const deadline = performance.now() + this.options.timeoutMs;
    const timeout = () => controller.abort(new Error(`TIMEOUT: Fetch deadline of ${Math.round(this.options.timeoutMs / 1000)} s exceeded, including queue and browser startup. Try a different page, or set waitForSelector to an element that appears early.`));
    const timer = setTimeout(timeout, this.options.timeoutMs);
    const onAbort = () => controller.abort(new Error(CANCELLED_MESSAGE));
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.add(controller);
    let finishOperation!: () => void;
    const cleanup = new Promise<void>(resolve => { finishOperation = resolve; });
    this.operationCleanup.add(cleanup);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let context: BrowserContext | undefined;
    let release: (() => void) | undefined;
    let contextClosing: Promise<void> | undefined;
    const closeContext = (): Promise<void> => {
      if (!context) return Promise.resolve();
      // Playwright treats "closing" as closed: a second close() returns early.
      // The abort handler and finally must await the same first close promise.
      return contextClosing ??= context.close().catch(() => {});
    };
    const onLocalAbort = () => { void closeContext(); };
    localSignal.addEventListener('abort', onLocalAbort, { once: true });
    const remaining = () => {
      if (performance.now() >= deadline) timeout();
      checkAbort(localSignal);
      return Math.max(1, Math.ceil(deadline - performance.now()));
    };
    try {
      validateFetchInput(input);
      // One DNS validation per hostname within this fetch (the connected address is still checked per response).
      const validated: ValidationCache = new Map();
      const validate = (value: string) => this.policy.validate(value, validated);
      const requestedUrl = parseWebUrl(input.url).href;
      release = await this.queue.acquire(localSignal);
      checkAbort(localSignal);
      await abortable(validate(requestedUrl), localSignal);
      // Loading jsdom in a fresh worker takes seconds; warm one while the browser starts/navigates.
      prewarmExtractionWorker();
      let browser: Browser;
      try { browser = await abortable(this.getBrowser(), localSignal); }
      catch (error) {
        remaining();
        if (!(error instanceof BrowserLaunchError) || error.reason !== 'missing-executable') throw error;
        if (input.waitForSelector) throw new BrowserLaunchError('missing-executable', `Static HTTP cannot honor waitForSelector; a browser is required. ${error.message}`);
        return await this.fetchStaticFallback(input, requestedUrl, localSignal, remaining, error);
      }
      // A context can finish creating after cancellation. Its creating promise owns
      // late cleanup; the caller still receives cancellation without waiting for it.
      const creating = browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false });
      void creating.then((created) => { if (localSignal.aborted) void created.close().catch(() => {}); }, () => {});
      context = await abortable(creating, localSignal);
      checkAbort(localSignal);
      const page = await abortable(context.newPage(), localSignal);
      context.on('page', (other) => { if (other !== page) void other.close().catch(() => {}); });
      page.on('download', (download) => { void download.cancel().catch(() => {}); });
      await context.routeWebSocket('**/*', (socket) => { socket.close(); });
      const warnings = new Set<string>();
      let navigationError: Error | undefined;
      let navigationRedirect: string | undefined;
      // Subresource allowance for this fetch (request count and cumulative decoded bytes).
      const budget = new ResponseBudget(MAX_SUBRESOURCE_REQUESTS, MAX_SUBRESOURCE_BYTES);
      const activeContext = context;
      await context.route('**/*', async (route: Route) => {
        const request = route.request();
        let mainNavigation = false;
        try { mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame(); } catch { /* worker request */ }
        let response: BoundedResponse | undefined;
        try {
          checkAbort(localSignal);
          // Media, fonts, images and stylesheets are never needed for text extraction (it never
          // renders or applies CSS); do not fetch them at all.
          if (!mainNavigation && ['media', 'font', 'image', 'stylesheet'].includes(request.resourceType())) {
            await route.abort('blockedbyclient').catch(() => {});
            return;
          }
          await abortable(validate(request.url()), localSignal);
          if (!mainNavigation) budget.admit();
          // Chromium/Playwright skips user routes on redirect hops, even after
          // fulfill(). Never give the browser a redirect response. Main redirects
          // become a fresh goto below; subresources are followed manually.
          let target = request.url();
          let method = request.method();
          let postData = request.postDataBuffer() ?? undefined;
          const requestHeaders = { ...request.headers() };
          for (let hop = 0; ; hop++) {
            // Bounded transport: wire and decoded bytes are limited while reading, so Playwright
            // never buffers or decompresses an unbounded body in the host process.
            const cookies = await abortable(activeContext.cookies(target), localSignal).catch(() => []);
            const headers = { ...requestHeaders };
            delete headers.cookie;
            if (cookies.length) headers.cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
            response = await requestBounded({ url: target, method, body: postData, headers, signal: localSignal });
            // DNS-rebinding mitigation: the pre-flight lookup and this connection resolve separately,
            // so verify the address actually connected to before anything is handed to the browser.
            this.policy.assertConnectedAddress(response.remoteAddress);
            const location = response.headers.location;
            if (!(response.status >= 300 && response.status < 400 && location)) break;
            if (hop >= 19) throw new Error('NETWORK_ERROR: Too many redirects (limit 20); the URL redirects in a loop. Try the final destination URL directly.');
            const destination = new URL(location, target).href;
            await abortable(validate(destination), localSignal);
            // Each followed hop is another network request: it counts against the same per-fetch budget, otherwise a
            // page could multiply the 200-request allowance by the 20-request redirect chain. Main navigations restart
            // through a fresh goto below and are not subresources.
            if (!mainNavigation) budget.admit();
            // Best effort: keep cookies set on redirect hops, as the context jar did before.
            const redirectCookies = response.setCookies.map((value) => parseSetCookie(value, target)).filter((cookie) => cookie !== undefined);
            if (redirectCookies.length) await activeContext.addCookies(redirectCookies).catch(() => {});
            if (mainNavigation) {
              if (method !== 'GET' && method !== 'HEAD') throw new Error('UNSUPPORTED_CONTENT: Redirected form navigation is not supported.');
              navigationRedirect = destination;
              await route.abort('aborted');
              return;
            }
            if (new URL(destination).origin !== new URL(target).origin) {
              delete requestHeaders.authorization;
              delete requestHeaders['proxy-authorization'];
            }
            delete requestHeaders.cookie;
            delete requestHeaders.host;
            if ((response.status === 303 && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST')) {
              method = 'GET'; postData = Buffer.alloc(0);
              delete requestHeaders['content-type']; delete requestHeaders['content-length'];
            }
            target = destination;
            await response.dispose();
            response = undefined;
          }
          const headers = response.headers;
          if (/\battachment\b/i.test(headers['content-disposition'] ?? '')) {
            throw new Error('UNSUPPORTED_CONTENT: Downloads are not supported. Look for an HTML page that describes the file instead.');
          }
          if (exceedsResponseLimit(headers)) throw new Error('TOO_LARGE: Response exceeds the 10 MiB limit.');
          if (mainNavigation && response.status >= 400) throw new Error(`HTTP_ERROR: Server returned HTTP ${response.status}. ${httpStatusAdvice(response.status)}`);
          const body = await readRouteBody(response, mainNavigation, budget, warnings);
          checkAbort(localSignal);
          // The body is already decoded: drop encoding/length headers so the browser does not decode twice.
          const fulfillHeaders = { ...headers };
          for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) delete fulfillHeaders[name];
          await route.fulfill({ status: response.status, headers: fulfillHeaders, body });
        } catch (error) {
          const safe = error instanceof Error && /^(NETWORK_BLOCKED|NETWORK_ERROR|INVALID_URL|UNSUPPORTED_CONTENT|TOO_LARGE|HTTP_ERROR):/.test(error.message)
            ? error : new Error(`NETWORK_ERROR: A page request to host "${requestHost(request.url())}" failed (${describeNetworkFailure(error)}). Retry once; if it persists try a different URL.`);
          if (mainNavigation) navigationError = safe;
          else warnings.add('Some subresources were blocked or failed network policy checks; rendered content may be incomplete.');
          await route.abort('blockedbyclient').catch(() => {});
        } finally { await response?.dispose().catch(() => {}); }
      });
      let response;
      let navigationTarget = requestedUrl;
      for (let hop = 0; ; hop++) {
        if (hop >= 20) throw new Error('NETWORK_ERROR: Too many navigation redirects (limit 20); the URL redirects in a loop. Try the final destination URL directly.');
        navigationRedirect = undefined;
        navigationError = undefined;
        try {
          response = await abortable(page.goto(navigationTarget, { waitUntil: 'domcontentloaded', timeout: remaining() }), localSignal);
          if (input.waitForSelector) {
            await abortable(page.waitForSelector(input.waitForSelector, { state: 'attached', timeout: remaining() }), localSignal);
          } else {
            // Bounded hydration opportunity; never wait for perpetual network-idle.
            await abortable(page.waitForTimeout(Math.min(250, remaining())), localSignal);
          }
          if (navigationRedirect) { navigationTarget = navigationRedirect; continue; }
          break;
        } catch (error) {
          checkAbort(localSignal);
          if (navigationRedirect) { navigationTarget = navigationRedirect; continue; }
          if (navigationError) throw navigationError;
          if (error instanceof Error && error.name === 'TimeoutError') throw new Error('TIMEOUT: Navigation or selector wait exceeded the fetch deadline. Adjust or remove waitForSelector, or try a different page.');
          throw new Error('FETCH_FAILED: Could not render the page or find the requested selector.');
        }
      }
      if (navigationError) throw navigationError;
      const status = response?.status() ?? 0;
      if (status < 200 || status >= 400 || status === 204 || status === 205) throw new Error(`HTTP_ERROR: Page returned no successful document (HTTP ${status}). ${httpStatusAdvice(status)}`);
      const finalUrl = page.url();
      await abortable(validate(finalUrl), localSignal);
      const html = await abortable(page.evaluate((maxBytes) => {
        const html = document.documentElement?.outerHTML ?? '';
        // Bound the serialized value crossing the browser protocol as well.
        if (new TextEncoder().encode(html).byteLength > maxBytes) return null;
        return html;
      }, MAX_HTML_BYTES), localSignal);
      if (html === null) throw new Error('TOO_LARGE: Rendered HTML exceeds the 5 MiB limit.');
      const extracted = await extractHtmlIsolated(html, finalUrl, input.format, input.extraction, localSignal);
      remaining();
      return { url: input.url, finalUrl, status, fetchedAt: new Date().toISOString(), ...extracted, warnings: [...extracted.warnings, ...warnings] };
    } catch (error) {
      checkAbort(localSignal);
      // Do not expose Playwright call logs, headers, URL tokens or raw DNS errors.
      if (error instanceof Error && /^(INVALID_URL|INVALID_INPUT|NETWORK_BLOCKED|NETWORK_ERROR|TIMEOUT|CANCELLED|CLOSED|BUSY|BROWSER_UNAVAILABLE|FETCH_FAILED|HTTP_ERROR|UNSUPPORTED_CONTENT|TOO_LARGE|EMPTY_CONTENT):/.test(error.message)) throw error;
      const cause = describeNetworkFailure(error);
      throw new Error(`FETCH_FAILED: Browser fetch failed (${cause === 'unknown network error' ? 'cause not classified' : cause}). Retry once; if it persists try a different URL or format:"text".`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      localSignal.removeEventListener('abort', onLocalAbort);
      try {
        // A hung close must not hold the queue slot forever; the browser is reaped on idle/close().
        await settleWithin(closeContext(), CLOSE_CONTEXT_TIMEOUT_MS);
      } finally {
        release?.();
      }
      this.operations.delete(controller);
      this.operationCleanup.delete(cleanup);
      finishOperation();
      this.scheduleIdle();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const controller of this.operations) controller.abort(new Error(CLOSED_MESSAGE));
    const workersClosed = shutdownExtractionWorkers();
    this.closePromise = (async () => {
      const browser = this.browser;
      this.browser = undefined;
      if (browser) await this.closeBrowser(browser);
      // A pending shared launch must also be reaped, rather than orphaned.
      await this.launching?.catch(() => {});
      await Promise.all(this.closingBrowsers);
      await workersClosed;
      await Promise.all(this.operationCleanup);
    })();
    return this.closePromise;
  }
}
