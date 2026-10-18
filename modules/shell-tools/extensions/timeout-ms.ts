import {
  createBashToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  createPowerShellToolDefinition,
  SettingsManager,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

import { ShellJobs, compactJob, timeoutMessage } from "../src/background-jobs.js";
import { registerBackgroundLifecycleGuidance } from "../src/background-guidance.js";
import { registerApiInterruptionRenderer } from "../src/api-interruption-renderer.js";
import { isManagedForegroundChild } from "../src/managed-child.js";
import { AUTO_MONITOR_INTERVAL_MS, canonicalMonitorCwd, requestAutoMonitor } from "../src/monitor-capability.js";
import { createForegroundHandoff, resolveAutoBackgroundMs } from "../src/foreground-handoff.js";
import { createShellMonitorPublisher } from "../src/monitor-publisher.js";
import { renderShellCompletion, renderShellJobResult } from "../src/completion-renderer.js";
import { renderShellOutput } from "../src/output-renderer.js";

/** Polling a running job repeats this text each time; keep it short (full tail stays in structuredContent). */
const RUNNING_TAIL_CHARS = 2000;
import { writeFailureDebugLog, type FailureDetails } from "../src/debug-log.mjs";
import {
  MAX_TIMEOUT_MS,
  timeoutMsToRenderSeconds,
  timeoutMsToSeconds,
} from "../src/timeout-ms.mjs";

const display = (text: string, limit: number) => stripVTControlCharacters(text.slice(0, limit))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

const COMMAND_PREVIEW_ROWS = 5;

/** A Text subclass preserves the host's setText/reuse contract and timing state. */
class ShellCommandPreview extends Text {
  omission = "...";

  override render(width: number): string[] {
    if (width <= 0) return [];
    const rows = super.render(width);
    if (rows.length <= COMMAND_PREVIEW_ROWS) return rows;
    // Count actual wrapped terminal rows; the omission row is inside the budget.
    return [...rows.slice(0, COMMAND_PREVIEW_ROWS - 1), truncateToWidth(this.omission, width)];
  }
}

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  background: Type.Optional(Type.Boolean({ description: "Run as a background job: returns a receipt at once and wakes this session on completion. Cancelled on quit, reload or session replacement." })),
  timeoutMs: Type.Optional(
    Type.Integer({
      description:
        "Total timeout in ms from launch (process startup included): the command is killed when it elapses, even if still producing output. Omit for no timeout.",
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
    }),
  ),
}, { additionalProperties: false });

// The host appends its own diagnostic as the LAST status line (`appendStatus`: output + blank line + status). Only that trailing
// line is rewritten; identical text earlier in the command output is user data and must stay verbatim. Once rewritten the
// message no longer matches, so applying this at several catch layers is idempotent.
const TIMED_OUT = /(^|\n)Command timed out after (\S+) seconds\s*$/;
const timedOutMessage = (message: string, foregroundOnly = false) => message.replace(TIMED_OUT, (_m, lead: string, seconds: string) => {
  const text = timeoutMessage(seconds);
  return lead + (foregroundOnly ? text.replace(/ Use background:true separately if you want asynchronous execution\./, "") : text);
});

const receiptSchema = Type.Object({
  jobId: Type.String(), status: Type.Literal("running"), liveLogPath: Type.String(),
}, { additionalProperties: false });

function createConfiguredBashDefinition(pi: ExtensionAPI, ctx: ExtensionContext, wrap: (ops: BashOperations) => BashOperations = ops => ops) {
  // Read the host's effective settings at execution time, including trust-aware
  // project settings and SDK in-memory overrides. Do not independently reread disk.
  const settings = pi.getSettings();
  // Reuse Pi's public normalization for ~, file URLs, and Windows shell paths.
  // This temporary manager is strictly in-memory and performs no file I/O.
  const shellPath = SettingsManager.inMemory({ shellPath: settings.shellPath }).getShellPath();
  return createBashToolDefinition(ctx.cwd, {
    shellPath,
    commandPrefix: settings.shellCommandPrefix,
    operations: wrap(createLocalBashOperations({ shellPath })),
  });
}

