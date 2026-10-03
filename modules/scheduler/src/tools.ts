import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SchedulerService } from "./scheduler-service.js";
import { ToolDebugLogger } from "./tool-debug-log.js";
import { scheduleRenderers } from "./renderers.js";

const timing = Type.Object({
  kind: Type.Union([Type.Literal("once"), Type.Literal("cron")]),
  expression: Type.String({ minLength: 1, description: "once: future ISO timestamp WITH offset/Z; cron: Croner expression." }),
  timezone: Type.String({ minLength: 1, description: "Explicit IANA timezone, e.g. Asia/Taipei." }),
}, { additionalProperties: false });
const execution = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingLevel: Type.Optional(Type.Union((["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((v) => Type.Literal(v)))),
}, { additionalProperties: false });
const prompt = Type.String({ minLength: 1, maxLength: 32_000, description: "Self-contained future task instructions; independent jobs have no current conversation context. Never include credentials." });
const id = Type.String({ minLength: 1 });
const runtimeOutput = Type.Object({ role: Type.String() }, { additionalProperties: true });
const mutationOutput = Type.Object({ schedule: Type.Object({ id: Type.String(), revision: Type.Integer() }, { additionalProperties: true }), runtime: runtimeOutput }, { additionalProperties: true });
const result = (details: object) => {
  const text = JSON.stringify(details, null, 2);
  return { content: [{ type: "text" as const, text }], details, structuredContent: JSON.parse(text) };
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
    description: "Schedule an explicitly requested future task. Runs while Pi is open, without an OS service. Use schedule_status first to resolve local time. New independent session is default; pass the current sessionId (or mode=session) to run in this session while it is open and idle. Missed times are not backfilled. Do not promise execution while all apps are closed.",
    promptSnippet: "Schedule a future task while Pi is open (once or cron).",
    promptGuidelines: ["Use schedule_create only when the user explicitly requests scheduling. Confirm the resulting exact date/time/timezone and open-app requirement. Use schedule_status for current time, never guess relative dates. projectTrust requires explicit authorization; do not turn it on merely to avoid a trust error."],
    parameters: Type.Object({
      prompt, timing,
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Optional session title to apply when this schedule runs." })),
      mode: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("session")])),
      sessionId: Type.Optional(Type.String({ minLength: 1, description: "Use the current Pi session; must match this session's ID. Omit to run in a new session." })),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Defaults to current cwd. Session mode cannot change cwd." })),
      execution: Type.Optional(execution),
      projectTrust: Type.Optional(Type.Boolean({ description: "Explicit permission to pass --approve to the child Pi. Defaults false; never infer consent." })),
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
      projectTrust: Type.Optional(Type.Boolean()),
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
    outputSchema: Type.Object({ now: Type.String(), timezone: Type.String(), total: Type.Integer(), schedules: Type.Array(Type.Unknown()), runs: Type.Array(Type.Unknown()), runtime: runtimeOutput }, { additionalProperties: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Read current date/time/timezone, local host/standby/error state, persisted schedules with revisions and next times, and recent execution history. Supports pagination; no work is executed.",
    parameters: Type.Object({
      id: Type.Optional(id), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
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
}
