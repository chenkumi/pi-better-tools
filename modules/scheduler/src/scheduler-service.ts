import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { previewNextRuns, validateTiming } from "./cron-engine.js";
import { isTerminalRunStatus, type ExecutionProfile, type Run, type Schedule, type ScheduleTiming } from "./domain.js";
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
export interface StatusInput { id?: string; runId?: string; limit?: number; offset?: number; runsLimit?: number }

/** Maximum characters of result text returned for one run. */
export const RESULT_TAIL_CHARS = 2000;
const tail = (text: string) => text.length > RESULT_TAIL_CHARS ? `…${text.slice(-RESULT_TAIL_CHARS)}` : text;

/** Final assistant text from a retained `--mode json` stdout log, if a complete assistant message_end is present. */
function finalAssistantText(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("message_end")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (event.type !== "message_end" || event.message?.role !== "assistant" || !Array.isArray(event.message.content)) continue;
      const blocks = event.message.content as Array<{ type?: string; text?: string }>;
      if (blocks.some((block) => block.type === "toolCall")) continue;
      const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
      if (text) found = text;
    } catch { /* partial or truncated line */ }
  }
  return found;
}
export interface DeleteInput { id: string; revision: number }
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

  /** Full detail for one schedule (used by /schedule show). */
  async show(id: string) {
    const schedule = (await this.registry.list()).find((item) => item.id === id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    return this.view(schedule);
  }

  private view(schedule: Schedule, detail = true) {
    const nextRun = schedule.state !== "active" || (schedule.timing.kind === "once" && schedule.lastPlannedAt)
      ? undefined : previewNextRuns(schedule.timing, 1, this.now())[0]?.toISOString();
    return { ...schedule, prompt: detail ? schedule.prompt : schedule.prompt.slice(0, 160), nextRun: nextRun ?? null,
      consumed: schedule.timing.kind === "once" && !!schedule.lastPlannedAt };
  }

  /** Summary row for list output: only identity, state, times and flags that are set. */
  private summary(schedule: Schedule) {
    const full = this.view(schedule, false);
    return {
      id: full.id, ...(full.title ? { title: full.title } : {}), state: full.state, revision: full.revision,
      ...(full.nextRun ? { nextRun: full.nextRun } : {}),
      ...(full.lastPlannedAt ? { lastRunAt: full.lastPlannedAt } : {}),
      ...(full.lastRunId ? { lastRunId: full.lastRunId } : {}),
      ...(full.mode === "session" ? { mode: full.mode } : {}),
      ...(full.consumed ? { consumed: true } : {}),
    };
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
    const target = input.runId === undefined ? undefined : history.find((run) => run.runId === input.runId);
    if (input.runId !== undefined && !target) throw new Error(`Unknown run: ${input.runId}${input.id ? ` (for schedule ${input.id})` : ""}`);
    // Lists are summaries; a schedule id or run id selects the detailed view.
    const detail = !!input.id || !!input.runId;
    return {
      now: now.toISOString(), localTime: now.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      runtime: await this.app.status(), total: selected.length, ...(offset ? { offset } : {}),
      schedules: selected.slice(offset, offset + limit).map((s) => input.id ? this.view(s, true) : this.summary(s)),
      runs: (runsLimit ? history.slice(-runsLimit).reverse() : []).map((run) => this.runView(run, detail)),
      ...(target ? { result: await this.result(target) } : {}),
    };
  }

  private runView(run: Run, detail: boolean) {
    const capacitySkipped = run.events.some((event) => event.type === "diagnostic" && event.detail === "host_capacity_skipped");
    if (!detail) {
      return {
        runId: run.runId, scheduleId: run.scheduleId, mode: run.mode, status: run.status, plannedAt: run.plannedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        ...(run.error ? { error: run.error.slice(0, 300) } : {}),
        ...(capacitySkipped ? { capacitySkipped: true } : {}),
      };
    }
    const { events, ...rest } = run;
    return {
      ...rest, outputSummary: run.outputSummary?.slice(0, 1000), error: run.error?.slice(0, 1000), restoreError: run.restoreError?.slice(0, 1000),
      ...(events.length ? { events } : {}),
      ...(capacitySkipped ? { capacitySkipped: true } : {}),
    };
  }

  /** Bounded tail of one run's result: final assistant text, else the end of the retained output. */
  private async result(run: Run) {
    const base = { runId: run.runId, scheduleId: run.scheduleId, status: run.status, error: run.error?.slice(0, 1000) };
    const stdout = run.mode === "independent" ? await this.runs.readOutput(run.runId, "stdout") : undefined;
    const final = stdout === undefined ? undefined : finalAssistantText(stdout);
    if (final !== undefined) return { ...base, source: "final_assistant_text" as const, tail: tail(final), truncated: final.length > RESULT_TAIL_CHARS };
    // Session runs store the final assistant text itself; independent runs fall back to retained logs (first 64 KiB only).
    const fallback = run.mode === "session" ? run.outputSummary : (await this.runs.readOutput(run.runId, "stderr"))?.trim() || stdout?.trim() || run.outputSummary;
    if (!fallback) return { ...base, source: "none" as const, tail: "", truncated: false };
    return { ...base, source: run.mode === "session" ? "session_output_summary" as const : "log_excerpt" as const, tail: tail(fallback), truncated: fallback.length > RESULT_TAIL_CHARS || fallback.endsWith("[truncated]") };
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

  /**
   * Deletes a disabled (paused or cancelled) schedule. Revision, state and the run check all happen under the
   * registry lock, which claims and run writes also use, so no run can start while the record is removed.
   * Active runs and orphaned runs (safety barriers) block deletion; finished history of the schedule is pruned with it.
   */
  async delete(input: DeleteInput) {
    await this.requireMutationHost();
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error("revision must be a positive integer");
    const existing = (await this.registry.list()).find((item) => item.id === input.id);
    if (!existing) throw new Error(`Unknown schedule: ${input.id}`);
    if (existing.state === "active") throw new Error(`Schedule ${input.id} is still active; call schedule_cancel first (or pause it with schedule_update), then schedule_delete.`);
    const removed = await this.registry.remove(input.id, input.revision, async () => {
      const blocking = (await this.runs.list(input.id)).filter((run) => !isTerminalRunStatus(run.status) || run.status === "orphaned");
      if (blocking.length) {
        const ids = blocking.slice(0, 5).map((run) => `${run.runId} (${run.status})`).join(", ");
        throw new Error(`Cannot delete schedule ${input.id}: ${blocking.length} run(s) still active or orphaned: ${ids}. ` +
          "Cancel active runs with schedule_cancel {runId} and wait until they finish; orphaned runs are safety barriers and keep the schedule from being deleted.");
      }
    });
    const prunedRuns = await this.runs.removeForSchedule(removed.id);
    await this.app.refresh();
    return {
      deleted: { id: removed.id, revision: removed.revision, ...(removed.title ? { title: removed.title } : {}) }, prunedRuns,
      note: "Schedule record and its finished run history were removed. This cannot be undone.",
      runtime: await this.app.status(),
    };
  }
}
