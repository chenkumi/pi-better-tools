import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SchedulerService } from "./scheduler-service.js";
import { ToolDebugLogger } from "./tool-debug-log.js";
import { scheduleRenderers } from "./renderers.js";

const timing = Type.Object({
  kind: Type.Union([Type.Literal("once"), Type.Literal("cron")]),
  expression: Type.String({ minLength: 1, description: "once: future ISO timestamp with offset/Z (2030-09-29T11:10:00+08:00). cron: 5 fields `minute hour day-of-month month day-of-week` (optional leading seconds; firings >= 1 minute apart); if both day-of-month and day-of-week are set, a day matching EITHER fires. e.g. `0 9 * * 1-5` = 09:00 Mon-Fri." }),
  timezone: Type.String({ minLength: 1, description: "Explicit IANA timezone, e.g. Asia/Taipei." }),
}, { additionalProperties: false });
const execution = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingLevel: Type.Optional(Type.Union((["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((v) => Type.Literal(v)))),
}, { additionalProperties: false });
const prompt = Type.String({ minLength: 1, maxLength: 32_000, description: "Self-contained future task instructions; independent jobs have no current conversation context. Never include credentials. Do not ask the scheduled run to create more schedules." });
const id = Type.String({ minLength: 1 });
// List output is a summary (empty/default fields omitted); schedule detail adds prompt, cwd, timing, consumed.
const scheduleView = Type.Object({
  id: Type.String(), revision: Type.Integer(), state: Type.String(), mode: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), timing: Type.Optional(Type.Object({ kind: Type.String(), expression: Type.String(), timezone: Type.String() }, { additionalProperties: true })),
  nextRun: Type.Optional(Type.Union([Type.String(), Type.Null()])), consumed: Type.Optional(Type.Boolean()), lastRunAt: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()), projectTrust: Type.Optional(Type.Boolean()), lastRunId: Type.Optional(Type.String()), targetSessionId: Type.Optional(Type.String()),
}, { additionalProperties: true });
const runView = Type.Object({
  runId: Type.String(), scheduleId: Type.String(), mode: Type.String(), status: Type.String({ description: "Includes `missed` (a time that was not backfilled) and `skipped_busy`." }), plannedAt: Type.String(),
  startedAt: Type.Optional(Type.String()), endedAt: Type.Optional(Type.String()), error: Type.Optional(Type.String()), outputSummary: Type.Optional(Type.String()),
  capacitySkipped: Type.Optional(Type.Boolean({ description: "Present (true) when skipped because the host child-process limit was reached." })),
}, { additionalProperties: true });
const resultView = Type.Object({
  runId: Type.String(), scheduleId: Type.String(), status: Type.String(), error: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal("final_assistant_text"), Type.Literal("log_excerpt"), Type.Literal("session_output_summary"), Type.Literal("none")]),
  tail: Type.String(), truncated: Type.Boolean(),
}, { additionalProperties: true });
const runtimeOutput = Type.Object({ role: Type.String() }, { additionalProperties: true });
const mutationOutput = Type.Object({ schedule: Type.Object({ id: Type.String(), revision: Type.Integer() }, { additionalProperties: true }), runtime: runtimeOutput }, { additionalProperties: true });
// One serialization: compact JSON text for the model plus the same data as structuredContent (outputSchema contract).
// No separate `details` copy; renderers read structuredContent.
const result = (data: object) => {
  const text = JSON.stringify(data);
  return { content: [{ type: "text" as const, text }], details: undefined, structuredContent: JSON.parse(text) };
};

