import * as fs from "fs";
import * as path from "path";
import type { CronJob, CronStore } from "./types.js";
import { deadlineState } from "./deadline.js";

const RENAME_RETRIES = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Minimum shape every consumer relies on; anything else (null, strings, ...) is dropped on load. */
function isJobShape(value: unknown): value is CronJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const j = value as Record<string, unknown>;
  const optionalString = (key: string) => j[key] === undefined || typeof j[key] === "string";
  const selections = (v: unknown) => v === undefined || typeof v === "boolean" ||
    (Array.isArray(v) && v.every((item) => typeof item === "string"));
  return typeof j.id === "string" && j.id.length > 0 && typeof j.name === "string" &&
    typeof j.schedule === "string" && typeof j.prompt === "string" &&
    typeof j.enabled === "boolean" && ["cron", "once", "interval"].includes(j.type as string) &&
    (j.intervalMs === undefined || (typeof j.intervalMs === "number" && Number.isFinite(j.intervalMs) && j.intervalMs > 0)) &&
    (j.type !== "interval" || typeof j.intervalMs === "number") &&
    (j.runCount === undefined || (typeof j.runCount === "number" && Number.isSafeInteger(j.runCount) && j.runCount >= 0)) &&
    ["createdAt", "lastRun", "nextRun", "description", "session"].every(optionalString) &&
    (j.model === undefined || (typeof j.model === "string" && j.model.trim().length > 0)) &&
    (j.notify === undefined || typeof j.notify === "boolean") &&
    (j.lastStatus === undefined || ["running", "success", "error"].includes(j.lastStatus as string)) &&
    selections(j.extensions) && selections(j.skills);
  // endAt intentionally passes through: the scheduler disables malformed deadlines,
  // preserving the v1 fail-closed deadline/status semantics rather than dropping the job.
}

/**
 * Handles persistence of scheduled prompts to .pi/schedule-prompts.json
 */
export class CronStorage {
  private readonly storePath: string;
  private readonly piDir: string;
  private readonly lockPath: string;
  private holdingLock = false;

  constructor(cwd: string) {
    this.piDir = path.join(cwd, ".pi");
    this.storePath = path.join(this.piDir, "schedule-prompts.json");
    this.lockPath = `${this.storePath}.lock`;
  }

