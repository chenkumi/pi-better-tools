import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { deadlineState, normalizeEndAt } from "./deadline.js";
import type { CronStorage } from "./storage.js";
import { isProjectTrusted } from "./trust.js";
import { runSubagentOnce, type SubagentResult } from "./subagent.js";
import type { CronChangeEvent, CronJob, CronJobType } from "./types.js";

/** Result of `CronScheduler.validateSchedule`. On success, `schedule` is the
 *  resolved form to persist (ISO for `once`, original for `cron`/`interval`). */
type ValidateScheduleResult =
  | { ok: true; schedule: string; intervalMs?: number }
  | { ok: false; error: string };

const SUBAGENT_OUTPUT_SNIPPET_LENGTH = 500;

/** Node clamps timer delays above 2^31-1 ms (~24.8 days) to 1 ms, which turns a long interval into a flood. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** In-process subagent runs allowed at once; extra ticks are skipped rather than queued. */
export const MAX_CONCURRENT_SUBAGENTS = 4;
/** Re-evaluate wall-clock deadlines even after a clock adjustment. */
export const DEADLINE_RECHECK_MS = 60_000;

/** Truncate `text` to `SUBAGENT_OUTPUT_SNIPPET_LENGTH`, appending an ellipsis if cut. */
function snippet(text: string): string {
  return text.length > SUBAGENT_OUTPUT_SNIPPET_LENGTH
    ? text.slice(0, SUBAGENT_OUTPUT_SNIPPET_LENGTH) + "…"
    : text;
}

/**
 * Manages cron job scheduling and execution
 */
