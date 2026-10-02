import type { AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { ulid } from "ulid";

import { scheduleTiming, type CronEngineClock, type ScheduledTimer } from "./cron-engine.js";
import { isTerminalRunStatus, type ExecutionProfile, type Run, type Schedule, type ThinkingLevel } from "./domain.js";
import { RegistryStore } from "./registry-store.js";
import { RunStore, truncateOutput } from "./run-store.js";
import type { Clock } from "./runtime-deps.js";
import { acquireAdvisoryLock } from "./locking.js";

interface ModelReference { provider: string; id: string }
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
type Outcome = Parameters<RunStore["finish"]>[1];
interface ActiveSessionRun {
  run: Run;
  schedule: Schedule;
  token: string;
  phase: "reserved" | "submitted" | "running" | "finalizing";
  started: boolean;
  cancelled: boolean;
  retired: boolean;
  capturedModel?: NonNullable<ExtensionContext["model"]>;
  capturedThinking: ThinkingLevel;
  appliedModel?: ModelReference;
  appliedThinking?: ThinkingLevel;
  expectedModel?: ModelReference;
  modelTouched: boolean;
  thinkingTouched: boolean;
  userChanged: boolean;
  lastAssistant?: AssistantMessage;
  failure?: string;
  signal?: AbortSignal;
  admissionTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionSchedulerOptions {
  registry: RegistryStore;
  runs: RunStore;
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel" | "getThinkingLevel" | "setSessionName" | "sendUserMessage">;
  clock?: Clock;
  cronClock?: CronEngineClock;
  /** Only bounds submission acknowledgement, not an already-started agent. */
  admissionTimeoutMs?: number;
}
function modelRef(model: unknown): ModelReference | undefined {
  if (!model || typeof model !== "object") return undefined;
  const value = model as { provider?: unknown; id?: unknown };
  return typeof value.provider === "string" && typeof value.id === "string" ? { provider: value.provider, id: value.id } : undefined;
}
function sameModel(left: ModelReference | undefined, right: ModelReference | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}
function now(clock: Clock): string { return clock.now().toISOString(); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function messageText(message: MessageStartEvent["message"]): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function idle(ctx: ExtensionContext): boolean { return ctx.isIdle() && !ctx.hasPendingMessages?.(); }

/** Public Pi events, not a private prompt/agent hook, acknowledge owned session work. */
export class SessionScheduler {
  private readonly clock: Clock;
  private readonly instanceId = ulid().toLowerCase();
  private readonly abortedSignals = new WeakSet<AbortSignal>();
  private readonly timers = new Map<string, { revision: number; timer: ScheduledTimer }>();
  private closing = true;
  private queue: Promise<unknown> = Promise.resolve();
  private releaseSession: (() => Promise<void>) | undefined;
  private sessionId: string | undefined;
  private context: ExtensionContext | undefined;
  private active: ActiveSessionRun | undefined;
  private applying = false;
  private profileFault = false;
  lastError: string | undefined;

  constructor(private readonly options: SessionSchedulerOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    if (!Number.isFinite(options.admissionTimeoutMs ?? 15_000) || (options.admissionTimeoutMs ?? 15_000) <= 0) throw new Error("admissionTimeoutMs must be positive");
  }
  get profileOwnershipActive(): boolean { return this.active !== undefined; }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private report(error: unknown): void { this.lastError = errorText(error); }
  async start(ctx: ExtensionContext): Promise<void> {
    if (this.context) await this.shutdown();
    return this.serial(async () => {
      this.closing = false; this.context = ctx; this.sessionId = ctx.sessionManager.getSessionId(); this.profileFault = false;
      await this.refreshOwned();
    });
  }
  async refresh(): Promise<void> { return this.serial(() => this.refreshOwned()); }
  private async refreshOwned(): Promise<void> {
    if (!this.sessionId || this.closing) return;
    if (!this.releaseSession) {
      const sessionId = this.sessionId;
      let release: () => Promise<void>;
      try { release = await acquireAdvisoryLock(this.options.registry.sessionLockPath(sessionId), { staleMs: 60_000, retries: 0 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return; throw error; }
      if (this.closing || this.sessionId !== sessionId) { await release(); return; }
      this.releaseSession = release;
      const schedules = await this.options.registry.list();
      // Only a lock owner may reconcile its own session. Never kill an old PID.
      for (const run of await this.options.runs.list()) {
        const target = run.targetSessionId ?? schedules.find((schedule) => schedule.id === run.scheduleId)?.targetSessionId;
        if (run.mode === "session" && target === sessionId && !isTerminalRunStatus(run.status) && run.runId !== this.active?.run.runId) {
          await this.options.runs.transition(run.runId, "orphaned", now(this.clock), {
            error: "Previous session host ended without settlement; ownership is unknown. No prompt is replayed and this schedule is blocked by its orphan barrier.",
          });
        }
      }
    }
    if (this.closing) return;
    if (this.active) {
      const run = (await this.options.runs.list()).find((item) => item.runId === this.active?.run.runId);
      if (run?.events.some((event) => event.type === "cancel_requested")) await this.cancelOwnedRun(run.runId);
    }
    const schedules = (await this.options.registry.list()).filter((schedule) =>
      schedule.mode === "session" && schedule.state === "active" && schedule.targetSessionId === this.sessionId &&
      !(schedule.timing.kind === "once" && schedule.lastPlannedAt),
    );
    for (const [id, entry] of this.timers) {
      if (!schedules.some((schedule) => schedule.id === id && schedule.revision === entry.revision)) { entry.timer.stop(); this.timers.delete(id); }
    }
    for (const schedule of schedules) {
      if (this.closing) return;
      if (this.timers.has(schedule.id)) continue;
      if (schedule.timing.kind === "once" && new Date(schedule.timing.expression).getTime() <= this.clock.now().getTime()) {
        const runId = ulid().toLowerCase();
        if (await this.options.registry.claim(schedule.id, schedule.revision, runId, now(this.clock))) {
          await this.options.runs.append({ runId, scheduleId: schedule.id, targetSessionId: this.sessionId, mode: "session", status: "skipped_busy", plannedAt: now(this.clock), endedAt: now(this.clock), events: [{ type: "diagnostic", at: now(this.clock), detail: "missed_no_backfill" }], error: "Session was not open at the one-shot due time; no backfill." });
        }
        continue;
      }
      this.timers.set(schedule.id, { revision: schedule.revision, timer: scheduleTiming(schedule.timing,
        () => this.dispatch(schedule).then(() => undefined).catch((error) => this.report(error)), this.options.cronClock) });
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.active) { this.active.cancelled = true; this.abortStarted(this.active); }
    this.stopTimers();
    return this.serial(async () => {
      this.stopTimers();
      let failure: unknown;
      try {
        if (this.active) {
          const active = this.active;
          try { await this.cancelOwnedRun(active.run.runId); }
          catch (error) { failure = error; this.report(error); }
          if (this.active === active) {
            try {
              await this.finalize(active, active.started ? "orphaned" : "cancelled", { error: "Session shutdown requested abort; actual settlement was not observed. Orphan barrier prevents automatic overlap." });
            } catch (error) { failure = error; this.report(error); }
          }
        }
      } finally {
        // Do not exclude a stale in-memory active from recovery after IO failure.
        if (this.active) { this.active.retired = true; this.clearAdmissionDeadline(this.active); }
        this.active = undefined; this.context = undefined; this.sessionId = undefined;
        const release = this.releaseSession; this.releaseSession = undefined; await release?.();
      }
      if (failure) throw failure;
    });
  }
  async dispatch(schedule: Schedule): Promise<Run> { return this.serial(() => this.dispatchClaimed(schedule)); }
  private async dispatchClaimed(schedule: Schedule): Promise<Run> {
    const ctx = this.context;
    if (this.closing || !this.releaseSession) throw new Error("Session scheduler is not the active owner");
    const run: Run = { runId: ulid().toLowerCase(), scheduleId: schedule.id, targetSessionId: schedule.targetSessionId, mode: "session", status: "planned",
      plannedAt: now(this.clock), requestedProfile: schedule.execution, events: [] };
    const claimed = await this.options.registry.claim(schedule.id, schedule.revision, run.runId, run.plannedAt);
    if (!claimed) throw new Error("Schedule changed, cancelled, or already consumed before dispatch");
    const blocked = (await this.options.runs.list(schedule.id)).some((item) => !isTerminalRunStatus(item.status) || item.status === "orphaned");
    if (!ctx || this.closing || this.context !== ctx || this.sessionId !== schedule.targetSessionId || schedule.state !== "active" || !idle(ctx) || this.active || this.profileFault || blocked) {
      run.status = this.closing ? "cancelled" : "skipped_busy"; run.endedAt = now(this.clock);
      run.error = "Target session is unavailable, busy, owns a scheduler profile, requires profile recovery, or has orphaned work.";
      await this.options.runs.append(run); return run;
    }
    const active: ActiveSessionRun = { run, schedule, token: `[[pi-scheduler:${this.instanceId}:${run.runId}]]`, phase: "reserved", started: false,
      cancelled: false, retired: false, capturedModel: ctx.model, capturedThinking: this.options.pi.getThinkingLevel(),
      modelTouched: false, thinkingTouched: false, userChanged: false };
    // Reserve our profile/input ownership before the first history IO yield.
    this.active = active;
    try { await this.options.runs.append(run); }
    catch (error) { active.retired = true; this.active = undefined; this.report(error); throw error; }
    try {
      if (this.closing || active.cancelled) return this.finalize(active, "cancelled");
      if (!idle(ctx) || active.retired || active.userChanged) return this.finalize(active, "skipped_busy", { error: "Session became busy or selection changed during admission." });
      await this.applyProfile(schedule.execution, ctx, active);
      if (this.closing || active.cancelled) return this.finalize(active, "cancelled");
      if (!idle(ctx) || active.retired || active.userChanged) return this.finalize(active, "skipped_busy", { error: "Session became busy or selection changed during profile preflight." });
      active.run = await this.options.runs.transition(run.runId, "queued", now(this.clock));
      const current = (await this.options.registry.list()).find((item) => item.id === schedule.id);
      if (this.closing || active.cancelled || current?.state !== "active" || current.revision !== schedule.revision) return this.finalize(active, "cancelled");
      active.run = await this.options.runs.submitQueued(run.runId, now(this.clock), () => {
        if (this.closing || active.cancelled || active.retired) return false;
        if (!idle(ctx)) return "busy";
        if (schedule.title) this.options.pi.setSessionName(schedule.title);
        active.phase = "submitted";
        this.armAdmissionDeadline(active);
        // No deliverAs: a race to busy must reject, not enqueue follow-up work.
        // Keep the correlation header through input/preflight and in the session history.
        this.options.pi.sendUserMessage(`${active.token}\n${schedule.prompt}`, { expandPromptTemplates: false });
        return "submitted";
      });
      if (isTerminalRunStatus(active.run.status)) return this.finalize(active, active.run.status === "cancelled" ? "cancelled" : "failed_preflight");
      return active.run;
    } catch (error) {
      return this.finalize(active, active.started ? "failed" : "failed_preflight", { error: errorText(error) });
    }
  }
  private ownToken(text: string): string | undefined {
    // Recognize retired instances after reload and harmless input wrappers too.
    // Standby duplicates must not abort the actual lock owner's current prompt.
    const id = "(?:[0-9a-hjkmnp-tv-z]{26}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})";
    const tokens = text.match(new RegExp(`\\[\\[pi-scheduler:${id}:${id}\\]\\]`, "gi"))?.map((token) => token.toLowerCase()) ?? [];
    return tokens.find((token) => token === this.active?.token) ?? tokens.find((token) => this.releaseSession || token.includes(this.instanceId));
  }
  private armAdmissionDeadline(active: ActiveSessionRun): void {
    active.admissionTimer = setTimeout(() => {
      if (this.active !== active || active.started || active.phase !== "submitted") return;
      active.retired = true; // synchronous fence before persistence can yield
      void this.serial(() => this.finalize(active, "failed_preflight", {
        error: "Pi admission was not acknowledged before the deadline (input handled, asynchronous rejection, or delayed preflight). Prompt will not be replayed; late correlated starts are aborted.",
      })).catch((error) => this.report(error));
    }, this.options.admissionTimeoutMs ?? 15_000);
    active.admissionTimer.unref();
  }
  private clearAdmissionDeadline(active: ActiveSessionRun): void { if (active.admissionTimer) clearTimeout(active.admissionTimer); active.admissionTimer = undefined; }
  handleInput(event: InputEvent, ctx: ExtensionContext): { action: "handled" } | undefined {
    const token = this.ownToken(event.text);
    if (token) {
      const active = this.active;
      if (this.closing || !active || active.token !== token || active.cancelled || active.retired || active.started) return { action: "handled" };
      if (!idle(ctx)) {
        active.retired = true;
        void this.serial(() => this.finalize(active, "skipped_busy", { error: "Session became busy before owned input admission." })).catch((error) => this.report(error));
        return { action: "handled" };
      }
      return undefined;
    }
    if (!this.active) return undefined;
    ctx.ui.notify("Scheduler owns a temporary execution profile; wait for the scheduled run to settle.", "warning");
    return { action: "handled" };
  }
  async beforeAgentStart(event: BeforeAgentStartEvent, _ctx: ExtensionContext): Promise<void> {
    const active = this.active;
    if (active && !active.started && !this.ownToken(event.prompt)) {
      // A user prompt may already have passed input before we reserved the profile.
      active.retired = true;
      await this.serial(() => this.finalize(active, "skipped_busy", { error: "Unrelated prompt was already in preflight; scheduler submission suppressed." }));
    }
  }
  async messageStarted(event: MessageStartEvent, ctx: ExtensionContext): Promise<void> {
    const token = this.ownToken(messageText(event.message));
    if (!token) return;
    const active = this.active;
    if (this.closing || !active || active.token !== token || active.cancelled || active.retired || active.started) {
      this.abortBoundary(ctx); // new core signal exists here, unlike before_agent_start
      return;
    }
    active.started = true; active.signal = ctx.signal; this.clearAdmissionDeadline(active);
    try {
      await this.serial(async () => {
        if (this.active !== active || active.cancelled || active.retired || this.closing) { this.abortBoundary(ctx); return; }
        const selected = modelRef(ctx.model);
        const effectiveProfile = { ...(selected ? { provider: selected.provider, model: selected.id } : {}), thinkingLevel: this.options.pi.getThinkingLevel() };
        active.run = await this.options.runs.startQueued(active.run.runId, now(this.clock), () => {
          if (active.cancelled || active.retired || this.closing) { this.abortBoundary(ctx); return false; }
          return undefined;
        }, { effectiveProfile });
        if (active.run.status !== "running") { this.abortBoundary(ctx); await this.finalize(active, "cancelled"); return; }
        active.phase = "running";
      });
    } catch (error) {
      active.retired = true; active.failure = errorText(error); this.abortBoundary(ctx); this.report(error);
      // Pi catches extension handler errors. Abort synchronously before rethrowing,
      // otherwise a failed running-history write would still allow provider dispatch.
      throw error;
    }
  }
  messageEnded(event: MessageEndEvent): void {
    if (this.active?.started && event.message.role === "assistant") this.active.lastAssistant = event.message;
  }
  agentEnded(event: AgentEndEvent): void {
    if (this.active?.started) this.active.lastAssistant = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
  }
  async settled(): Promise<void> {
    // Snapshot correlation now, not later when the serial queue happens to run.
    const active = this.active;
    if (!active?.started) return;
    return this.serial(async () => {
      if (this.active !== active) return;
      const message = active.lastAssistant;
      const cancelled = active.cancelled || (!active.failure && (active.signal?.aborted || message?.stopReason === "aborted"));
      const success = !active.failure && (message?.stopReason === "stop" || message?.stopReason === "length");
      await this.finalize(active, cancelled ? "cancelled" : success ? "succeeded" : "failed", {
        ...(!cancelled && !success ? { error: active.failure || message?.errorMessage || `Pi settled without a successful terminal assistant response (${message?.stopReason ?? "missing"}).` } : {}),
        ...(message ? { actualModel: { provider: message.provider, model: message.model }, outputSummary: truncateOutput(message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), 4096) } : {}),
      });
    });
  }
  private async finalize(active: ActiveSessionRun, outcome: Outcome, details: Partial<Run> = {}): Promise<Run> {
    if (this.active !== active) return active.run;
    active.phase = "finalizing"; active.retired = true; this.clearAdmissionDeadline(active);
    const restoreError = await this.restore(active);
    if (active.cancelled) {
      if (outcome !== "orphaned") outcome = "cancelled";
      try { await this.options.runs.requestCancellation(active.run.runId, now(this.clock)); }
      catch (error) { this.report(error); }
    }
    if (restoreError) {
      this.profileFault = true; this.report(restoreError);
      details = { ...details, restoreError, error: [details.error, `Profile restoration failed: ${restoreError}`].filter(Boolean).join("; ") };
      if (outcome === "succeeded") outcome = "failed";
      try { await this.options.runs.appendEvent(active.run.runId, { type: "diagnostic", at: now(this.clock), detail: `restore_failed: ${restoreError}` }); }
      catch (error) { this.report(error); }
    }
    // Ownership is released only after history actually reaches a terminal state.
    active.run = await this.options.runs.finish(active.run.runId, outcome, now(this.clock), { ...details, effectiveProfile: active.run.effectiveProfile, restoreError });
    this.active = undefined;
    return active.run;
  }
  async cancel(scheduleId: string): Promise<void> {
    if (this.active?.schedule.id === scheduleId) { this.active.cancelled = true; this.abortStarted(this.active); }
    const schedule = (await this.options.registry.list()).find((item) => item.id === scheduleId);
    if (!schedule) throw new Error(`Unknown schedule: ${scheduleId}`);
    if (schedule.state === "active" || schedule.state === "paused") await this.options.registry.setState(schedule.id, schedule.revision, "cancelled");
    this.timers.get(scheduleId)?.timer.stop(); this.timers.delete(scheduleId);
    if (this.active?.schedule.id === scheduleId) await this.cancelActiveRun(this.active.run.runId);
  }
  async cancelActiveRun(runId: string): Promise<void> {
    if (this.active?.run.runId === runId) { this.active.cancelled = true; this.abortStarted(this.active); }
    return this.serial(() => this.cancelOwnedRun(runId));
  }
  private async cancelOwnedRun(runId: string): Promise<void> {
    const active = this.active;
    if (!active || active.run.runId !== runId) return;
    active.cancelled = true; this.abortStarted(active);
    active.run = await this.options.runs.requestCancellation(runId, now(this.clock));
    if (!active.started) { await this.finalize(active, "cancelled"); return; }
    if (!active.run.events.some((event) => event.type === "abort_requested")) active.run = await this.options.runs.appendEvent(runId, { type: "abort_requested", at: now(this.clock) });
    active.run = await this.options.runs.beginCancellation(runId, now(this.clock));
  }
  private abortStarted(active: ActiveSessionRun): void { if (active.started && this.context) this.abortBoundary(this.context); }
  private abortBoundary(ctx: ExtensionContext): void {
    const signal = ctx.signal;
    if (signal && (signal.aborted || this.abortedSignals.has(signal))) return;
    if (signal) this.abortedSignals.add(signal);
    ctx.abort();
  }
  onModelChanged(model: unknown): void {
    const active = this.active;
    if (!active || active.phase === "finalizing") return;
    const selected = modelRef(model);
    if (sameModel(selected, active.expectedModel ?? active.appliedModel ?? modelRef(active.capturedModel))) {
      if (active.expectedModel && active.appliedThinking === undefined) active.appliedThinking = this.options.pi.getThinkingLevel();
      return;
    }
    active.userChanged = true;
  }
  onThinkingChanged(level: ThinkingLevel): void {
    const active = this.active;
    if (!active || active.phase === "finalizing") return;
    // Delayed own events and clamping describe actual selection, not requested level.
    if (level !== this.options.pi.getThinkingLevel()) return;
    if (this.applying && !active.expectedModel) return; // synchronous explicit thinking setter
    if (active.expectedModel && sameModel(modelRef(this.context?.model), active.expectedModel) && active.appliedThinking === undefined) {
      active.appliedThinking = level; // first implicit model-switch self-event only
      return;
    }
    if (level !== (active.appliedThinking ?? active.capturedThinking)) active.userChanged = true;
  }
  private async applyProfile(profile: ExecutionProfile | undefined, ctx: ExtensionContext, active: ActiveSessionRun): Promise<void> {
    if (!profile) return;
    this.applying = true;
    try {
      if (profile.provider && profile.model) {
        const target = ctx.modelRegistry.find(profile.provider, profile.model);
        if (!target) throw new Error(`Requested model is unavailable: ${profile.provider}/${profile.model}`);
        active.expectedModel = modelRef(target);
        if (!(await this.options.pi.setModel(target))) throw new Error(`Authentication is unavailable for ${profile.provider}/${profile.model}`);
        active.modelTouched = true; active.thinkingTouched = true; active.appliedModel = modelRef(ctx.model) ?? modelRef(target);
      }
      if (active.userChanged || active.cancelled || this.closing) return;
      active.expectedModel = undefined;
      if (profile.thinkingLevel) { active.thinkingTouched = true; this.options.pi.setThinkingLevel(profile.thinkingLevel); }
    } finally {
      // setModel may mutate selection then throw in another handler.
      if (!sameModel(modelRef(ctx.model), modelRef(active.capturedModel))) { active.modelTouched = true; active.thinkingTouched = true; }
      if (active.thinkingTouched) active.appliedThinking = this.options.pi.getThinkingLevel();
      active.expectedModel = undefined; this.applying = false;
    }
  }
  private async restore(active: ActiveSessionRun): Promise<string | undefined> {
    if (!active.modelTouched && !active.thinkingTouched) return undefined;
    if (active.userChanged) {
      try { await this.options.runs.appendEvent(active.run.runId, { type: "restore_skipped_user_change", at: now(this.clock) }); }
      catch (error) { this.report(error); }
      return undefined;
    }
    this.applying = true;
    try {
      if (active.modelTouched) {
        if (!active.capturedModel) throw new Error("Original model was absent; cannot restore selection through the public API.");
        if (!(await this.options.pi.setModel(active.capturedModel))) throw new Error("Original model authentication is unavailable.");
      }
      if (active.thinkingTouched) {
        this.options.pi.setThinkingLevel(active.capturedThinking);
        if (this.options.pi.getThinkingLevel() !== active.capturedThinking) throw new Error("Original thinking level could not be restored.");
      }
      return undefined;
    } catch (error) { return errorText(error); }
    finally { this.applying = false; }
  }
  private stopTimers(): void { for (const { timer } of this.timers.values()) timer.stop(); this.timers.clear(); }
}
