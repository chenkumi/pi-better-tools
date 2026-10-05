import { ulid } from "ulid";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { previewNextRuns, scheduleTiming, type CronEngineClock, type ScheduledTimer } from "./cron-engine.js";
import { isTerminalRunStatus, type Run, type Schedule } from "./domain.js";
import { acquireAdvisoryLock } from "./locking.js";
import { PiProcessExecutor, type StartedPiProcess } from "./pi-process-executor.js";
import { resolveSchedulerPaths, type SchedulerPaths } from "./paths.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { RegistryStore } from "./registry-store.js";
import { RunStore, truncateOutput } from "./run-store.js";
import { environmentPiCommandResolver, nodeChildSpawner, nodeCommandRunner, systemClock, type Clock } from "./runtime-deps.js";
import { WindowsProcessInspector } from "./windows-process-inspector.js";

export interface RunnerStatus {
  running: boolean;
  schedules: number;
  activeJobs: number;
  activeChildren: number;
  maxChildren: number;
  retention: ReturnType<RunStore["diagnostics"]>;
  nextRuns: Record<string, string | undefined>;
  lastError?: string;
}

export interface RunnerServiceOptions {
  paths: SchedulerPaths;
  registry: RegistryStore;
  runs: RunStore;
  executor: PiProcessExecutor;
  supervisor: ProcessSupervisor;
  clock?: Clock;
  cronClock?: CronEngineClock;
  pollMs?: number;
  /**
   * Run the internal poll loop (default true, needed by the standalone daemon). The in-app host
   * (AppScheduler) already drives poll() on its own cadence and sets this false to avoid duplicate polling.
   */
  internalPoll?: boolean;
  maxChildren?: number;
}

/** Single owner of independent timers and child handles; all lifecycle work is serialized. */
export class IndependentRunner {
  private readonly clock: Clock;
  private readonly timers = new Map<string, { revision: number; timer: ScheduledTimer }>();
  private readonly children = new Map<string, StartedPiProcess>();
  private readonly completions = new Map<string, Promise<void>>();
  private poller: ReturnType<typeof setInterval> | undefined;
  private releaseSingleton: (() => Promise<void>) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = true;
  private lastError: string | undefined;

  constructor(private readonly options: RunnerServiceOptions) {
    this.clock = options.clock ?? systemClock;
    if (!Number.isSafeInteger(options.maxChildren ?? 4) || (options.maxChildren ?? 4) < 1 || (options.maxChildren ?? 4) > 32) throw new Error("maxChildren must be an integer from 1 to 32");
  }