export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private deadlines = new Map<string, NodeJS.Timeout>();
  /** Local timer bookkeeping so getNextRun can answer for interval/once jobs (epoch ms). */
  private intervalStarts = new Map<string, { start: number; ms: number }>();
  private onceTargets = new Map<string, number>();
  private activeSubagents = new Set<AbortController>();
  /** Model jobs with a run in flight: a slow run must not be overlapped by its next tick. */
  private runningSubagentJobs = new Set<string>();
  /** Exception only for this scheduler's once auto-disable during an admitted run. */
  private autoDisabledOnceJobs = new Set<string>();
  /** Admission is closed by stop(); reopened only by an explicit start(). */
  private closed = false;
  /** Accepted child runs (initializing or running) that shutdown must drain. */
  private childRuns = new Set<Promise<void>>();
  /** Children whose awaited session_shutdown/dispose did not succeed; kept so the failure is never silently lost. */
  private cleanupFailures: Array<{ jobId: string; error: string }> = [];
  private readonly storage: CronStorage;
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;

  constructor(storage: CronStorage, pi: ExtensionAPI, ctx: ExtensionContext) {
    this.storage = storage;
    this.pi = pi;
    this.ctx = ctx;
  }

  /**
   * Schedule all enabled jobs loaded for this session — see `isLoadedFor`.
   * Foreign-session jobs are skipped so two pis in the same cwd don't double-fire.
   *
   * Also clears stale `lastStatus: "running"` from an interrupted prior run of
   * *this* session (process kill, abort) — otherwise the widget sticks on `⟳`
   * until the cron next fires. Other sessions' (and unbound jobs') flags are theirs to manage.
   */
  start(): void {
    // Project jobs are only admitted for a trusted project; no timers otherwise.
    if (!isProjectTrusted(this.ctx)) return;
    this.closed = false;
    const mySessionId = this.ctx.sessionManager.getSessionId();
    for (const job of this.storage.getAllJobs()) {
      if (!CronScheduler.isLoadedFor(job, mySessionId)) continue;
      // Only our own session's flag: an unbound job (no `session`) may be mid-run in
      // another process, and clearing it would hide that run.
      if (job.lastStatus === "running" && job.session && job.session === mySessionId) {
        this.storage.updateJob(job.id, { lastStatus: undefined });
      }
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /** Unbound jobs (no `session` field) load for everyone. */
  static isLoadedFor(job: CronJob, sessionId: string | undefined): boolean {
    return !job.session || job.session === sessionId;
  }

  /**
   * Stop all scheduled jobs
   */
  stop(): void {
    // Stop admission first: a timer callback already queued must not start new work.
    this.closed = true;
    // Stop all cron jobs
    for (const cron of this.jobs.values()) {
      cron.stop();
    }
    this.jobs.clear();

    // Clear all intervals
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    this.intervalStarts.clear();
    this.onceTargets.clear();

    // Abort any in-flight subagent runs so they don't keep streaming or post
    // markers against a stale pi reference after session shutdown.
    for (const controller of this.activeSubagents) {
      controller.abort();
    }
    this.activeSubagents.clear();
    this.runningSubagentJobs.clear();
    this.autoDisabledOnceJobs.clear();
  }

  /**
   * Wait for accepted child runs (initializing or running; stop() already aborted them) to finish their
   * awaited teardown. Bounded so a wedged child cannot block host shutdown; whatever is still pending or
   * failed to clean up is reported and kept in `cleanupFailures` rather than treated as confirmed.
   */
  async drain(timeoutMs = 10_000): Promise<{ pending: number; cleanupFailures: Array<{ jobId: string; error: string }> }> {
    const pending = [...this.childRuns];
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    const stillPending = this.childRuns.size;
    if (stillPending > 0) {
      this.cleanupFailures.push({ jobId: "*", error: `${stillPending} child run(s) did not finish cleanup within ${timeoutMs}ms` });
    }
    return { pending: stillPending, cleanupFailures: [...this.cleanupFailures] };
  }

  getCleanupFailures(): ReadonlyArray<{ jobId: string; error: string }> {
    return this.cleanupFailures;
  }

  /**
   * Add and schedule a new job
   */
  addJob(job: CronJob): void {
    this.autoDisabledOnceJobs.delete(job.id);
    if (job.enabled) {
      this.scheduleJob(job);
    }
    this.emitChange({ type: "add", job });
  }

  /**
   * Remove and unschedule a job
   */
  removeJob(id: string): void {
    this.autoDisabledOnceJobs.delete(id);
    this.unscheduleJob(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  /**
   * Update a job (reschedule if needed)
   */
  updateJob(id: string, updated: CronJob): void {
    this.autoDisabledOnceJobs.delete(id);
    this.unscheduleJob(id);
    if (updated.enabled) {
      this.scheduleJob(updated);
    }
    this.emitChange({ type: "update", job: updated });
  }

  /**
   * Get next run time for a job (cron, interval and once). Pass `knownJob` to
   * avoid a storage read (e.g. from a render path that already holds the job).
   */
  getNextRun(jobId: string, knownJob?: CronJob): Date | null {
    let next: Date | null = null;
    const cron = this.jobs.get(jobId);
    if (cron) {
      next = cron.nextRun() ?? null;
    } else if (this.intervals.has(jobId)) {
      const iv = this.intervalStarts.get(jobId);
      const once = this.onceTargets.get(jobId);
      if (iv) {
        const elapsed = Math.max(0, Date.now() - iv.start);
        next = new Date(iv.start + (Math.floor(elapsed / iv.ms) + 1) * iv.ms);
      } else if (once !== undefined) {
        next = new Date(once);
      }
    }
    if (!next) return null;
    const job = knownJob ?? this.storage.getJob(jobId);
    if (!job?.enabled) return null;
    const state = deadlineState(job.endAt);
    if (state === "invalid" || state === "expired") return null;
    if (job.endAt !== undefined && next.getTime() >= Date.parse(normalizeEndAt(job.endAt))) return null;
    return next;
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(job: CronJob): void {
    try {
      if (!CronScheduler.isLoadedFor(job, this.ctx.sessionManager.getSessionId())) return;
      if (!this.checkDeadline(job)) return;
      if (job.type === "interval" && job.intervalMs) {
        if (!(job.intervalMs <= MAX_TIMER_MS)) {
          throw new Error(`Interval ${job.intervalMs}ms exceeds the ${MAX_TIMER_MS}ms timer limit`);
        }
        // Interval-based scheduling
        const interval = setInterval(() => {
          void this.fire(job);
        }, job.intervalMs);
        this.intervals.set(job.id, interval);
        this.intervalStarts.set(job.id, { start: Date.now(), ms: job.intervalMs });
      } else if (job.type === "once") {
        // One-shot execution at a specific time
        const targetDate = new Date(job.schedule);
        const delay = targetDate.getTime() - Date.now();

        if (delay > 0) {
          this.armOnce(job, targetDate.getTime());
        } else {
          // Job is in the past - disable it and log warning
          console.warn(`Job ${job.id} (${job.name}) scheduled for past time: ${job.schedule}`);
          this.storage.updateJob(job.id, { 
            enabled: false,
            lastStatus: "error" 
          });
          this.emitChange({ 
            type: "error", 
            jobId: job.id, 
            error: `Scheduled time ${job.schedule} is in the past` 
          });
        }
      } else {
        // Standard cron expression
        const cron = new Cron(job.schedule, () => {
          void this.fire(job);
        });
        this.jobs.set(job.id, cron);
      }
      if (this.storage.getJob(job.id)?.enabled) this.armDeadline(job);
    } catch (error) {
      this.unscheduleJob(job.id);
      console.error(`Failed to schedule job ${job.id}:`, error);
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Arm a one-shot timer, re-arming in <=MAX_TIMER_MS hops so far-future jobs do not fire early. */
  private armOnce(job: CronJob, targetMs: number): void {
    this.onceTargets.set(job.id, targetMs);
    const remaining = targetMs - Date.now();
    const timeout = setTimeout(
      () => {
        if (targetMs - Date.now() > 1000) {
          this.armOnce(job, targetMs);
          return;
        }
        this.intervals.delete(job.id);
        void this.fire(job).then((fired) => {
          if (!fired) {
            this.handleSkippedOnce(job);
            return;
          }
          // Auto-disable one-shot jobs after execution
          try {
            this.storage.updateJob(job.id, { enabled: false });
            if (this.runningSubagentJobs.has(job.id)) this.autoDisabledOnceJobs.add(job.id);
            this.unscheduleJob(job.id);
            this.emitChange({ type: "update", job: { ...job, enabled: false } });
          } catch (error) {
            console.error(`Failed to disable one-shot job ${job.id}:`, error);
          }
        });
      },
      Math.min(Math.max(remaining, 0), MAX_TIMER_MS),
    );
    // Stored with the intervals for cleanup purposes
    this.intervals.set(job.id, timeout as any);
  }

  /** A false once fire is terminal: disable/error, never silently lose it or retry indefinitely. */
  private handleSkippedOnce(job: CronJob): void {
    try {
      if (this.intervals.has(job.id)) return; // an update already installed a replacement timer
      const fresh = this.storage.getJob(job.id);
      if (!fresh?.enabled || !CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId())) {
        this.unscheduleJob(job.id);
        return;
      }
      if (!this.checkDeadline(fresh)) return; // expiration preserves execution status
      this.unscheduleJob(job.id);
      this.storage.updateJob(job.id, { enabled: false, lastStatus: "error", nextRun: undefined });
      this.emitChange({ type: "error", jobId: job.id, error: "One-shot delivery skipped or failed; job disabled (no retry)" });
      this.emitChange({ type: "update", job: { ...fresh, enabled: false, lastStatus: "error", nextRun: undefined } });
    } catch (error) {
      this.unscheduleJob(job.id); // persistence failure must still stop local scheduling
      console.error(`Failed to handle skipped one-shot job ${job.id}:`, error);
      try {
        this.emitChange({ type: "error", jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      } catch { /* listeners must not reject a timer continuation */ }
    }
  }

  /**
   * Timer entry point. Timers have no caller to catch a rejection, and an escaped
   * error here (e.g. a storage write failure) would take the host process down.
   */
  private async fire(job: CronJob): Promise<boolean> {
    try {
      return await this.executeJob(job);
    } catch (error) {
      console.error(`Scheduled job ${job.id} failed:`, error);
      try {
        this.emitChange({
          type: "error",
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // event listeners must not re-escape
      }
      return false;
    }
  }

  /** No expired/invalid deadline can reach a new delivery, even if timers are delayed. */
  private checkDeadline(job: CronJob): boolean {
    const state = deadlineState(job.endAt);
    if (state === "none" || state === "active") return true;
    this.unscheduleJob(job.id);
    try {
      const result = this.storage.expireJobIfDue(job.id, this.ctx.sessionManager.getSessionId());
      if (result.expired && result.job) {
        if (state === "invalid") this.emitChange({ type: "error", jobId: job.id, error: "Invalid endAt; job disabled" });
        this.emitChange({ type: "update", job: result.job });
      } else if (result.job?.enabled && CronScheduler.isLoadedFor(result.job, this.ctx.sessionManager.getSessionId())) {
        // A peer changed the deadline while we acquired the lock. Skip this tick
        // but rebuild local resources for its latest deadline/schedule.
        this.scheduleJob(result.job);
      }
    } catch (error) {
      console.error(`Failed to expire scheduled job ${job.id}:`, error);
      try {
        this.emitChange({ type: "error", jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      } catch { /* a listener must not escape a timer callback */ }
    }
    return false;
  }

  private armDeadline(job: CronJob): void {
    const previous = this.deadlines.get(job.id);
    if (previous) clearTimeout(previous);
    this.deadlines.delete(job.id);
    if (job.endAt === undefined) return;
    const delay = Math.min(DEADLINE_RECHECK_MS, MAX_TIMER_MS,
      Math.max(0, Date.parse(normalizeEndAt(job.endAt)) - Date.now()));
    const timer = setTimeout(() => {
      if (this.deadlines.get(job.id) !== timer) return;
      this.deadlines.delete(job.id);
      try {
        const fresh = this.storage.getJob(job.id);
        if (!fresh?.enabled || !CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId())) {
          this.unscheduleJob(job.id);
          return;
        }
        if (this.checkDeadline(fresh)) this.armDeadline(fresh);
      } catch (error) {
        this.unscheduleJob(job.id);
        console.error(`Deadline callback failed for ${job.id}:`, error);
        try {
          this.emitChange({ type: "error", jobId: job.id, error: error instanceof Error ? error.message : String(error) });
        } catch { /* timer callback must never throw */ }
      }
    }, delay);
    this.deadlines.set(job.id, timer);
  }

  /** Synchronous writes/listeners/markers can consume the remaining deadline. */
  private readyAfterPreparation(job: CronJob, previousStatus: CronJob["lastStatus"]): boolean {
    const fresh = this.storage.getJob(job.id);
    if (fresh?.enabled && CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId()) && this.checkDeadline(fresh)) return true;
    const latest = this.storage.getJob(job.id);
    if (latest?.lastStatus === "running") this.storage.updateJob(job.id, { lastStatus: previousStatus });
    return false;
  }

  /**
   * Unschedule a job
   */
  private unscheduleJob(id: string): void {
    const deadline = this.deadlines.get(id);
    if (deadline) clearTimeout(deadline);
    this.deadlines.delete(id);
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }

    this.intervalStarts.delete(id);
    this.onceTargets.delete(id);
    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }

  /**
   * Execute a job's prompt
   */
  private async executeJob(scheduled: CronJob): Promise<boolean> {
    // Re-read before firing — closure-captured `job` is stale if storage was
    // edited mid-tick (removed, disabled, or `session` rebound by hand-edit).
    // Fire with the fresh copy so hand-edited prompt/model apply too.
    if (this.closed || !isProjectTrusted(this.ctx)) return false;
    const fresh = this.storage.getJob(scheduled.id);
    if (!fresh?.enabled) return false;
    if (!CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId())) return false;
    const job = fresh;
    if (!this.checkDeadline(job)) return false;

    console.log(`Executing scheduled prompt: ${job.name} (${job.id})`);

    if (job.model) {
      return this.executeJobInSubagent(job);
    }

    const previousStatus = job.lastStatus;
    try {
      // Update status to running
      this.storage.updateJob(job.id, {
        lastStatus: "running",
      });
      this.emitChange({ type: "fire", job });

      if (!this.readyAfterPreparation(job, previousStatus)) return false;

      // Visible-only marker. The renderer reads from `details`, so `content`
      // is intentionally empty — putting the prompt text in `content` would
      // inject it into the LLM context a second time alongside the
      // `sendUserMessage` delivery below, producing duplicate turns /
      // "PROMPT\n\nPROMPT" rendering when the agent was streaming at fire
      // time. No options means: idle → silent append + emit (marker shows
      // before the user message in the chat), streaming → `agent.steer` with
      // empty content (no LLM context change, no extra turn triggered).
      this.pi.sendMessage({
        customType: "scheduled_prompt",
        content: [],
        display: true,
        details: { jobId: job.id, jobName: job.name, prompt: job.prompt },
      });

      // Then send the actual prompt to the agent — this is the single LLM-visible delivery.
      if (!this.readyAfterPreparation(job, previousStatus)) return false;
      this.pi.sendUserMessage(job.prompt, { deliverAs: "followUp" });

      // Increment the freshly read counter within the same locked mutation,
      // so another session's completed run cannot be overwritten.
      const nextRun = this.getNextRun(job.id);
      this.storage.updateJobWith(job.id, (latest) => ({
        lastRun: new Date().toISOString(),
        lastStatus: "success",
        runCount: (latest.runCount ?? job.runCount ?? 0) + 1,
        nextRun: nextRun?.toISOString(),
      }));

      this.emitChange({ type: "fire", job });
      return true;
    } catch (error) {
      console.error(`Failed to execute job ${job.id}:`, error);
      this.storage.updateJob(job.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "error",
      });
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Run a job's prompt in a fresh in-process AgentSession with the chosen model.
   * Fire-and-forget: the cron tick returns immediately so other jobs keep firing.
   */
  private executeJobInSubagent(job: CronJob): boolean {
    if (this.runningSubagentJobs.has(job.id)) {
      console.warn(`Skipping job ${job.id} (${job.name}): previous run is still in progress`);
      return false;
    }
    if (this.activeSubagents.size >= MAX_CONCURRENT_SUBAGENTS) {
      console.warn(`Skipping job ${job.id} (${job.name}): ${MAX_CONCURRENT_SUBAGENTS} subagent runs already active`);
      this.emitChange({ type: "error", jobId: job.id, error: "Skipped: too many scheduled subagent runs active" });
      return false;
    }
    const model = job.model!;
    const notify = job.notify === true;
    const previousStatus = job.lastStatus;
    this.storage.updateJob(job.id, { lastStatus: "running" });
    this.emitChange({ type: "fire", job });
    if (!this.readyAfterPreparation(job, previousStatus)) return false;

    // Start marker needs non-empty content to prevent session poisoning.
    // Pi-ai's openai-completions provider filters out user messages with
    // empty content — if the marker lands right after an assistant message,
    // the conversation ends on assistant and Anthropic 400s.
    this.pi.sendMessage({
      customType: "scheduled_prompt",
      content: [{ type: "text", text: `🕐 Scheduled (subagent: ${model}): ${job.name}` }],
      display: true,
      details: {
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        mode: "subagent_start",
        model,
      },
    });

    if (!this.readyAfterPreparation(job, previousStatus)) return false;
    const controller = new AbortController();
    this.activeSubagents.add(controller);
    this.runningSubagentJobs.add(job.id);

    const run = (async () => {
      try {
        let result: SubagentResult;
        try {
          result = await runSubagentOnce(this.ctx, job.prompt, model, controller.signal,
            { extensions: job.extensions, skills: job.skills }, () => {
              if (controller.signal.aborted) return false;
              const fresh = this.storage.getJob(job.id);
              // Do not turn a disabled recurring job back into admitted work
              // after its deadline is cleared/extended. Only our own once
              // auto-disable can retain the earlier admission.
              const admittedOnce = job.type === "once" && fresh?.type === "once" && this.autoDisabledOnceJobs.has(job.id);
              return !!fresh && (fresh.enabled || admittedOnce) &&
                CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId()) && this.checkDeadline(fresh);
            });
          if (result.cleanupError) {
            this.cleanupFailures.push({ jobId: job.id, error: result.cleanupError });
            console.error(`Scheduled child cleanup unconfirmed for job ${job.id}: ${result.cleanupError}`);
          }
        } finally {
          this.activeSubagents.delete(controller);
          this.runningSubagentJobs.delete(job.id);
          this.autoDisabledOnceJobs.delete(job.id);
        }

        // Scheduler was stopped (session shutdown / switch / fork) while we were
        // running. Don't touch storage or post markers — pi may be invalidated.
        if (controller.signal.aborted) return;

        if (!result.ok && result.skipped) {
          const latest = this.storage.getJob(job.id);
          if (latest && CronScheduler.isLoadedFor(latest, this.ctx.sessionManager.getSessionId())) {
            if (latest.lastStatus === "running") this.storage.updateJob(job.id, { lastStatus: previousStatus });
            this.emitChange({ type: "update", job: this.storage.getJob(job.id) });
          }
          // Initialization was admitted, but no prompt ran. Do not increment
          // stats, report an execution error, or wake the parent via notify.
          this.pi.sendMessage({ customType: "scheduled_prompt", display: true,
            content: [{ type: "text", text: result.error }],
            details: { jobId: job.id, jobName: job.name, prompt: job.prompt, mode: "subagent_done", skipped: true, model, output: result.error } });
          return;
        }
        const nextRun = this.getNextRun(job.id);

        // Always advance the storage state to a terminal status BEFORE attempting
        // to post the marker. The marker is best-effort (pi may be invalidated
        // during teardown) and must never leave the job stuck in "running".
        if (result.ok) {
          const outputSnippet = snippet(result.text.trim()) || "(subagent produced no text output)";
          // Re-read runCount from storage; `job` here is the closure-captured
          // snapshot from scheduleJob and would yield a stale count.
          this.storage.updateJobWith(job.id, (latest) => ({
            lastRun: new Date().toISOString(),
            lastStatus: "success",
            runCount: (latest.runCount ?? job.runCount ?? 0) + 1,
            nextRun: nextRun?.toISOString(),
          }));
          this.emitChange({ type: "fire", job });
          try {
            // notify=true: snippet in `content` + followUp/triggerTurn wakes
            // the parent — it sees the result and reacts.
            // notify=false: content is still non-empty (guarded by #10 fallback)
            // to prevent session poisoning — pi-ai filters empty user messages,
            // leaving the conversation ending on assistant which Anthropic 400s.
            // No delivery options means the marker is silent (parent not woken).
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [{ type: "text", text: outputSnippet }],
                display: true,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_done",
                  model,
                  ...(notify && { notify: true }),
                  output: outputSnippet,
                },
              },
              notify ? { deliverAs: "followUp", triggerTurn: true } : undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_done marker for job ${job.id}:`, markerErr);
          }
        } else {
          // Truncate the error the same way as the success snippet — verbose
          // API errors / stack traces would otherwise overflow the chat row.
          const errorSnippet = snippet(result.error.trim()) || "(subagent failed with empty error)";
          this.storage.updateJob(job.id, {
            lastRun: new Date().toISOString(),
            lastStatus: "error",
            nextRun: nextRun?.toISOString(),
          });
          this.emitChange({ type: "error", jobId: job.id, error: errorSnippet });
          try {
            // Same notify-gated wake-up as the done marker — see comment above.
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [{ type: "text", text: errorSnippet }],
                display: true,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_error",
                  model,
                  ...(notify && { notify: true }),
                  error: errorSnippet,
                },
              },
              notify ? { deliverAs: "followUp", triggerTurn: true } : undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_error marker for job ${job.id}:`, markerErr);
          }
        }
      } catch (error) {
        // Outer backstop: anything else (e.g. storage write failure) shouldn't
        // escape the IIFE as an unhandled rejection.
        console.error(`Subagent completion handler failed for job ${job.id}:`, error);
      }
    })();
    this.childRuns.add(run);
    void run.finally(() => this.childRuns.delete(run));
    return true;
  }

  /**
   * Emit a change event via pi.events
   */
  private emitChange(event: CronChangeEvent): void {
    this.pi.events.emit("cron:change", event);
  }

  /**
   * Validate a cron expression (must be 6-field format with seconds)
   */
  static validateCronExpression(expression: string): { valid: boolean; error?: string } {
    // Count fields - must be 6 (second minute hour dom month dow)
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron expression must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 * * * * *" for every minute`,
      };
    }

    try {
      // Try parsing as cron expression
      // Without a callback Croner parses only; validation owns no timer.
      new Cron(expression);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid cron expression",
      };
    }
  }

  /**
   * Parse relative time delta (e.g., "+10s", "+5m", "+1h")
   * Returns ISO timestamp if valid, null otherwise
   */
  static parseRelativeTime(delta: string): string | null {
    const match = delta.match(/^\+(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    if (value <= 0) return null;
    const msMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const ms = value * msMap[unit];
    const futureTime = new Date(Date.now() + ms);
    // Beyond the Date range toISOString would throw a bare RangeError.
    if (!Number.isFinite(ms) || Number.isNaN(futureTime.getTime())) return null;
    return futureTime.toISOString();
  }

  /**
   * Parse interval string to milliseconds
   */
  static parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  }

  /**
   * Validate and resolve a schedule string for the given type.
   * Single source of truth shared by tool `add`/`update` and the UI command.
   *
   * - `cron`: validates the 6-field expression
   * - `once`: accepts ISO timestamps and relative time (`+10s`); rejects `+0s`,
   *   out-of-range relative values, past
   *   timestamps and ones <5s away. Note: a date-only string such as `2026-01-01`
   *   is parsed as UTC midnight (JS `Date` semantics), whereas a date-time without
   *   a zone is local time; prefer an explicit `Z`/`+-HH:mm` offset (the agent should use relative time instead)
   * - `interval`: accepts duration strings (`5m`, `1h`, `30s`)
   */
  static validateSchedule(type: CronJobType, schedule: string): ValidateScheduleResult {
    if (type === "interval") {
      const intervalMs = CronScheduler.parseInterval(schedule);
      if (!intervalMs) {
        return {
          ok: false,
          error: `Invalid interval format: ${schedule}. Use format like '5m', '1h', '30s'`,
        };
      }
      if (intervalMs > MAX_TIMER_MS) {
        return {
          ok: false,
          error: `Interval too long: ${schedule}. The maximum is ${Math.floor(MAX_TIMER_MS / 86_400_000)}d; use a cron expression or a one-shot time for longer waits`,
        };
      }
      return { ok: true, schedule, intervalMs };
    }

    if (type === "once") {
      const relativeShape = schedule.match(/^\+(\d+)(s|m|h|d)$/);
      if (relativeShape && parseInt(relativeShape[1], 10) <= 0) {
        return { ok: false, error: `Relative time must be greater than zero: ${schedule}. Use at least '+1s'` };
      }
      if (relativeShape && !CronScheduler.parseRelativeTime(schedule)) {
        return { ok: false, error: `Relative time too far in the future: ${schedule}. Use a smaller value or an ISO timestamp` };
      }
      const relative = CronScheduler.parseRelativeTime(schedule);
      if (relative) return { ok: true, schedule: relative };

      const date = new Date(schedule);
      if (Number.isNaN(date.getTime())) {
        return {
          ok: false,
          error: `Invalid timestamp: ${schedule}. Use ISO format or relative time like '+10s', '+5m'`,
        };
      }
      const delay = date.getTime() - Date.now();
      if (delay < 0) {
        return {
          ok: false,
          error: `Timestamp is in the past: ${date.toISOString()}. Current time: ${new Date().toISOString()}`,
        };
      }
      if (delay < 5000) {
        return {
          ok: false,
          error: `Timestamp is too soon (${Math.round(delay / 1000)}s). For delays under 5s, use relative time like '+${Math.ceil(delay / 1000)}s' instead, or schedule at least 5s in the future.`,
        };
      }
      return { ok: true, schedule: date.toISOString() };
    }

    // cron
    const validation = CronScheduler.validateCronExpression(schedule);
    if (!validation.valid) {
      return { ok: false, error: `Invalid cron expression: ${validation.error}` };
    }
    return { ok: true, schedule };
  }

  /**
   * Render a resolved schedule as a short human-readable phrase.
   * Used for confirm dialogs and the widget. `schedule` is the resolved form
   * returned by `validateSchedule` (ISO for `once`).
   */
  static describeSchedule(type: CronJobType, schedule: string): string {
    if (type === "interval") return `every ${schedule}`;
    if (type === "once") {
      const date = new Date(schedule);
      return Number.isNaN(date.getTime()) ? schedule : formatISOShort(date);
    }
    return humanizeCron(schedule);
  }
}

const HUMANIZED_CRON: Record<string, string> = {
  "* * * * * *": "every second",
  "0 * * * * *": "every minute",
  "0 */5 * * * *": "every 5 min",
  "0 */10 * * * *": "every 10 min",
  "0 */15 * * * *": "every 15 min",
  "0 */30 * * * *": "every 30 min",
  "0 0 * * * *": "every hour",
  "0 0 */2 * * *": "every 2 hours",
  "0 0 */3 * * *": "every 3 hours",
  "0 0 */6 * * *": "every 6 hours",
  "0 0 0 * * *": "daily",
  "0 0 0 * * 0": "weekly",
  "0 0 0 1 * *": "monthly",
  "0 0 9 * * 1-5": "9am weekdays",
  "0 0 0 * * 1-5": "weekdays",
  "0 0 0 * * 0,6": "weekends",
};

/** Human-readable form of a 6-field cron expression for common patterns.
 *  Falls back to the raw expression for anything not recognized — never
 *  guesses a wrong description. Callers truncate for column-width displays. */
export function humanizeCron(expression: string): string {
  const normalized = expression.trim();
  if (HUMANIZED_CRON[normalized]) return HUMANIZED_CRON[normalized];

  const minMatch = normalized.match(/^0 \*\/(\d+) \* \* \* \*$/);
  if (minMatch) return `every ${minMatch[1]} min`;

  const hourMatch = normalized.match(/^0 0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) return `every ${hourMatch[1]}h`;

  const timeMatch = normalized.match(/^0 0 (\d+) \* \* \*$/);
  if (timeMatch) return `daily at ${parseInt(timeMatch[1], 10)}:00`;

  return normalized;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact ISO timestamp render: "Feb 13 15:30". Returns the input unchanged
 *  if it doesn't parse as a date. */
export function formatISOShort(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}