export function registerScheduleTools(pi: ExtensionAPI, service: SchedulerService, debugLogger = new ToolDebugLogger()): void {
  const execute = async <T>(name: string, toolCallId: string, action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) {
      await debugLogger.logFailure(name, toolCallId, error);
      throw error;
    }
  };
  pi.registerTool({
    name: "schedule_create", label: "Create schedule",
    ...scheduleRenderers("create"),
    outputSchema: mutationOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Schedule an explicitly requested future task. Runs only while Pi stays open (no OS service); never promise execution while all Pi windows are closed. Use schedule_status first to resolve local time. Default is a new independent headless Pi session; mode=session runs in the current session instead, only while it is open and idle. " +
      "Missed times are not backfilled: a cron firing more than 60 seconds late is recorded with status missed and skipped. A firing is also skipped (recorded as skipped_busy, never queued) when the host already runs 4 child processes, or in session mode when the session is busy. " +
      "Do not put schedule_create/update/cancel/delete instructions inside the scheduled prompt.",
    promptSnippet: "Schedule a future task while Pi is open (once or cron).",
    promptGuidelines: ["Use schedule_create only when the user explicitly requests scheduling. Confirm the resulting exact date/time/timezone and open-app requirement. Use schedule_status for current time, never guess relative dates. projectTrust requires explicit authorization; do not turn it on merely to avoid a trust error. Never write instructions that create further schedules inside a scheduled prompt."],
    parameters: Type.Object({
      prompt, timing,
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Optional session title to apply when this schedule runs." })),
      mode: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("session")], { description: "independent (default): a new headless Pi per run. session: run inside the current session when it is idle (busy means skipped); the session is taken from the calling context." })),
      sessionId: Type.Optional(Type.String({ minLength: 1, description: "Only the calling session's own ID, supplied by the host context and never invented; it must equal the current session. Normally omit it and use mode=session. Omit both to run in a new session." })),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Defaults to current cwd. Session mode cannot change cwd." })),
      execution: Type.Optional(execution),
      projectTrust: Type.Optional(Type.Boolean({ description: "Explicit user permission to pass --approve to the child Pi (trusts project-local extensions/settings). Default false. Do not set true on your own; only when the user explicitly asks for it." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _update, ctx) {
      return execute("schedule_create", toolCallId, async () => {
        signal?.throwIfAborted();
        return result(await service.create(params, ctx));
      });
    },
  });
  pi.registerTool({
    name: "schedule_update", label: "Update schedule",
    ...scheduleRenderers("update"),
    outputSchema: mutationOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Update or pause/resume a schedule using its latest revision from schedule_status. Changing timing can re-arm a consumed once job. Does not interrupt an active run; use schedule_cancel for cancellation.",
    parameters: Type.Object({ id, revision: Type.Integer({ minimum: 1 }), patch: Type.Object({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      prompt: Type.Optional(prompt), timing: Type.Optional(timing), execution: Type.Optional(execution),
      projectTrust: Type.Optional(Type.Boolean({ description: "Default false. Set true only when the user explicitly authorizes --approve for the child Pi; never on your own." })),
      state: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])),
    }, { additionalProperties: false, minProperties: 1 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      return execute("schedule_update", toolCallId, async () => { signal?.throwIfAborted(); return result(await service.update(params)); });
    },
  });
  pi.registerTool({
    name: "schedule_status", label: "Schedule status",
    ...scheduleRenderers("status"),
    outputSchema: Type.Object({ now: Type.String(), timezone: Type.String(), total: Type.Integer(), schedules: Type.Array(scheduleView), runs: Type.Array(runView), result: Type.Optional(resultView), runtime: runtimeOutput }, { additionalProperties: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Read current date/time/timezone, local host/standby/error state, persisted schedules with revisions and next times, and recent execution history. The list is a summary (id, title, state, revision, next/last time); pass id for full schedule detail. A time that was not backfilled has run status missed. Pass runId to also get a bounded tail (about 2000 chars) of that run's final assistant text or output in `result`. Supports pagination; no work is executed.",
    parameters: Type.Object({
      id: Type.Optional(id), runId: Type.Optional(Type.String({ minLength: 1, description: "Also return the result tail of this run (a runs[].runId)." })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), runsLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      return execute("schedule_status", toolCallId, async () => { signal?.throwIfAborted(); return result(await service.status(params)); });
    },
  });
  pi.registerTool({
    name: "schedule_cancel", label: "Cancel schedule",
    ...scheduleRenderers("cancel"),
    outputSchema: Type.Object({ cancellationRequested: Type.Array(Type.String()), note: Type.String(), runtime: runtimeOutput }, { additionalProperties: true }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Supply exactly one target: id disables future schedule occurrences (cancelRunning defaults false), or runId requests stopping only that run. Cancellation is asynchronous; check schedule_status. Never claims a remote process was terminated.",
    parameters: Type.Object({ id: Type.Optional(id), runId: Type.Optional(id), cancelRunning: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      return execute("schedule_cancel", toolCallId, async () => { signal?.throwIfAborted(); return result(await service.cancel(params)); });
    },
  });
  pi.registerTool({
    name: "schedule_delete", label: "Delete schedule",
    ...scheduleRenderers("delete"),
    outputSchema: Type.Object({ deleted: Type.Object({ id: Type.String(), revision: Type.Integer() }, { additionalProperties: true }), prunedRuns: Type.Integer(), note: Type.String(), runtime: runtimeOutput }, { additionalProperties: true }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Permanently delete a schedule that is already disabled (paused or cancelled), using its latest revision from schedule_status. Active schedules are refused: call schedule_cancel first. Also refused while the schedule has an active or orphaned run. Removes the schedule record and its finished run history; cannot be undone.",
    parameters: Type.Object({ id, revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      return execute("schedule_delete", toolCallId, async () => { signal?.throwIfAborted(); return result(await service.delete(params)); });
    },
  });
}
