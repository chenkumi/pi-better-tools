import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { extractHtml, MAX_HTML_BYTES, type ContentFormat, type ExtractionMode } from './extract.js';
import { NetworkPolicy, parseWebUrl } from './network.js';
import { installPlaywrightTlsCompatibility } from './playwright-tls-compat.js';

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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('CANCELLED: Fetch was cancelled.');
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortError(signal); }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) { promise.catch(() => {}); reject(abortError(signal)); return; }
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
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new Error('BUSY: Fetch queue is full.'));
    return new Promise((resolve, reject) => {
      const entry = { grant: () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve(this.releaseOnce());
      } };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(abortError(signal));
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

/** Browser-side network checks are best-effort SSRF defense, not a real sandbox.
 * Use a restricted container/egress proxy when fetching actively hostile pages. */
export class FetchService {
  private readonly policy: NetworkPolicy;
  private readonly queue: FetchQueue;
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly operations = new Set<AbortController>();
  private readonly closingBrowsers = new Set<Promise<void>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: FetchOptions, testOptions?: { allowPrivateNetwork?: boolean }) {
    installPlaywrightTlsCompatibility();
    if (!['chromium', 'chrome'].includes(options.channel) ||
        !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ||
        !Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 32 ||
        !Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 0) {
      throw new Error('CONFIG_ERROR: Invalid browser fetch options.');
    }
    this.policy = new NetworkPolicy(testOptions?.allowPrivateNetwork ?? false);
    this.queue = new FetchQueue(options.maxConcurrency);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('CLOSED: Fetch service is closed.');
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch({
        channel: this.options.channel,
        headless: true,
        timeout: this.options.timeoutMs,
        args: ['--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      }).then(async (browser) => {
        if (this.closed) { await browser.close(); throw new Error('CLOSED: Fetch service is closed.'); }
        this.browser = browser;
        browser.on('disconnected', () => { if (this.browser === browser) this.browser = undefined; });
        this.scheduleIdle();
        return browser;
      }).catch(() => {
        if (this.closed) throw new Error('CLOSED: Fetch service is closed.');
        throw new Error('BROWSER_UNAVAILABLE: Could not launch Chromium. Install the configured Playwright browser and retry.');
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

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult> {
    if (this.closed) throw new Error('CLOSED: Fetch service is closed.');
    if (signal?.aborted) throw new Error('CANCELLED: Fetch was cancelled.');
    const controller = new AbortController();
    const localSignal = controller.signal;
    const deadline = performance.now() + this.options.timeoutMs;
    const timeout = () => controller.abort(new Error('TIMEOUT: Fetch deadline exceeded (including queue and browser startup).'));
    const timer = setTimeout(timeout, this.options.timeoutMs);
    const onAbort = () => controller.abort(new Error('CANCELLED: Fetch was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.add(controller);
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
      if (input.format !== undefined && !['markdown', 'text'].includes(input.format)) throw new Error('INVALID_INPUT: Unsupported content format.');
      if (input.extraction !== undefined && !['auto', 'main', 'body'].includes(input.extraction)) throw new Error('INVALID_INPUT: Unsupported extraction mode.');
      if (input.waitForSelector !== undefined && (!input.waitForSelector.trim() || input.waitForSelector.length > 2048)) throw new Error('INVALID_INPUT: Selector must contain between 1 and 2048 characters.');
      const requestedUrl = parseWebUrl(input.url).href;
      release = await this.queue.acquire(localSignal);
      checkAbort(localSignal);
      await abortable(this.policy.validate(requestedUrl), localSignal);
      const browser = await abortable(this.getBrowser(), localSignal);
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
      await context.route('**/*', async (route: Route) => {
        const request = route.request();
        let mainNavigation = false;
        try { mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame(); } catch { /* worker request */ }
        let response: Awaited<ReturnType<Route['fetch']>> | undefined;
        try {
          checkAbort(localSignal);
          await abortable(this.policy.validate(request.url()), localSignal);
          // Chromium/Playwright skips user routes on redirect hops, even after
          // fulfill(). Never give the browser a redirect response. Main redirects
          // become a fresh goto below; subresources are followed manually.
          let target = request.url();
          let method = request.method();
          let postData = request.postDataBuffer() ?? undefined;
          const requestHeaders = { ...request.headers() };
          for (let hop = 0; ; hop++) {
            // Playwright buffers before exposing the response: these limits bound
            // accepted HTML, not peak browser/network memory consumption.
            response = await route.fetch({ url: target, method, postData, headers: requestHeaders, maxRedirects: 0, timeout: remaining() });
            const location = response.headers().location;
            if (!(response.status() >= 300 && response.status() < 400 && location)) break;
            if (hop >= 19) throw new Error('NETWORK_ERROR: Too many redirects.');
            const destination = new URL(location, target).href;
            await abortable(this.policy.validate(destination), localSignal);
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
            // Let the context's isolated cookie jar compute cookies for each hop.
            delete requestHeaders.cookie;
            delete requestHeaders.host;
            if ((response.status() === 303 && method !== 'HEAD') || ([301, 302].includes(response.status()) && method === 'POST')) {
              method = 'GET'; postData = Buffer.alloc(0);
              delete requestHeaders['content-type']; delete requestHeaders['content-length'];
            }
            target = destination;
            await response.dispose();
            response = undefined;
          }
          const headers = response.headers();
          if (/\battachment\b/i.test(headers['content-disposition'] ?? '')) {
            throw new Error('UNSUPPORTED_CONTENT: Downloads are not supported.');
          }
          if (mainNavigation && response.status() >= 400) throw new Error(`HTTP_ERROR: Server returned HTTP ${response.status()}.`);
          if (mainNavigation && !(response.status() >= 300 && response.status() < 400)) {
            const type = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
            if (type && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) {
              throw new Error('UNSUPPORTED_CONTENT: Only HTML and plain text pages are supported.');
            }
            if (Number(headers['content-length']) > MAX_HTML_BYTES) throw new Error('TOO_LARGE: HTML response exceeds the 5 MiB limit.');
            const body = await response.body();
            if (body.byteLength > MAX_HTML_BYTES) throw new Error('TOO_LARGE: HTML response exceeds the 5 MiB limit.');
          }
          checkAbort(localSignal);
          await route.fulfill({ response });
        } catch (error) {
          const safe = error instanceof Error && /^(NETWORK_BLOCKED|NETWORK_ERROR|INVALID_URL|UNSUPPORTED_CONTENT|TOO_LARGE|HTTP_ERROR):/.test(error.message)
            ? error : new Error('NETWORK_ERROR: A page request failed.');
          if (mainNavigation) navigationError = safe;
          else warnings.add('Some subresources were blocked or failed network policy checks; rendered content may be incomplete.');
          await route.abort('blockedbyclient').catch(() => {});
        } finally { await response?.dispose().catch(() => {}); }
      });
      let response;
      let navigationTarget = requestedUrl;
      for (let hop = 0; ; hop++) {
        if (hop >= 20) throw new Error('NETWORK_ERROR: Too many navigation redirects.');
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
          if (error instanceof Error && error.name === 'TimeoutError') throw new Error('TIMEOUT: Navigation or selector wait exceeded the fetch deadline.');
          throw new Error('FETCH_FAILED: Could not render the page or find the requested selector.');
        }
      }
      if (navigationError) throw navigationError;
      const status = response?.status() ?? 0;
      if (status < 200 || status >= 400 || status === 204 || status === 205) throw new Error(`HTTP_ERROR: Page returned no successful document (HTTP ${status}).`);
      const finalUrl = page.url();
      await abortable(this.policy.validate(finalUrl), localSignal);
      const html = await abortable(page.evaluate((maxBytes) => {
        const html = document.documentElement?.outerHTML ?? '';
        // Bound the serialized value crossing the browser protocol as well.
        if (new TextEncoder().encode(html).byteLength > maxBytes) return null;
        return html;
      }, MAX_HTML_BYTES), localSignal);
      if (html === null) throw new Error('TOO_LARGE: Rendered HTML exceeds the 5 MiB limit.');
      const extracted = extractHtml(html, finalUrl, input.format, input.extraction);
      remaining();
      return { url: input.url, finalUrl, status, fetchedAt: new Date().toISOString(), ...extracted, warnings: [...extracted.warnings, ...warnings] };
    } catch (error) {
      checkAbort(localSignal);
      // Do not expose Playwright call logs, headers, URL tokens or raw DNS errors.
      if (error instanceof Error && /^(INVALID_URL|INVALID_INPUT|NETWORK_BLOCKED|NETWORK_ERROR|TIMEOUT|CANCELLED|CLOSED|BUSY|BROWSER_UNAVAILABLE|FETCH_FAILED|HTTP_ERROR|UNSUPPORTED_CONTENT|TOO_LARGE|EMPTY_CONTENT):/.test(error.message)) throw error;
      throw new Error('FETCH_FAILED: Browser fetch failed.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      localSignal.removeEventListener('abort', onLocalAbort);
      await closeContext();
      release?.();
      this.operations.delete(controller);
      this.scheduleIdle();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const controller of this.operations) controller.abort(new Error('CLOSED: Fetch service is closed.'));
    this.closePromise = (async () => {
      const browser = this.browser;
      this.browser = undefined;
      if (browser) await this.closeBrowser(browser);
      // A pending shared launch must also be reaped, rather than orphaned.
      await this.launching?.catch(() => {});
      await Promise.all(this.closingBrowsers);
    })();
    return this.closePromise;
  }
}