  /**
   * Serialize mutations and corruption recovery. Fail immediately under contention:
   * age cannot prove an owner is dead, so never steal a lock or write without it.
   * A crashed owner's lock requires manual removal after verifying no writer remains.
   */
  private withLock<T>(fn: () => T): T {
    fs.mkdirSync(this.piDir, { recursive: true });
    try {
      fs.mkdirSync(this.lockPath);
    } catch (error) {
      throw new Error("Cannot acquire scheduled prompts lock; refusing mutation or corruption recovery", { cause: error });
    }
    const token = `${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(path.join(this.lockPath, "owner"), token, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      // mkdir succeeded and no callback ran; nobody can acquire this directory.
      try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch { /* fail closed */ }
      throw new Error("Cannot initialize scheduled prompts lock", { cause: error });
    }
    this.holdingLock = true;
    try {
      return fn();
    } finally {
      this.holdingLock = false;
      this.releaseLock(token);
    }
  }

  /** Remove the lock only when it still carries our token (never a peer's takeover). */
  private releaseLock(token: string): void {
    try {
      const owner = fs.readFileSync(path.join(this.lockPath, "owner"), "utf-8");
      if (owner !== token) return;
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // Missing token or no longer ours: never remove another owner's lock.
    }
  }

  /**
   * Load scheduled prompts from disk
   */
  load(): CronStore {
    let data: string;
    try {
      // existsSync hides permission/I/O errors; only a confirmed missing file is empty.
      data = fs.readFileSync(this.storePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], version: 1 };
      throw new Error("Cannot read scheduled prompts; refusing to replace existing data", { cause: error });
    }
    let store: CronStore;
    try {
      store = JSON.parse(data) as CronStore;
    } catch (error) {
      if (!this.holdingLock) return this.withLock(() => this.load());
      this.quarantineCorruptStore(error);
      return { jobs: [], version: 1 };
    }
    if (!store || typeof store !== "object" || !Array.isArray(store.jobs)) {
      if (!this.holdingLock) return this.withLock(() => this.load());
      this.quarantineCorruptStore(new Error("missing jobs array"));
      return { jobs: [], version: 1 };
    }
    const valid = store.jobs.filter(isJobShape);
    if (valid.length !== store.jobs.length) {
      console.error(`Ignoring ${store.jobs.length - valid.length} malformed scheduled prompt entr${store.jobs.length - valid.length === 1 ? "y" : "ies"} in ${this.storePath}`);
      store.jobs = valid;
    }
    return store;
  }

  /** Keep an unreadable store as a side file so the next save cannot silently destroy it. */
  private quarantineCorruptStore(reason: unknown): void {
    const backup = `${this.storePath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      try {
        fs.renameSync(this.storePath, backup);
      } catch (error) {
        // An external editor/older peer may have removed it despite our lock.
        // ENOENT is safe only if the source really is absent, not a replacement.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          fs.statSync(this.storePath);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") return;
          throw missing;
        }
        throw error;
      }
      console.error(`Scheduled prompts file was unreadable (${reason}); moved to ${backup}`);
    } catch (error) {
      throw new Error("Cannot preserve corrupt scheduled prompts; refusing to replace existing data", { cause: error });
    }
  }

  /**
   * Save scheduled prompts to disk
   */
  save(store: CronStore): void {
    if (!this.holdingLock) return this.withLock(() => this.save(store));
    try {
      // Ensure .pi directory exists
      if (!fs.existsSync(this.piDir)) {
        fs.mkdirSync(this.piDir, { recursive: true });
      }

      // Write atomically using a per-process temp file; the lock only serializes
      // read-modify-write, so concurrent writers must never share a temp name.
      const tempPath = `${this.storePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
        for (let attempt = 0; ; attempt++) {
          try {
            fs.renameSync(tempPath, this.storePath);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // Windows reports EPERM/EBUSY while a peer or scanner has the target open.
            if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
            sleepSync(20 * (attempt + 1));
          }
        }
      } catch (error) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // ignore
        }
        throw error;
      }
    } catch (error) {
      console.error("Failed to save scheduled prompts:", error);
      throw error;
    }
  }

  /**
   * Check if a job name already exists
   */
  hasJobWithName(name: string): boolean {
    const store = this.load();
    return store.jobs.some((j) => j.name === name);
  }

  /**
   * Add a new job
   */
  addJob(job: CronJob): void {
    this.withLock(() => {
      const store = this.load();
      store.jobs.push(job);
      this.save(store);
    });
  }

  /**
   * Remove a job by ID
   */
  removeJob(id: string): boolean {
    return this.withLock(() => {
      const store = this.load();
      const initialLength = store.jobs.length;
      store.jobs = store.jobs.filter((j) => j.id !== id);

      if (store.jobs.length < initialLength) {
        this.save(store);
        return true;
      }
      return false;
    });
  }

  /**
   * Update a job by ID
   */
  updateJob(id: string, partial: Partial<CronJob>): boolean {
    return this.withLock(() => {
      const store = this.load();
      const job = store.jobs.find((j) => j.id === id);

      if (job) {
        Object.assign(job, partial);
        this.save(store);
        return true;
      }
      return false;
    });
  }

  /**
   * Compute a partial from the freshly loaded job and apply it in one locked
   * read-modify-write (no stale read-then-write, e.g. for `runCount`).
   */
  updateJobWith(id: string, compute: (current: CronJob) => Partial<CronJob>): boolean {
    return this.withLock(() => {
      const store = this.load();
      const job = store.jobs.find((j) => j.id === id);
      if (!job) return false;
      Object.assign(job, compute(job));
      this.save(store);
      return true;
    });
  }

  /** Re-read under the lock; never expire a deadline a peer has extended/cleared. */
  expireJobIfDue(id: string, sessionId: string | undefined): { job?: CronJob; expired: boolean } {
    return this.withLock(() => {
      const store = this.load();
      const job = store.jobs.find((j) => j.id === id);
      if (!job?.enabled || (job.session && job.session !== sessionId)) return { job, expired: false };
      const state = deadlineState(job.endAt);
      if (state !== "expired" && state !== "invalid") return { job, expired: false };
      job.enabled = false;
      delete job.nextRun;
      this.save(store);
      return { job, expired: true };
    });
  }

  /**
   * Get a single job by ID
   */
  getJob(id: string): CronJob | undefined {
    const store = this.load();
    return store.jobs.find((j) => j.id === id);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): CronJob[] {
    const store = this.load();
    return store.jobs;
  }

  /**
   * Get storage file path
   */
  getStorePath(): string {
    return this.storePath;
  }
}
