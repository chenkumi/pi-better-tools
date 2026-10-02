import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { previewNextRuns, validateTiming } from "./cron-engine.js";
import { isTerminalRunStatus, type ExecutionProfile, type Schedule, type ScheduleTiming } from "./domain.js";
import { validateExecutionProfile } from "./execution-profile.js";
import type { AppScheduler } from "./app-scheduler.js";
import type { RegistryStore } from "./registry-store.js";
import type { RunStore } from "./run-store.js";

export interface CreateInput {
  title?: string;
  prompt: string;
  timing: ScheduleTiming;
  mode?: "independent" | "session";
  sessionId?: string;
  cwd?: string;
  execution?: ExecutionProfile;
  projectTrust?: boolean;
}
export interface UpdateInput {
  id: string;
  revision: number;
  patch: Partial<Pick<Schedule, "title" | "prompt" | "timing" | "execution" | "projectTrust">> & { state?: "active" | "paused" };
}
export interface StatusInput { id?: string; limit?: number; offset?: number; runsLimit?: number }
export interface CancelInput { id?: string; runId?: string; cancelRunning?: boolean }

export class SchedulerService {
  constructor(
    readonly registry: RegistryStore,
    readonly runs: RunStore,
    readonly app: AppScheduler,
    private readonly now = () => new Date(),
  ) {}

  private async requireMutationHost(): Promise<void> {
    if ((await this.app.status()).role === "child-disabled") throw new Error("Scheduler child sessions are read-only: create/update/cancel must be requested through an open host Pi.");
  }

  private validateFuture(timing: ScheduleTiming): void {
    validateTiming(timing);
    if (timing.kind === "once" && new Date(timing.expression).getTime() <= this.now().getTime()) {
      throw new Error("One-shot time must be in the future; use schedule_status to check the current time/timezone.");
    }
    if (!previewNextRuns(timing, 1, this.now()).length) throw new Error("Timing has no future occurrence.");
  }

  private validateTitle(title: string | undefined): void {
    if (title !== undefined && (!title.trim() || title.length > 200)) throw new Error("Title must contain 1–200 characters and cannot be blank.");
  }

  private validatePrompt(prompt: string): void {
    if (!prompt.trim() || prompt.length > 32_000) throw new Error("Prompt must contain 1–32000 characters and cannot be blank.");
  }