  get running(): boolean { return !!this.releaseSingleton && !this.stopping; }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private report(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  async start(): Promise<void> {
    return this.serial(async () => {
      if (this.running) return;
      let release: (() => Promise<void>) | undefined;
      release = await acquireAdvisoryLock(join(this.options.paths.rootDir, "runner.lock"), {
        staleMs: 60_000, retries: 0,
        onCompromised: (error) => { if (this.releaseSingleton === release) this.demote(error); },
      });
      this.releaseSingleton = release;
      this.stopping = false;
      try {
        await this.reconcile();
        await this.refreshSchedules();
        if (this.options.internalPoll !== false) {
          this.poller = setInterval(() => void this.poll().catch((error) => this.report(error)), this.options.pollMs ?? 1000);
          this.poller.unref();
        }
      } catch (error) {
        this.stopping = true;
        this.clearTimers();
        this.releaseSingleton = undefined;
        await release?.().catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * The singleton lock was lost (stale mtime after sleep/stall). Never throw: stop dispatching and fall back
   * to standby. The lock is not ours anymore, so it is not released. Already-owned children keep being
   * supervised until they settle; a later start() may re-acquire the lock.
   */
  private demote(error: unknown): void {
    this.stopping = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    this.clearTimers();
    this.releaseSingleton = undefined;
    this.report(new Error(`Scheduler singleton lock was compromised; demoted to standby: ${error instanceof Error ? error.message : String(error)}`));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    this.clearTimers();
    return this.serial(async () => {
      this.stopping = true;
      if (this.poller) clearInterval(this.poller);
      this.poller = undefined;
      this.clearTimers();
      try {
        for (const [id, child] of this.children) {
          // Terminate owned handles even if persistence has failed.
          try { await this.options.runs.requestCancellation(id, this.clock.now().toISOString()); }
          catch (error) { this.report(error); }
          this.options.executor.terminate(child);
        }
        await this.waitForChildren(3000);
        // Windows: this only kills the direct child, not its process tree; leftovers are reported as orphaned.
        for (const child of this.children.values()) child.process.child.kill("SIGKILL");
        await this.waitForChildren(1000);
        if (this.children.size) this.report(new Error("Some owned children did not settle during shutdown; recovery will mark them orphaned."));
      } finally {
        const release = this.releaseSingleton;
        this.releaseSingleton = undefined;
        await release?.();
      }
    });
  }

  private async waitForChildren(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.completions.values()]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private clearTimers(): void {
    for (const { timer } of this.timers.values()) timer.stop();
    this.timers.clear();
  }

  async poll(): Promise<void> {
    return this.serial(async () => {
      if (!this.running) return;
      for (const run of await this.options.runs.list()) {
        if (this.children.has(run.runId) && run.events.some((event) => event.type === "cancel_requested") && run.status !== "cancelling") {
          await this.cancelOwned(run);
        }
      }
      await this.refreshSchedules();
    });
  }

  async status(): Promise<RunnerStatus> {
    const schedules = (await this.options.registry.list()).filter((schedule) => schedule.mode === "independent" && schedule.state === "active");
    return {
      running: this.running, schedules: schedules.length, activeJobs: this.timers.size, activeChildren: this.children.size, maxChildren: this.options.maxChildren ?? 4,
      retention: this.options.runs.diagnostics(),
      nextRuns: Object.fromEntries(schedules.map((schedule) => [schedule.id,
        schedule.timing.kind === "once" && schedule.lastPlannedAt ? undefined : previewNextRuns(schedule.timing, 1, this.clock.now())[0]?.toISOString()])),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Legacy standalone run-once uses the same singleton/claim path, never a competing runner. */
  async runOnce(scheduleId: string): Promise<Run | undefined> {
    await this.start();
    return this.serial(async () => {
      const schedule = (await this.options.registry.list()).find((item) => item.id === scheduleId && item.mode === "independent");
      if (!schedule) throw new Error(`Unknown independent schedule: ${scheduleId}`);
      if (schedule.state !== "active") throw new Error(`Schedule ${scheduleId} is ${schedule.state}; run-once requires an active schedule.`);
      const run = await this.launch(schedule);
      if (!run) throw new Error(`Schedule ${scheduleId} was not dispatched (one-shot already consumed, schedule changed, or runner stopped).`);
      return run;
    });
  }

  async cancel(runId: string): Promise<Run> {
    await this.options.runs.requestCancellation(runId, this.clock.now().toISOString());
    return this.serial(async () => {
      const run = (await this.options.runs.list()).find((item) => item.runId === runId)!;
      if (isTerminalRunStatus(run.status) || !this.children.has(runId)) return run;
      return this.cancelOwned(run);
    });
  }

  private async cancelOwned(run: Run): Promise<Run> {
    if (isTerminalRunStatus(run.status)) return run;
    const updated = await this.options.runs.beginCancellation(run.runId, this.clock.now().toISOString());
    if (isTerminalRunStatus(updated.status)) return updated;
    const child = this.children.get(run.runId);
    if (child) this.options.executor.terminate(child);
    return updated;
  }

  private async refreshSchedules(): Promise<void> {
    const active = new Map((await this.options.registry.list())
      .filter((schedule) => schedule.mode === "independent" && schedule.state === "active" && !(schedule.timing.kind === "once" && schedule.lastPlannedAt))
      .map((schedule) => [schedule.id, schedule]));
    for (const [id, entry] of this.timers) {
      if (active.get(id)?.revision !== entry.revision) {
        entry.timer.stop();
        this.timers.delete(id);
      }
    }
    for (const schedule of active.values()) {
      if (this.timers.has(schedule.id)) continue;
      if (schedule.timing.kind === "once" && new Date(schedule.timing.expression).getTime() <= this.clock.now().getTime()) {
        await this.launch(schedule, true);
        continue;
      }
      const timer = scheduleTiming(schedule.timing, ({ slot, late }) => this.serial(async () => {
        if (!this.running) return;
        await this.launch(schedule, late, slot);
      }).catch((error) => this.report(error)), this.options.cronClock);
      this.timers.set(schedule.id, { revision: schedule.revision, timer });
    }
  }

  private async launch(snapshot: Schedule, missed = false, slot?: Date): Promise<Run | undefined> {
    if (!this.running) return undefined;
    const at = this.clock.now().toISOString();
    const runId = ulid().toLowerCase();
    const schedule = await this.options.registry.claim(snapshot.id, snapshot.revision, runId, at, slot?.toISOString());
    if (!schedule) return undefined;
    let run: Run = { runId, scheduleId: schedule.id, mode: "independent", status: "planned", plannedAt: at, requestedProfile: schedule.execution, events: [] };
    const atCapacity = this.children.size >= (this.options.maxChildren ?? 4);
    if (missed) {
      run = { ...run, status: "missed", endedAt: at, error: "Scheduled time was missed (app closed, host asleep or stalled); no backfill.",
        events: [] };
      if (atCapacity) run.events.push({ type: "diagnostic", at, detail: "host_capacity_skipped" });
      await this.options.runs.append(run);
      return run;
    }
    if (atCapacity) {
      run = { ...run, status: "skipped_busy", endedAt: at, error: "Host child concurrency limit reached; no backlog is queued.", events: [{ type: "diagnostic", at, detail: "host_capacity_skipped" }] };
    }
    // The busy check and the append share one history-lock critical section, so a second (e.g. demoted)
    // host can never both observe "idle" and start the same schedule.
    const written = await this.options.runs.appendUnlessBusy(run, (item) => ({ ...item, status: "skipped_busy", endedAt: at,
      error: "Schedule has active or orphaned work; dispatch suppressed.", events: [] }));
    if (written.status === "skipped_busy") return written;
    run = written;
    run = await this.options.runs.transition(runId, "queued", at);
    // Cancellation or edits may race the claim. Re-check before spawning.
    const current = (await this.options.registry.list()).find((item) => item.id === schedule.id);
    if (this.stopping || current?.state !== "active" || current.revision !== snapshot.revision) {
      return this.options.runs.transition(runId, "cancelled", at, { error: "Schedule changed before dispatch." });
    }
    let started: StartedPiProcess | undefined;
    const startDetails: Partial<Run> = {};
    try {
      run = await this.options.runs.startQueued(runId, at, () => {
        if (this.stopping) return false;
        started = this.options.executor.start({ runId, schedule });
        startDetails.childPiVersion = started.piVersion;
        this.children.set(runId, started);
        return started.identity;
      }, startDetails);
    } catch (error) {
      if (started) this.options.executor.terminate(started);
      this.report(error);
      if (!started) throw error;
    }
    if (!started) return run;
    const completion = this.finish(runId, started).catch((error) => this.report(error)).finally(() => {
      this.children.delete(runId);
      this.completions.delete(runId);
    });
    this.completions.set(runId, completion);
    return run;
  }

  private async finish(runId: string, started: StartedPiProcess): Promise<void> {
    let ownershipUnknown = true;
    try {
      const result = await this.options.executor.wait(started);
      ownershipUnknown = result.ownershipUnknown;
      await this.options.runs.writeOutput(runId, "stdout", result.stdout);
      await this.options.runs.writeOutput(runId, "stderr", result.stderr);
      const success = result.exitCode === 0 && result.piErrors.length === 0;
      await this.options.runs.finish(runId, result.ownershipUnknown ? "orphaned" : result.signal ? "cancelled" : success ? "succeeded" : "failed", this.clock.now().toISOString(), {
        actualModel: result.actualModel,
        outputSummary: truncateOutput([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"), 4096),
        ...(!success ? { error: result.piErrors.join("; ") || `Pi exited with code ${result.exitCode}` } : {}),
      });
    } catch (error) {
      // Never lose an unknown-ownership barrier merely because log IO failed,
      // or discard a still-owned handle after an unexpected executor rejection.
      if (ownershipUnknown) { try { this.options.executor.terminate(started); } catch { /* best effort; retain barrier */ } }
      await this.options.runs.finish(runId, ownershipUnknown ? "orphaned" : "failed", this.clock.now().toISOString(), { error: String(error) });
    }
  }

  private async reconcile(): Promise<void> {
    for (const run of await this.options.runs.list()) {
      // Children this instance still supervises (after a lock demotion) are not orphans.
      if (run.mode !== "independent" || isTerminalRunStatus(run.status) || this.children.has(run.runId)) continue;
      await this.options.runs.transition(run.runId, "orphaned", this.clock.now().toISOString(), {
        error: "Previous host ended without settling this run. Process ownership is unknown; no PID was killed and this schedule will not launch again automatically.",
      });
    }
  }
}

export function createProductionRunner(agentDir?: string, options: { internalPoll?: boolean } = {}): IndependentRunner {
  const paths = resolveSchedulerPaths(agentDir);
  return new IndependentRunner({
    paths,
    registry: new RegistryStore({ registryPath: paths.registryPath, lockPath: paths.lockPath }),
    runs: new RunStore({ runsPath: paths.runsPath, lockPath: paths.lockPath, logsDir: paths.logsDir }),
    executor: new PiProcessExecutor(environmentPiCommandResolver, nodeChildSpawner, undefined, paths.agentDir),
    ...(options.internalPoll === undefined ? {} : { internalPoll: options.internalPoll }),
    maxChildren: process.env.PI_SCHEDULER_MAX_CHILDREN === undefined ? undefined : Number(process.env.PI_SCHEDULER_MAX_CHILDREN),
    supervisor: new ProcessSupervisor(new WindowsProcessInspector(nodeCommandRunner), new WindowsProcessInspector(nodeCommandRunner)),
  });
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  let agentDir: string | undefined;
  let scheduleId: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--agent-dir") agentDir = rest[i + 1];
    else if (rest[i] === "--schedule") scheduleId = rest[i + 1];
    else throw new Error(`Unknown runner argument: ${rest[i]}`);
  }
  if (!["daemon", "status", "run-once"].includes(command)) throw new Error("Usage: pi-scheduler <daemon|status|run-once> [--agent-dir <path>] [--schedule <id>]");
  const runner = createProductionRunner(agentDir);
  if (command === "status") { console.log(JSON.stringify(await runner.status(), null, 2)); return 0; }
  if (command === "run-once") {
    if (!scheduleId) throw new Error("run-once requires --schedule <id>");
    try {
      console.log(JSON.stringify(await runner.runOnce(scheduleId)));
      while ((await runner.status()).activeChildren) await new Promise((resolve) => setTimeout(resolve, 100));
    } finally { await runner.stop(); }
    return 0;
  }
  await runner.start();
  const keepAlive = setInterval(() => undefined, 60_000);
  const stop = () => { clearInterval(keepAlive); void runner.stop().catch(console.error); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
