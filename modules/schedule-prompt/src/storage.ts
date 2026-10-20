import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CronJob, CronStore } from "./types.js";
import { deadlineState } from "./deadline.js";
import { intervalError, parseInterval } from "./interval.js";
import { jobKindError } from "./command.js";

const RENAME_RETRIES = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function envLockWaitMs(): number {
  const raw = process.env.PI_SCHEDULE_PROMPT_LOCK_WAIT_MS;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1500;
}

/** The lock could not be acquired: nothing was read-modified-written, so callers may safely retry later. */
export class LockUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LockUnavailableError";
  }
}

interface ParsedOwner {
  token: string;
  legacy: boolean; // token-only record from an older version: liveness is unprovable
  pid?: number;
  host?: string;
  pidns?: string;
  procStart?: string;
  startedAt?: string;
}

function parseOwner(text: string): ParsedOwner {
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      if (typeof o.token === "string") {
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        return {
          token: o.token, legacy: false,
          pid: Number.isSafeInteger(o.pid) && (o.pid as number) > 0 ? (o.pid as number) : undefined,
          host: str(o.host), pidns: str(o.pidns), procStart: str(o.procStart), startedAt: str(o.startedAt),
        };
      }
    } catch { /* fall through: unparseable records are treated as legacy (never taken over) */ }
  }
  return { token: text, legacy: true };
}

/** Linux-only identities; undefined elsewhere (Windows/macOS rely on pid + hostname alone). */
function linuxPidNamespace(): string | undefined {
  try { return fs.readlinkSync("/proc/self/ns/pid"); } catch { return undefined; }
}
function linuxProcStart(pid: number | "self"): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22 (starttime), after "pid (comm) "
  } catch { return undefined; }
}

