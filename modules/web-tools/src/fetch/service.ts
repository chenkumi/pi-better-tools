import { performance } from 'node:perf_hooks';
import { abortReason } from './bounded.ts';
import { fetchStatic } from './http.ts';
import { extractHtmlIsolated, prewarmExtractionWorker, shutdownExtractionWorkers, type ContentFormat, type ExtractionMode } from './extract.ts';
import { NetworkPolicy, parseWebUrl } from './network.ts';

export type FetchOptions = {
  timeoutMs: number;
  maxConcurrency: number;
};
export type FetchInput = { url: string; format?: ContentFormat; extraction?: ExtractionMode };
export type FetchResult = {
  url: string; finalUrl: string; title: string; status: number; fetchedAt: string;
  content: string; extraction: string; warnings: string[];
};

const CLOSED_MESSAGE = 'CLOSED: Fetch service is closed.';
const CANCELLED_MESSAGE = 'CANCELLED: Fetch was cancelled.';

function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortReason(signal); }

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

function validateFetchInput(input: FetchInput): void {
  if (input.format !== undefined && !['markdown', 'text'].includes(input.format)) throw new Error(`INVALID_INPUT: Parameter "format" must be "markdown" or "text" (received ${shown(input.format)}).`);
  if (input.extraction !== undefined && !['auto', 'main', 'body'].includes(input.extraction)) throw new Error(`INVALID_INPUT: Parameter "extraction" must be "auto", "main" or "body" (received ${shown(input.extraction)}).`);
}

/** Basic static HTTP fetch: one pinned-address GET (redirects re-validated), no JavaScript, cookies or subresources.
 * The address check is defense in depth, not a sandbox; use a restricted egress proxy for hostile pages. */
export class FetchService {
  private readonly policy: NetworkPolicy;
  private readonly queue: FetchQueue;
  private readonly operations = new Set<AbortController>();
  private readonly operationCleanup = new Set<Promise<void>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: FetchOptions, testOptions?: { allowPrivateNetwork?: boolean }) {
    const invalidOption =
      !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ? 'timeoutMs must be a positive number of milliseconds' :
      !Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 32 ? 'maxConcurrency must be an integer from 1 to 32' : undefined;
    if (invalidOption) throw new Error(`CONFIG_ERROR: Invalid fetch option: ${invalidOption} (fetch section of the web-search configuration).`);
    this.policy = new NetworkPolicy(testOptions?.allowPrivateNetwork ?? false);
    this.queue = new FetchQueue(options.maxConcurrency);
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult> {
    if (this.closed) throw new Error(CLOSED_MESSAGE);
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    const controller = new AbortController();
    const localSignal = controller.signal;
    const deadline = performance.now() + this.options.timeoutMs;
    const timeout = () => controller.abort(new Error(`TIMEOUT: Fetch deadline of ${Math.round(this.options.timeoutMs / 1000)} s exceeded, including queue time. Try a different page.`));
    const timer = setTimeout(timeout, this.options.timeoutMs);
    const onAbort = () => controller.abort(new Error(CANCELLED_MESSAGE));
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.add(controller);
    let finishOperation!: () => void;
    const cleanup = new Promise<void>(resolve => { finishOperation = resolve; });
    this.operationCleanup.add(cleanup);
    let release: (() => void) | undefined;
    const remaining = () => {
      if (performance.now() >= deadline) timeout();
      checkAbort(localSignal);
    };
    try {
      validateFetchInput(input);
      const requestedUrl = parseWebUrl(input.url).href;
      release = await this.queue.acquire(localSignal);
      checkAbort(localSignal);
      // Loading jsdom in a fresh worker takes seconds; warm one while the request is in flight.
      prewarmExtractionWorker();
      const document = await fetchStatic(requestedUrl, this.policy, localSignal);
      remaining();
      const extracted = await extractHtmlIsolated(document.html, document.finalUrl, input.format, input.extraction, localSignal);
      remaining();
      return { url: input.url, finalUrl: document.finalUrl, status: document.status, fetchedAt: new Date().toISOString(), ...extracted,
        warnings: [...extracted.warnings, 'Static HTTP fetch: JavaScript and subresources were not loaded; content may be incomplete.'] };
    } catch (error) {
      checkAbort(localSignal);
      if (error instanceof Error && /^(INVALID_URL|INVALID_INPUT|NETWORK_BLOCKED|NETWORK_ERROR|TIMEOUT|CANCELLED|CLOSED|BUSY|FETCH_FAILED|HTTP_ERROR|UNSUPPORTED_CONTENT|TOO_LARGE|EMPTY_CONTENT):/.test(error.message)) throw error;
      throw new Error('FETCH_FAILED: Fetch failed (cause not classified). Retry once; if it persists try a different URL or format:"text".');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      release?.();
      this.operations.delete(controller);
      this.operationCleanup.delete(cleanup);
      finishOperation();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const controller of this.operations) controller.abort(new Error(CLOSED_MESSAGE));
    const workersClosed = shutdownExtractionWorkers();
    this.closePromise = (async () => {
      await workersClosed;
      await Promise.all(this.operationCleanup);
    })();
    return this.closePromise;
  }
}
