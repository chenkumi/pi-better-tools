import { Worker } from 'node:worker_threads';
import { extractHtml, MAX_EXTRACTED_BYTES, MAX_HTML_BYTES, type ContentFormat, type ExtractionMode, type ExtractionResult } from './extract-core.mjs';

export { extractHtml, MAX_EXTRACTED_BYTES, MAX_HTML_BYTES };
export type { ContentFormat, ExtractionMode, ExtractionResult };

const SAFE_WORKER_ERROR = /^(EMPTY_CONTENT|TOO_LARGE):/;
/** Heap cap for one extraction worker so a hostile document cannot exhaust the host process. */
const WORKER_HEAP_MB = 1024;
const MAX_IDLE_WORKERS = 2;
/** Four configured fetches plus two idle workers; retiring workers also occupy these slots. */
export const MAX_EXTRACTION_WORKERS = 6;
const IDLE_WORKER_TTL_MS = 30_000;

type WorkerReply = { ready: true } | { ok: true; result: ExtractionResult } | { ok: false; message: string };
type Pooled = {
  worker: Worker; ready: Promise<boolean>; gone: Promise<void>; markGone: () => void;
  timer?: ReturnType<typeof setTimeout>; retired?: boolean; exited?: boolean;
};

// Loading jsdom costs seconds in a fresh worker, so finished workers are kept warm and reused.
// A worker that was aborted, errored or exited is never returned to the pool.
const idle: Pooled[] = [];
// Ownership is released only by actual exit or a successfully completed terminate(), not by abort.
const owned = new Set<Pooled>();
let shuttingDown: Promise<void> | undefined;

function spawn(): Pooled | undefined {
  if (shuttingDown || owned.size >= MAX_EXTRACTION_WORKERS) return undefined;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./extract-worker.mjs', import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
  } catch { return undefined; }
  let markGone!: () => void;
  const gone = new Promise<void>((resolve) => { markGone = resolve; });
  const pooled: Pooled = { worker, ready: Promise.resolve(false), gone, markGone };
  owned.add(pooled);
  pooled.ready = new Promise<boolean>((resolve) => {
    const onMessage = (message: WorkerReply) => { if ('ready' in message) { worker.off('message', onMessage); resolve(true); } };
    worker.on('message', onMessage);
    // Keep these lifecycle handlers even after startup: idle workers can also fail.
    // Exactly one pair per worker avoids accumulating exit listeners across reuse.
    worker.once('error', () => { worker.off('message', onMessage); resolve(false); retire(pooled); });
    worker.once('exit', () => { worker.off('message', onMessage); resolve(false); releaseOwnership(pooled); });
  });
  worker.unref();
  return pooled;
}

function removeIdle(pooled: Pooled): void {
  if (pooled.timer) clearTimeout(pooled.timer);
  const index = idle.indexOf(pooled);
  if (index >= 0) idle.splice(index, 1);
}

function releaseOwnership(pooled: Pooled): void {
  if (pooled.exited) return;
  pooled.exited = true;
  pooled.retired = true;
  removeIdle(pooled);
  owned.delete(pooled);
  pooled.markGone();
}

function retire(pooled: Pooled): void {
  if (pooled.retired) return;
  pooled.retired = true;
  removeIdle(pooled);
  pooled.worker.ref();
  try {
    void pooled.worker.terminate().then(() => releaseOwnership(pooled), () => {
      // Failed termination is not evidence of exit. Keep ownership until the exit event.
    });
  } catch { /* Same fail-closed ownership rule for synchronous termination errors. */ }
}

function park(pooled: Pooled): void {
  if (pooled.retired) return;
  pooled.worker.unref();
  if (idle.length >= MAX_IDLE_WORKERS) { retire(pooled); return; }
  pooled.timer = setTimeout(() => retire(pooled), IDLE_WORKER_TTL_MS);
  pooled.timer.unref();
  idle.push(pooled);
}

function acquire(): Pooled | undefined {
  if (shuttingDown) return undefined;
  const pooled = idle.pop();
  if (pooled?.timer) clearTimeout(pooled.timer);
  const acquired = pooled ?? spawn();
  // Pending extraction must keep the process alive; only idle workers are unreferenced.
  acquired?.worker.ref();
  return acquired;
}

/** Start one extraction worker ahead of time (e.g. while the browser launches). Best effort. */
export function prewarmExtractionWorker(): void {
  if (idle.length === 0) { const pooled = spawn(); if (pooled) park(pooled); }
}

/** Reap all owned workers, including active and already-retiring workers. */
export function shutdownExtractionWorkers(): Promise<void> {
  if (shuttingDown) return shuttingDown;
  const workers = [...owned];
  for (const pooled of workers) retire(pooled);
  shuttingDown = Promise.all(workers.map((pooled) => pooled.gone)).then(() => {}).finally(() => { shuttingDown = undefined; });
  return shuttingDown;
}

const abortReason = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new Error('CANCELLED: Fetch was cancelled.');

/**
 * Extract in a terminable worker thread. `signal` aborting (cancel, fetch deadline, shutdown)
 * terminates the worker immediately; the caller's rejection reason is the signal's reason.
 */
export function extractHtmlIsolated(
  html: string, url: string, format: ContentFormat | undefined, mode: ExtractionMode | undefined, signal: AbortSignal,
): Promise<ExtractionResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) { reject(new Error('TOO_LARGE: HTML response exceeds the 5 MiB limit.')); return; }
    const pooled = acquire();
    if (!pooled) {
      reject(new Error(shuttingDown || owned.size >= MAX_EXTRACTION_WORKERS
        ? 'BUSY: Content extraction worker capacity is occupied (including terminating workers).'
        : 'FETCH_FAILED: Could not start the content extraction worker.'));
      return;
    }
    const { worker } = pooled;
    let done = false;
    const finish = (reuse: boolean, settle: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      if (reuse) park(pooled); else retire(pooled);
      settle();
    };
    const onAbort = () => finish(false, () => reject(abortReason(signal)));
    const onMessage = (message: WorkerReply) => {
      if ('ready' in message) return;
      finish(true, () => {
        if (message.ok) resolve(message.result);
        else reject(SAFE_WORKER_ERROR.test(message.message) ? new Error(message.message) : new Error('FETCH_FAILED: Content extraction failed.'));
      });
    };
    const onError = () => finish(false, () => reject(new Error('FETCH_FAILED: Content extraction failed.')));
    const onExit = () => finish(false, () => reject(new Error('FETCH_FAILED: Content extraction worker exited without a result.')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
    void pooled.ready.then((ok) => {
      if (done) return;
      if (!ok) { onError(); return; }
      try { worker.postMessage({ html, url, format, mode }); } catch { onError(); }
    });
  });
}