function currentOwner(token: string): ParsedOwner & { pid: number; host: string } {
  return {
    token, legacy: false, pid: process.pid, host: os.hostname(),
    pidns: linuxPidNamespace(), procStart: linuxProcStart("self"),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

/**
 * True only when the record proves the owner is gone: same host, and (same PID namespace when
 * recorded) the pid does not exist or now has a different start time (pid reuse). Everything
 * uncertain (EPERM, unreadable /proc, other host, legacy record) counts as alive.
 * Residual risk: on Windows/macOS a reused pid with no start-time evidence looks alive, which
 * errs toward refusing, never toward stealing.
 */
function ownerProvablyDead(owner: ParsedOwner): boolean {
  if (owner.legacy || owner.pid === undefined || owner.host !== os.hostname()) return false;
  if (owner.pidns !== undefined && owner.pidns !== linuxPidNamespace()) return false;
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const now = owner.procStart !== undefined ? linuxProcStart(owner.pid) : undefined;
  return owner.procStart !== undefined && now !== undefined && now !== owner.procStart;
}

/** Minimum shape every consumer relies on; anything else (null, strings, ...) is dropped on load. */
function isJobShape(value: unknown): value is CronJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const j = value as Record<string, unknown>;
  const optionalString = (key: string) => j[key] === undefined || typeof j[key] === "string";
  const selections = (v: unknown) => v === undefined || typeof v === "boolean" ||
    (Array.isArray(v) && v.every((item) => typeof item === "string"));
  return typeof j.id === "string" && j.id.length > 0 && typeof j.name === "string" &&
    typeof j.schedule === "string" && (j.prompt === undefined || typeof j.prompt === "string") &&
    jobKindError(j as Partial<CronJob>) === undefined &&
    typeof j.enabled === "boolean" && ["cron", "once", "interval"].includes(j.type as string) &&
    (j.intervalMs === undefined || (typeof j.intervalMs === "number" && Number.isFinite(j.intervalMs) && j.intervalMs > 0)) &&
    (j.type !== "interval" || typeof j.intervalMs === "number") &&
    (j.runCount === undefined || (typeof j.runCount === "number" && Number.isSafeInteger(j.runCount) && j.runCount >= 0)) &&
    ["createdAt", "lastRun", "nextRun", "description", "session", "cwd"].every(optionalString) &&
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
  /** Upper bound (ms) on waiting for a contended lock; `PI_SCHEDULE_PROMPT_LOCK_WAIT_MS` overrides (tests use 0). */
  static lockWaitMs = envLockWaitMs();

  constructor(cwd: string) {
    this.piDir = path.join(cwd, ".pi");
    this.storePath = path.join(this.piDir, "schedule-prompts.json");
    this.lockPath = `${this.storePath}.lock`;
  }

  /**
   * Serialize mutations and corruption recovery. Short contention (a peer's read-modify-write
   * takes milliseconds) is absorbed by a bounded retry with jitter (`lockWaitMs`). The wait is a
   * synchronous `Atomics.wait` sleep (no CPU spin) because the whole storage API is synchronous
   * and called from timers/tools; holders keep the lock for milliseconds, so the event loop is
   * blocked only for the contention itself and never longer than `lockWaitMs`.
   *
   * Age never proves an owner is dead. A lock is taken over only when its owner record proves
   * (same host and PID namespace, PID absent or start time mismatched) that the owner is gone;
   * anything else (live owner, other host, legacy/ownerless lock) is refused with guidance, and no
   * write ever proceeds without the lock.
   */
  private withLock<T>(fn: () => T): T {
    fs.mkdirSync(this.piDir, { recursive: true });
    const deadline = performance.now() + Math.max(0, CronStorage.lockWaitMs);
    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      try {
        fs.mkdirSync(this.lockPath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows reports EPERM/EACCES/EBUSY while a just-released lock directory is still being deleted.
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
          throw new LockUnavailableError(`Cannot acquire scheduled prompts lock; refusing mutation or corruption recovery (${this.lockPath})`, { cause: error });
        }
        failure = error;
      }
      if (this.tryTakeOverStaleLock()) continue;
      if (performance.now() >= deadline) {
        throw new LockUnavailableError(`Cannot acquire scheduled prompts lock; refusing mutation or corruption recovery. ${this.describeLockHolder()}`, { cause: failure });
      }
      sleepSync(Math.min(5 + attempt * 5, 50) + Math.random() * 25);
    }
    const token = `${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(path.join(this.lockPath, "owner"), JSON.stringify(currentOwner(token)), { encoding: "utf-8", flag: "wx" });
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

  private readOwner(dir = this.lockPath): ParsedOwner | undefined {
    try {
      return parseOwner(fs.readFileSync(path.join(dir, "owner"), "utf-8"));
    } catch {
      return undefined;
    }
  }

  /** Human-readable reason the lock is held plus repair guidance (never removes anything). */
  private describeLockHolder(): string {
    const owner = this.readOwner();
    const repair = `If no pi process is using this project, remove ${this.lockPath} manually.`;
    if (!owner) return `Lock ${this.lockPath} has no readable owner record. ${repair}`;
    if (!owner.legacy && owner.pid !== undefined) {
      const where = owner.host === os.hostname() ? "this host" : `host ${owner.host ?? "unknown"}`;
      if (ownerProvablyDead(owner)) return `Lock ${this.lockPath} is stale but could not be taken over yet (owner pid ${owner.pid} on ${where}); retry.`;
      return `Lock ${this.lockPath} is held by pid ${owner.pid} on ${where}${owner.host === os.hostname() ? "" : " (cannot verify liveness across hosts)"}. ${owner.host === os.hostname() ? "Retry shortly." : repair}`;
    }
    return `Lock ${this.lockPath} has a legacy owner record without process identity; its liveness cannot be proven. ${repair}`;
  }

  /**
   * Take over a lock only when its recorded owner is provably dead on this host. Takeovers are
   * serialized by a `.takeover` mutex directory, and the stale directory is moved to a unique
   * name with an atomic rename before deletion, so two waiters can never both take over.
   * Returns true when the lock path was freed (caller retries mkdir).
   */
  private tryTakeOverStaleLock(): boolean {
    const owner = this.readOwner();
    if (!owner || owner.legacy || !ownerProvablyDead(owner)) return false;
    const mutex = `${this.lockPath}.takeover`;
    try {
      fs.mkdirSync(mutex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") this.clearDeadTakeoverMutex(mutex);
      return false; // another waiter is taking over; our retry loop re-evaluates
    }
    try {
      fs.writeFileSync(path.join(mutex, "owner"), JSON.stringify(currentOwner(`takeover.${process.pid}`)), "utf-8");
      const again = this.readOwner();
      if (!again || again.token !== owner.token) return false; // already recovered or replaced by a live owner
      const graveyard = `${this.lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
      try {
        fs.renameSync(this.lockPath, graveyard);
      } catch {
        return false; // lost the race or sharing violation: never fall back to a non-atomic delete
      }
      const moved = this.readOwner(graveyard);
      if (moved?.token !== owner.token) {
        // A different lock was moved (only possible after a crash inside this very section): put it back.
        try { fs.renameSync(graveyard, this.lockPath); } catch (error) {
          console.error(`Scheduled prompts lock ${this.lockPath} was displaced while recovering; preserved at ${graveyard}:`, error);
        }
        return false;
      }
      try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch (error) {
        console.error(`Could not delete stale scheduled prompts lock copy ${graveyard}:`, error);
      }
      console.warn(`Took over stale scheduled prompts lock ${this.lockPath}: owner pid ${owner.pid} on ${owner.host} (started ${owner.startedAt ?? "unknown"}) no longer exists`);
      return true;
    } finally {
      try { fs.rmSync(mutex, { recursive: true, force: true }); } catch { /* a leftover mutex is cleared once its owner is provably dead */ }
    }
  }

  /** A takeover mutex left by a crashed taker is cleared only on the same proof as the main lock. */
  private clearDeadTakeoverMutex(mutex: string): void {
    const holder = this.readOwner(mutex);
    if (!holder || holder.legacy || !ownerProvablyDead(holder)) return;
    try { fs.rmSync(mutex, { recursive: true, force: true }); } catch { /* retry on the next pass */ }
  }

  /** Remove the lock only when it still carries our token (never a peer's takeover). */
  private releaseLock(token: string): void {
    let owner: ParsedOwner;
    try {
      owner = parseOwner(fs.readFileSync(path.join(this.lockPath, "owner"), "utf-8"));
    } catch {
      return; // Missing token or no longer ours: never remove another owner's lock.
    }
    if (owner.token !== token) return;
    // A scanner can briefly hold the just-written owner file; an unreleased lock blocks every later mutation.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(this.lockPath, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt < RENAME_RETRIES && (code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY")) {
          sleepSync(20 * (attempt + 1));
          continue;
        }
        console.error(`Could not release scheduled prompts lock ${this.lockPath}; later changes fail until it is removed:`, error);
        return;
      }
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
    const valid = store.jobs.filter(isJobShape).filter(job => {
      if (job.type !== "interval") return true;
      const error = intervalError(job.schedule, job.intervalMs!);
      if (error) { console.error(`Ignoring scheduled prompt ${job.id}: ${error}`); return false; }
      job.intervalMs = parseInterval(job.schedule)!;
      return true;
    });
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
  updateJobWith(id: string, compute: (current: CronJob) => Partial<CronJob> | undefined): boolean {
    return this.withLock(() => {
      const store = this.load();
      const job = store.jobs.find((j) => j.id === id);
      if (!job) return false;
      const partial = compute(job);
      if (partial === undefined) return false; // conditional mutation rejected: preserve peer bytes
      Object.assign(job, partial);
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

  /** One locked snapshot/mutation; a peer's enabled or foreign jobs are never swept. */
  removeDisabledJobs(sessionId: string | undefined): CronJob[] {
    return this.withLock(() => {
      const store = this.load();
      const removed: CronJob[] = [];
      store.jobs = store.jobs.filter(job => {
        if (job.enabled || (job.session && job.session !== sessionId)) return true;
        removed.push(job);
        return false;
      });
      if (removed.length) this.save(store);
      return removed;
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
