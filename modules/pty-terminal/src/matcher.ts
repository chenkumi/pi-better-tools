import { Worker, type WorkerOptions } from "node:worker_threads";

export const MATCH_BUDGET_MS = 1_000;
const MAX_MATCH_WORKERS = 16;
/** Upper bound for worker thread startup, which is not charged to the match budget. */
const WORKER_STARTUP_MS = 5_000;
let active = 0;

/** Deterministic worker/clock seams; production always owns a real isolated worker. */
export interface MatcherOptions {
  createWorker?: (url: URL, options: WorkerOptions) => Worker;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** Arbitrary user regex never executes in the Pi event loop. A resolved
 * receipt does not release capacity until the owned worker has terminated. */
export async function matchPattern(pattern: RegExp, input: string, signal?: AbortSignal, budgetMs = MATCH_BUDGET_MS, options: MatcherOptions = {}): Promise<boolean> {
  if (signal?.aborted) throw signal.reason ?? new Error("PTY wait aborted");
  if (active >= MAX_MATCH_WORKERS) throw new Error("PTY regex worker capacity exhausted; retry after active reads finish");
  active++;
  const timers = options.timers ?? { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  let worker: Worker | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, matched = false) => {
        if (done) return;
        done = true; timers.clear(timer); signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(matched);
      };
      const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("PTY wait aborted; output retained"));
      const budget = Math.min(MATCH_BUDGET_MS, Math.max(1, budgetMs));
      // `online` precedes module loading. Only the worker's ready receipt starts the compute budget.
      // A separate allowance still bounds startup/import/workerData deserialization.
      let timer = timers.set(() => finish(new Error(`PTY regex worker did not start within ${WORKER_STARTUP_MS}ms. Session and output retained.`)), WORKER_STARTUP_MS);
      let ready = false;
      const startBudget = () => {
        if (done || ready) return;
        ready = true;
        timers.clear(timer);
        timer = timers.set(() => finish(new Error(`waitFor regex exceeded ${budget}ms worker budget; simplify the pattern. Session and output retained.`)), budget);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        worker = (options.createWorker ?? ((url, config) => new Worker(url, config)))(new URL("./match-worker.mjs", import.meta.url), { workerData: { source: pattern.source, flags: pattern.flags, input }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
        worker.on("message", (message: { ready?: boolean; matched?: boolean; error?: string }) => {
          if (message.ready) startBudget();
          else finish(message.error ? new Error(message.error) : undefined, message.matched === true);
        });
        worker.once("error", error => finish(error));
        worker.once("exit", () => finish(new Error("PTY regex worker exited without a result")));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      if (signal?.aborted) abort();
    });
  } finally {
    try { await worker?.terminate(); } finally { active--; }
  }
}