function registerTimeoutMsOverride(
  pi: ExtensionAPI,
  name: "bash" | "powershell",
  createBase: typeof createBashToolDefinition | typeof createPowerShellToolDefinition,
  createConfiguredBase: (ctx: ExtensionContext, wrap?: (ops: BashOperations) => BashOperations) => ReturnType<typeof createBashToolDefinition>,
  jobs: ShellJobs | undefined,
  foregroundOnly = false,
) {
  // Keep the built-in renderer and tool metadata. Execution recreates the
  // built-in definition with the current session's cwd and shell settings.
  const base = createBase(process.cwd());

  const timeoutGuideline = `For ${name}, timeoutMs is a total time limit in milliseconds, not seconds (20000 = stop after 20 seconds). Set it above the longest expected run time, with margin for startup, or omit it for no limit${foregroundOnly ? "." : "; background mode applies the same total limit."}`;
  const platformNote = name === "bash"
    ? "On Windows bash needs Git Bash (or shellPath) and applies shellCommandPrefix."
    : "Windows only; shellCommandPrefix is not applied.";
  const descriptionWithoutOldTimeout = base.description.replace(
    /\s*Optionally provide a timeout in seconds\./,
    "",
  );

  pi.registerTool({
    ...base,
    // Override the schema, not the user's loadout. Pi activates this tool only
    // when selected by defaults, --tools, or setActiveTools().
    defaultActive: false,
    description: foregroundOnly
      ? `${descriptionWithoutOldTimeout} timeoutMs is a total time limit in ms from launch. Commands run synchronously until completion. ${platformNote}`
      : `${descriptionWithoutOldTimeout} timeoutMs is a total time limit in ms from launch (foreground and background). A foreground command without timeoutMs still running after 180s is moved to a background job automatically (same process, not restarted) and you get a job receipt; the turn's abort no longer stops it, use shell_job_cancel. background:true returns a jobId/liveLogPath receipt (no exit code) and reports completion automatically; without timeoutMs it also auto-starts a display-only Monitor sampling every 180s; shell_job_status/cancel need explicit selection. ${platformNote}`,
    parameters: foregroundOnly ? Type.Omit(parameters, ["background"], { additionalProperties: false }) : parameters,
    outputSchema: foregroundOnly ? base.outputSchema! : Type.Union([base.outputSchema!, receiptSchema]),
    promptGuidelines: [...(base.promptGuidelines ?? []), timeoutGuideline],
    renderCall: base.renderCall && ((args, theme, context) => {
      const timeoutMs = args?.timeoutMs;
      // Streaming can provide incomplete/missing args. Old sessions only carry
      // the legacy seconds-based timeout; leave those arguments unchanged.
      const renderArgs = timeoutMs === undefined
        ? args
        : { ...args, timeout: timeoutMsToRenderSeconds(timeoutMs) };
      const preview = context.lastComponent instanceof ShellCommandPreview
        ? context.lastComponent
        : new ShellCommandPreview("", 0, 0);
      const timeout = (renderArgs as { timeout?: unknown } | undefined)?.timeout;
      const timeoutSuffix = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? ` (timeout ${timeout}s)` : "";
      const omission = `...${timeoutSuffix}`;
      preview.omission = theme?.fg("muted", omission) ?? omission;
      return base.renderCall!(renderArgs, theme, { ...context, lastComponent: preview });
    }),
    renderResult: base.renderResult && ((result, options, theme, context) => {
      const receipt = result.structuredContent as { jobId?: unknown; status?: unknown; liveLogPath?: unknown } | undefined;
      if (!options.isPartial && !result.isError && !context.isError && receipt?.status === "running" && typeof receipt.jobId === "string" && typeof receipt.liveLogPath === "string") {
        // Receipt latency is not background job duration. Do not change the host's synchronous renderer.
        context.state.endedAt ??= Date.now();
        if (context.state.interval) { clearInterval(context.state.interval); context.state.interval = undefined; }
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const timing = typeof context.state.startedAt === "number" ? `\nAccepted in ${((context.state.endedAt - context.state.startedAt) / 1000).toFixed(1)}s` : "";
        return new Text(theme.fg("muted", display(text, 8192) + timing), 0, 0);
      }
      return renderShellOutput(base.renderResult!, result as Parameters<NonNullable<typeof base.renderResult>>[0], options, theme, context);
    }),
    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const startedAt = performance.now();
      const logFailure = async (failure: FailureDetails) => {
        try {
          await writeFailureDebugLog({
            tool: name,
            toolCallId,
            cwd: ctx?.cwd,
            sessionId: ctx?.sessionManager?.getSessionId(),
            elapsedMs: Math.round(performance.now() - startedAt),
            input,
            failure,
          });
        } catch {
          // Diagnostics, including context metadata lookup, must remain nonfatal.
        }
      };
      try {
        if (!ctx) throw new Error("Pi did not provide the shell tool execution context");
        // Presence is rejected, even false/undefined, including direct execute
        // calls that bypass host schema validation. No settings/backend/spawn yet.
        if (foregroundOnly && "background" in input) throw new Error("Managed subagent Shell is foreground-only; background is not accepted.");
        // Schema validation can be skipped when AJV is unavailable, so reject the
        // legacy seconds field explicitly instead of silently running unbounded.
        if ((input as { timeout?: unknown }).timeout !== undefined) {
          throw new Error(
            `${name} no longer accepts timeout (seconds); use timeoutMs in milliseconds, e.g. 20000 for 20 seconds.`,
          );
        }
        const backgroundInput = (input as { background?: unknown }).background;
        if (backgroundInput !== undefined && typeof backgroundInput !== "boolean") throw new Error("background must be a boolean");
        if (typeof input.command !== "string") throw new Error("command must be a string");
        const timeout = timeoutMsToSeconds(input.timeoutMs);
        const command = input.command;
        const background = backgroundInput === true;
        // Snapshot effective shell settings before accepting, rather than reading
        // a later turn's overrides when the deferred runner starts.
        let jobWrap: ((ops: BashOperations) => BashOperations) | undefined;
        const configuredBase = createConfiguredBase(ctx, operations => ({
          exec: (command, cwd, options) => (jobWrap ? jobWrap(operations) : operations).exec(command, cwd, options),
        }));
        let handedOff = false;
        const run = async (executionSignal: AbortSignal | undefined, wrap?: (ops: BashOperations) => BashOperations, updates: typeof onUpdate = background ? undefined : onUpdate) => {
          jobWrap = wrap;
          try {
            if (executionSignal?.aborted && background) throw new Error("Command aborted");
            const result = await configuredBase.execute(toolCallId, { command, timeout }, executionSignal, updates, ctx);
            if (result.isError === true) await logFailure({ kind: "error-result", result });
            return result;
          } catch (error) {
            if (background || handedOff) await logFailure({ kind: "exception", error });
            if (error instanceof Error && input.timeoutMs !== undefined) {
              const timedOut = timedOutMessage(error.message, foregroundOnly);
              if (timedOut !== error.message) throw new Error(timedOut, { cause: error });
            }
            throw error;
          }
        };
        const receiptResult = (receipt: { jobId: string; status: "running"; liveLogPath: string }, headline: string) => {
          // A job without timeoutMs has no upper bound, so ask Monitor for a display-only sampler (best effort).
          let monitorId: string | undefined;
          if (input.timeoutMs === undefined) {
            try { monitorId = requestAutoMonitor({ sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) }, receipt.jobId); } catch { /* monitor is optional */ }
          }
          const monitorNote = monitorId ? `\nMonitor ${monitorId} samples this job every ${AUTO_MONITOR_INTERVAL_MS / 1000}s (display only, no model wake-up; monitor_stop to stop it).` : "";
          // The receipt names only what this loadout can actually do.
          let canQuery = false;
          try { canQuery = pi.getActiveTools?.().includes("shell_job_status") ?? false; } catch { /* host may not expose it */ }
          const next = canQuery
            ? "Progress: shell_job_status or read log tail. Completion is auto-reported."
            : "Progress: read log tail. Completion is auto-reported (shell_job_status/cancel not selected).";
          return { content: [{ type: "text" as const, text: `${headline}\njob ${receipt.jobId} running\nlog ${receipt.liveLogPath}\n${next}${monitorNote}` }], details: undefined, structuredContent: receipt };
        };
        if (background) {
          if (!jobs) throw new Error("Managed subagent Shell is foreground-only");
          return receiptResult(jobs.submit(ctx, name, toolCallId, signal, run, command), "Background job accepted; its outcome will be reported when it finishes.");
        }
        const autoMs = jobs && input.timeoutMs === undefined ? resolveAutoBackgroundMs(pi.getSettings?.()) : 0;
        if (autoMs === 0) return await run(signal);
        // Safety net for a foreground command without timeoutMs (e.g. an endless loop): after autoMs the SAME process
        // is adopted by a background job, so the turn is released. The process is never restarted.
        const handoff = createForegroundHandoff();
        const foreground = new AbortController();
        const forwardAbort = () => foreground.abort(signal?.reason);
        if (signal?.aborted) forwardAbort(); else signal?.addEventListener("abort", forwardAbort, { once: true });
        const unlink = () => signal?.removeEventListener("abort", forwardAbort);
        const running = run(foreground.signal, handoff.wrap, onUpdate && (update => { if (!handedOff) onUpdate(update); }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          running.then(value => ({ value }), error => ({ error })),
          new Promise<"timer">(resolve => { timer = setTimeout(() => resolve("timer"), autoMs); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome !== "timer") {
          unlink();
          if ("error" in outcome) throw outcome.error;
          return outcome.value;
        }
        if (signal?.aborted) { unlink(); return await running; }
        let receipt;
        let unlinkJob: (() => void) | undefined;
        try {
          receipt = jobs!.submit(ctx, name, toolCallId, undefined, async (jobSignal, wrap) => {
            try {
              handoff.attach(wrap, ctx.cwd, jobSignal);
              return await running;
            } finally { unlinkJob?.(); unlinkJob = undefined; }
          }, command, jobSignal => {
            // Link cancellation at acceptance, not inside the deferred runner: that boundary may never
            // run (owner replaced first), and the adopted process must not outlive the job that owns it.
            const onJobAbort = () => foreground.abort(jobSignal.reason);
            if (jobSignal.aborted) { onJobAbort(); return; }
            jobSignal.addEventListener("abort", onJobAbort, { once: true });
            unlinkJob = () => jobSignal.removeEventListener("abort", onJobAbort);
          });
        } catch {
          // No capacity (or owner unavailable): stay a normal foreground command, still linked to the turn's abort.
          unlinkJob?.(); unlinkJob = undefined;
          try { return await running; } finally { unlink(); }
        }
        handedOff = true; unlink();
        return receiptResult(receipt, `Command still running after ${autoMs / 1000}s without timeoutMs; moved to a background job automatically (the same process keeps running; Esc no longer stops it, use shell_job_cancel). Its outcome will be reported when it finishes.`);
      } catch (error) {
        await logFailure({ kind: "exception", error });
        // Replace the host's bare timeout line with one naming timeoutMs and the way out.
        if (input.timeoutMs !== undefined && error instanceof Error) {
          const timedOut = timedOutMessage(error.message, foregroundOnly);
          if (timedOut !== error.message) throw new Error(timedOut, { cause: error });
        }
        throw error;
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  const foregroundOnly = isManagedForegroundChild();
  if (foregroundOnly) {
    registerApiInterruptionRenderer(pi);
    registerShells(pi, undefined, true);
    return;
  }
  registerBackgroundLifecycleGuidance(pi);
  registerApiInterruptionRenderer(pi);
  pi.registerMessageRenderer("shell-job-completed", renderShellCompletion);
  const jobs = new ShellJobs(pi);
  const monitorPublisher = createShellMonitorPublisher(jobs);
  pi.on("session_start", (_event, ctx) => { monitorPublisher.stop(); jobs.start(ctx); monitorPublisher.start(ctx); });
  pi.on("agent_settled", (_event, ctx) => { jobs.flushPending(ctx); });
  pi.on("session_compact", (_event, ctx) => { jobs.flushPending(ctx); });
  pi.on("session_compact_failed", (_event, ctx) => { jobs.flushPending(ctx); });
  pi.on("session_tree", (_event, ctx) => { jobs.flushPending(ctx); });
  pi.on("session_shutdown", event => { monitorPublisher.stop(); return jobs.shutdown(event.reason); });
  const jobFields = {
    jobId: Type.String(), status: Type.String(), tool: Type.String(), toolCallId: Type.String(), command: Type.String(),
    startedAt: Type.String(), elapsedMs: Type.Number(), logBytes: Type.Number(), cancelRequested: Type.Boolean(),
    liveLogPath: Type.String(), logPath: Type.String(), outputTruncated: Type.Boolean(),
    exitCode: Type.Optional(Type.Number()), error: Type.Optional(Type.String()),
  };
  const jobSchema = Type.Object({
    ...jobFields, output: Type.Optional(Type.String()), outputTail: Type.Optional(Type.String()),
  }, { additionalProperties: false });
  const listSchema = Type.Object({ jobs: Type.Array(Type.Object(jobFields, { additionalProperties: false })) }, { additionalProperties: false });
  for (const action of ["status", "cancel"] as const) {
    pi.registerTool({
      name: `shell_job_${action}`, label: `Shell job ${action}`, defaultActive: false,
      description: action === "status"
        ? "Shell background jobs owned by this session. With jobId: status, exit code, head output (output) and last ~8 KiB (outputTail; only the last 2000 characters while the job is running, read liveLogPath for more). Without jobId: list jobs (running first) with command, start time and elapsed time."
        : "Request cancellation of a shell background job owned by this session. cancelling does not confirm the process tree has exited.",
      parameters: Type.Object(action === "status"
        ? { jobId: Type.Optional(Type.String({ description: "Job to inspect; omit to list all jobs." })) }
        : { jobId: Type.String() }, { additionalProperties: false }),
      outputSchema: action === "status" ? Type.Union([jobSchema, listSchema]) : jobSchema,
      renderCall(args, theme) {
        return new Text(theme.fg("toolTitle", `Shell job ${action} ${display(typeof args?.jobId === "string" ? args.jobId : action === "status" ? "(list)" : "…", 64)}`), 0, 0);
      },
      renderResult(result, options, theme, context) {
        const component = renderShellJobResult(result, options, theme, context)!;
        const status = (result.structuredContent as { status?: string } | undefined)?.status;
        if (action !== "cancel" || result.isError || !status || status === "running" || status === "cancelling") return component;
        const notice = new Text(theme.fg("dim", "Job already finished; no new cancellation was requested. The existing outcome is unchanged."), 0, 0);
        return { invalidate() { component.invalidate(); notice.invalidate(); }, render(width) { return [...notice.render(width), ...component.render(width)].slice(0, 300); } };
      },
      async execute(_id, input, _signal, _onUpdate, ctx) {
        const result = action === "status" && input.jobId === undefined
          ? { jobs: jobs.list(ctx) }
          : jobs[action](ctx, input.jobId as string);
        // Model text is compacted; structuredContent keeps the full schema-compatible result.
        const text = "jobs" in result
          ? JSON.stringify(result.jobs.map(j => ({ jobId: j.jobId, status: j.status, command: j.command.slice(0, 80), elapsedMs: j.elapsedMs, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.error ? { error: j.error } : {}) })))
          : JSON.stringify(compactJob(result, { output: action === "status", outputLimit: result.status === "running" || result.status === "cancelling" ? RUNNING_TAIL_CHARS : undefined })) + (action === "cancel" ? result.status === "cancelling" ? "\nCancellation requested; waiting for cleanup. Exit of all descendant processes is not confirmed." : "\nJob already finished; no new cancellation was requested. The existing outcome is unchanged." : "");
        return { content: [{ type: "text", text }], details: undefined, structuredContent: result };
      },
    });
  }
  registerShells(pi, jobs);
}

function registerShells(pi: ExtensionAPI, jobs?: ShellJobs, foregroundOnly = false) {
  registerTimeoutMsOverride(
    pi,
    "bash",
    createBashToolDefinition,
    (ctx, wrap) => createConfiguredBashDefinition(pi, ctx, wrap),
    jobs,
    foregroundOnly,
  );
  registerTimeoutMsOverride(
    pi,
    "powershell",
    createPowerShellToolDefinition,
    // Pi's PowerShell tool options accept no shellPath/commandPrefix, so
    // Bash-only shell settings intentionally do not apply here.
    (ctx, wrap = ops => ops) => createPowerShellToolDefinition(ctx.cwd, {
      operations: wrap(createLocalPowerShellOperations()),
    }),
    jobs,
    foregroundOnly,
  );
}