  async create(input: CreateInput, ctx: ExtensionContext) {
    await this.requireMutationHost();
    this.validateTitle(input.title);
    this.validatePrompt(input.prompt);
    this.validateFuture(input.timing);
    validateExecutionProfile(input.execution);
    const currentSessionId = ctx.sessionManager.getSessionId();
    const mode = input.mode ?? (input.sessionId ? "session" : "independent");
    if (mode !== "independent" && mode !== "session") throw new Error("Invalid schedule mode");
    if (input.sessionId && mode !== "session") throw new Error("sessionId can only be used with session execution");
    if (input.sessionId && input.sessionId !== currentSessionId) throw new Error("sessionId must match the current session");
    const cwd = resolve(ctx.cwd, input.cwd ?? ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("Schedule cwd must be a directory");
    if (mode === "session" && cwd !== resolve(ctx.cwd)) throw new Error("Session schedules must use the current session working directory");
    const schedule = await this.registry.create({
      ...input, cwd, mode,
      ...(mode === "session" ? { targetSessionId: input.sessionId ?? currentSessionId } : {}),
    });
    await this.app.refresh();
    return { schedule: this.view(schedule), runtime: await this.app.status() };
  }

  async update(input: UpdateInput) {
    await this.requireMutationHost();
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error("revision must be a positive integer");
    const patch = input.patch;
    if (!Object.keys(patch).length) throw new Error("Update patch cannot be empty");
    if (patch.title !== undefined) this.validateTitle(patch.title);
    if (patch.prompt !== undefined) this.validatePrompt(patch.prompt);
    if (patch.timing) this.validateFuture(patch.timing);
    if (patch.execution) validateExecutionProfile(patch.execution);
    if (patch.state !== undefined && !["active", "paused"].includes(patch.state)) throw new Error("State must be active or paused");
    const existing = (await this.registry.list()).find((item) => item.id === input.id);
    if (!existing) throw new Error(`Unknown schedule: ${input.id}`);
    if (existing.state === "cancelled") throw new Error("Cancelled schedules cannot be resumed; create a new schedule.");
    if (patch.state === "active" && existing.timing.kind === "once" && !patch.timing) {
      this.validateFuture(existing.timing);
      if (existing.lastPlannedAt) throw new Error("One-shot already consumed; supply a different future timing.");
    }
    const schedule = await this.registry.update(input.id, input.revision, patch);
    await this.app.refresh();
    return { schedule: this.view(schedule), runtime: await this.app.status() };
  }

  private view(schedule: Schedule, detail = true) {
    const nextRun = schedule.state !== "active" || (schedule.timing.kind === "once" && schedule.lastPlannedAt)
      ? undefined : previewNextRuns(schedule.timing, 1, this.now())[0]?.toISOString();
    return { ...schedule, prompt: detail ? schedule.prompt : schedule.prompt.slice(0, 160), nextRun: nextRun ?? null,
      consumed: schedule.timing.kind === "once" && !!schedule.lastPlannedAt };
  }

  async status(input: StatusInput = {}) {
    const limit = input.limit ?? 20, offset = input.offset ?? 0, runsLimit = input.runsLimit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(runsLimit) || runsLimit < 0 || runsLimit > 50) {
      throw new Error("limit must be 1–50, offset >= 0, runsLimit 0–50 (integers)");
    }
    const all = await this.registry.list();
    const selected = input.id ? all.filter((s) => s.id === input.id) : all;
    if (input.id && !selected.length) throw new Error(`Unknown schedule: ${input.id}`);
    const history = await this.runs.list(input.id);
    const now = this.now();
    return {
      now: now.toISOString(), localTime: now.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      runtime: await this.app.status(), total: selected.length, offset,
      schedules: selected.slice(offset, offset + limit).map((s) => this.view(s, !!input.id)),
      runs: (runsLimit ? history.slice(-runsLimit).reverse() : []).map((run) => ({
        ...run, outputSummary: run.outputSummary?.slice(0, 1000), error: run.error?.slice(0, 1000), restoreError: run.restoreError?.slice(0, 1000),
      })),
    };
  }

  async cancel(input: CancelInput) {
    await this.requireMutationHost();
    if (!!input.id === !!input.runId) throw new Error("Provide exactly one of id or runId");
    if (input.runId && input.cancelRunning !== undefined) throw new Error("cancelRunning only applies to schedule cancellation");
    let schedule: Schedule | undefined;
    if (input.id) {
      schedule = (await this.registry.list()).find((s) => s.id === input.id);
      if (!schedule) throw new Error(`Unknown schedule: ${input.id}`);
      if (schedule.state !== "cancelled") schedule = await this.registry.setState(schedule.id, schedule.revision, "cancelled");
    }
    const allRuns = await this.runs.list(input.id);
    if (input.runId && !allRuns.some((run) => run.runId === input.runId)) throw new Error(`Unknown run: ${input.runId}`);
    const targets = allRuns.filter((run) => !isTerminalRunStatus(run.status) &&
      (input.runId ? run.runId === input.runId : input.cancelRunning === true));
    for (const run of targets) {
      await this.runs.requestCancellation(run.runId, this.now().toISOString());
      if (run.mode === "independent") await this.app.runner.cancel(run.runId);
      else await this.app.session.cancelActiveRun(run.runId);
    }
    await this.app.refresh();
    return {
      schedule: schedule ? this.view(schedule) : undefined,
      cancellationRequested: targets.map((run) => run.runId),
      note: "Future schedule dispatch is disabled when id is supplied. Run cancellation is a request, not proof of termination; inspect run history. No external PID is killed.",
      runtime: await this.app.status(),
    };
  }
}
