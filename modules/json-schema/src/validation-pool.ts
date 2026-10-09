import { Worker } from "node:worker_threads";

export const VALIDATION_BUDGET_MS = 2_000;
export const MAX_VALIDATION_WORKERS = 4;
export const MAX_QUEUED_VALIDATIONS = 256;
const STARTUP_BUDGET_MS = 10_000;
const IDLE_MS = 30_000;

type Job = {
  schema: Record<string, unknown>; data: unknown; signal?: AbortSignal;
  resolve: (reason?: string) => void; abort: () => void;
};
type Slot = {
  worker: Worker; ready: boolean; retiring: boolean; retirement?: Promise<void>; job?: Job;
  timer?: ReturnType<typeof setTimeout>;
};

/** Global bounded pool: a retiring worker occupies its slot until exit/termination is confirmed. */
export class ValidationPool {
  private slots = new Set<Slot>();
  private queue: Job[] = [];
  private closing?: Promise<void>;
  constructor(private readonly createWorker: () => Worker = () => new Worker(new URL("./validation-worker.mjs", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } })) {}

  /** Drain on session shutdown; a later session can use the pool again. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    for (const job of this.queue.splice(0)) this.complete(job, "Validation cancelled: pool shutdown");
    this.closing = Promise.all([...this.slots].map(slot => this.retire(slot, "Validation cancelled: pool shutdown"))).then(() => undefined).finally(() => { this.closing = undefined; });
    return this.closing;
  }

  validate(schema: Record<string, unknown>, data: unknown, signal?: AbortSignal): Promise<string | undefined> {
    if (this.closing) return Promise.resolve("Validation cancelled: pool shutdown");
    if (signal?.aborted) return Promise.resolve("Validation cancelled");
    if (this.queue.length >= MAX_QUEUED_VALIDATIONS) return Promise.resolve("Validation capacity exhausted; retry after active validation completes");
    return new Promise(resolve => {
      const job: Job = { schema, data, signal, resolve, abort: () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          this.complete(job, "Validation cancelled");
        } else {
          const slot = [...this.slots].find(slot => slot.job === job);
          if (slot) void this.retire(slot, "Validation cancelled");
        }
      } };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.pump();
      if (signal?.aborted) job.abort();
    });
  }

  private complete(job: Job, reason?: string) {
    job.signal?.removeEventListener("abort", job.abort);
    job.resolve(reason);
  }

  private pump() {
    for (const slot of this.slots) {
      if (!this.queue.length) break;
      if (!slot.retiring && !slot.job && slot.ready) this.dispatch(slot);
    }
    while (this.queue.length && this.slots.size < MAX_VALIDATION_WORKERS) {
      const job = this.queue.shift()!;
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch (error) {
        this.complete(job, `Validation worker failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const slot: Slot = { worker, ready: false, retiring: false, job };
      this.slots.add(slot);
      slot.timer = setTimeout(() => void this.retire(slot, "Validation worker startup exceeded 10000ms"), STARTUP_BUDGET_MS);
      worker.on("message", (message: { ready?: boolean; reason?: string }) => {
        if (slot.retiring) return;
        if (!slot.ready) {
          if (!message.ready) { void this.retire(slot, "Validation worker failed its ready handshake"); return; }
          slot.ready = true;
          this.dispatch(slot);
          return;
        }
        const current = slot.job;
        if (!current) { void this.retire(slot, "Validation worker sent an unexpected result"); return; }
        clearTimeout(slot.timer);
        slot.job = undefined;
        this.complete(current, message.reason);
        worker.unref();
        slot.timer = setTimeout(() => void this.retire(slot), IDLE_MS);
        slot.timer.unref();
        this.pump();
      });
      worker.on("error", error => void this.retire(slot, `Validation worker failed: ${error.message}`));
      worker.on("exit", () => {
        clearTimeout(slot.timer);
        if (slot.job) { this.complete(slot.job, "Validation worker exited without a result"); slot.job = undefined; }
        this.slots.delete(slot);
        this.pump();
      });
    }
  }

  private dispatch(slot: Slot) {
    clearTimeout(slot.timer);
    slot.job ??= this.queue.shift();
    if (!slot.job) return;
    slot.worker.ref();
    slot.timer = setTimeout(() => void this.retire(slot, `Validation exceeded ${VALIDATION_BUDGET_MS}ms CPU-worker budget`), VALIDATION_BUDGET_MS);
    try { slot.worker.postMessage({ schema: slot.job.schema, data: slot.job.data }); }
    catch (error) { void this.retire(slot, `Validation worker failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private retire(slot: Slot, reason?: string): Promise<void> {
    if (slot.retiring) return slot.retirement ?? Promise.resolve();
    slot.retiring = true;
    clearTimeout(slot.timer);
    const job = slot.job;
    slot.job = undefined;
    slot.retirement = (async () => {
      try {
        await slot.worker.terminate();
        // Only a confirmed termination (or the exit event) releases capacity.
        this.slots.delete(slot);
        this.pump();
        if (job) this.complete(job, reason ?? "Validation worker stopped");
      } catch (error) {
        // Keep the slot reserved on termination failure; an eventual exit still releases it.
        if (job) this.complete(job, `Validation worker termination failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return slot.retirement;
  }
}

export const validationPool = new ValidationPool();
