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

import { ShellJobs, compactJob, isActiveJobStatus, timeoutMessage } from "../src/background-jobs.js";
import { registerBackgroundLifecycleGuidance } from "../src/background-guidance.js";
import { registerApiInterruptionRenderer } from "../src/api-interruption-renderer.js";
import { isManagedForegroundChild } from "../src/managed-child.js";
import { AUTO_MONITOR_INTERVAL_MS, canonicalMonitorCwd, requestAutoMonitor } from "../src/monitor-capability.js";
import { createForegroundHandoff, resolveAutoBackgroundMs } from "../src/foreground-handoff.js";
import { DETACH_HINT, ensureDetachShortcut, forgetToolRow, isForegroundDetachable, rememberToolRow, trackForeground } from "../src/manual-detach.js";
import { addDetachHint } from "../src/detach-hint.js";
import { createShellMonitorPublisher } from "../src/monitor-publisher.js";
import { renderShellCompletion, renderShellJobResult } from "../src/completion-renderer.js";
import { renderShellOutput } from "../src/output-renderer.js";
import { writeFailureDebugLog, type FailureDetails } from "../src/debug-log.mjs";
import {
  MAX_TIMEOUT_MS,
  describeReceived,
  timeoutMsToRenderSeconds,
  timeoutMsToSeconds,
} from "../src/timeout-ms.mjs";

/** Polling a running job repeats this text each time; keep it short (full tail stays in structuredContent). */
const RUNNING_TAIL_CHARS = 2000;
const ALREADY_FINISHED_NOTICE = "Job already finished; no new cancellation was requested. The existing outcome is unchanged.";

const display = (text: string, limit: number) => stripVTControlCharacters(text.slice(0, limit))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

const COMMAND_PREVIEW_ROWS = 5;

/** A Text subclass preserves the host's setText/reuse contract and timing state. */
class ShellCommandPreview extends Text {
  omission = "...";
  /** Last line while this call can still be moved to a background job with the detach shortcut. */
  hint?: string;

  override render(width: number): string[] {
    if (width <= 0) return [];
    const rows = super.render(width);
    // Count actual wrapped terminal rows; the omission row is inside the budget.
    const lines = rows.length <= COMMAND_PREVIEW_ROWS ? rows : [...rows.slice(0, COMMAND_PREVIEW_ROWS - 1), truncateToWidth(this.omission, width)];
    return this.hint ? [...lines, "", truncateToWidth(this.hint, width, "…")] : lines;
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

/** Replaces the host's bare timeout line with one naming timeoutMs and the way out; every other error passes through. */
function withTimeoutHint(error: unknown, timeoutMs: unknown, foregroundOnly: boolean): unknown {
  if (timeoutMs === undefined || !(error instanceof Error)) return error;
  const timedOut = timedOutMessage(error.message, foregroundOnly);
  return timedOut !== error.message ? new Error(timedOut, { cause: error }) : error;
}

/**
 * Validates the raw input in a fixed order, before any settings read, backend creation or spawn. Presence of
 * `background` is rejected for a managed child, even false/undefined, including direct execute calls that
 * bypass host schema validation.
 */
const FOREGROUND_ONLY_MESSAGE = "Managed subagent Shell is foreground-only; background is not accepted. Remove the background parameter and run in the foreground, bounding it with timeoutMs if needed.";

function parseShellInput(name: string, input: Record<string, unknown>, foregroundOnly: boolean) {
  if (foregroundOnly && "background" in input) throw new Error(FOREGROUND_ONLY_MESSAGE);
  // Schema validation can be skipped when AJV is unavailable, so reject the
  // legacy seconds field explicitly instead of silently running unbounded.
  if (input.timeout !== undefined) {
    throw new Error(
      `${name} no longer accepts timeout (seconds); use timeoutMs in milliseconds, e.g. 20000 for 20 seconds.`,
    );
  }
  const backgroundInput = input.background;
  if (backgroundInput !== undefined && typeof backgroundInput !== "boolean") throw new Error(`background must be a boolean (true or false); received ${describeReceived(backgroundInput)}. Omit it for a foreground command.`);
  if (typeof input.command !== "string") throw new Error(`command is required and must be a string containing the shell command to run; received ${input.command === undefined ? "undefined" : input.command === null ? "null" : typeof input.command}.`);
  const timeout = timeoutMsToSeconds(input.timeoutMs as number | undefined);
  return { command: input.command, timeout, background: backgroundInput === true };
}

/** After a rejected handoff the safety net tries again at most this often. */
const RETRY_HANDOFF_MS = 5000;

type Receipt = { jobId: string; status: "running"; liveLogPath: string };

function receiptResult(pi: ExtensionAPI, ctx: ExtensionContext, timeoutMs: unknown, receipt: Receipt, headline: string) {
  // A job without timeoutMs has no upper bound, so ask Monitor for a display-only sampler (best effort).
  let monitorId: string | undefined;
  if (timeoutMs === undefined || timeoutMs === MAX_TIMEOUT_MS) {
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
}

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
    // User-requested default activation for the main agent; host --tools,
    // --exclude-tools, --no-tools and manual deactivation still win. Managed
    // subagent children keep their loadout controlled by the argument builder.
    defaultActive: !foregroundOnly,
    description: foregroundOnly
      ? `${descriptionWithoutOldTimeout} timeoutMs is a total time limit in ms from launch. Commands run synchronously until completion. ${platformNote}`
      : `${descriptionWithoutOldTimeout} timeoutMs is a total time limit in ms from launch (foreground and background). A foreground command without timeoutMs still running after 180s is moved to a background job automatically (same process, not restarted) and you get a job receipt; the turn's abort no longer stops it, use shell_job_cancel. background:true returns a jobId/liveLogPath receipt (no exit code) and reports completion automatically; without timeoutMs it also auto-starts a display-only Monitor sampling every 180s; shell_job_status/cancel are active by default unless the host excludes them. ${platformNote}`,
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
      // The detach hint belongs to the call itself: its own last line, never the status bar. Once output streams, the result
      // region below carries it instead, and a finished call keeps the host layout unchanged.
      if (context.durationMs !== undefined) forgetToolRow(context.toolCallId);
      else rememberToolRow(context.toolCallId, context.invalidate);
      preview.hint = theme && isForegroundDetachable(context.toolCallId) && !context.isPartial ? theme.fg("muted", DETACH_HINT) : undefined;
      return base.renderCall!(renderArgs, theme, { ...context, lastComponent: preview });
    }),
    renderResult: base.renderResult && ((result, options, theme, context) => {
      const hint = { toolCallId: context.toolCallId, theme, invalidate: context.invalidate, finished: context.durationMs !== undefined };
      const receipt = result.structuredContent as { jobId?: unknown; status?: unknown; liveLogPath?: unknown } | undefined;
      if (!options.isPartial && !result.isError && !context.isError && receipt?.status === "running" && typeof receipt.jobId === "string" && typeof receipt.liveLogPath === "string") {
        // Receipt latency is not background job duration. Do not change the host's synchronous renderer.
        context.state.endedAt ??= Date.now();
        if (context.state.interval) { clearInterval(context.state.interval); context.state.interval = undefined; }
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const timing = typeof context.state.startedAt === "number" ? `\nAccepted in ${((context.state.endedAt - context.state.startedAt) / 1000).toFixed(1)}s` : "";
        return new Text(theme.fg("muted", display(text, 8192) + timing), 0, 0);
      }
      return addDetachHint(renderShellOutput(base.renderResult!, result as Parameters<NonNullable<typeof base.renderResult>>[0], options, theme, context), hint);
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
        if (!ctx) throw new Error("Pi did not provide the shell tool execution context (host fault); the command was not run. Retry the call.");
        const { command, timeout, background } = parseShellInput(name, input as Record<string, unknown>, foregroundOnly);
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
            throw withTimeoutHint(error, input.timeoutMs, foregroundOnly);
          }
        };
        if (background) {
          if (!jobs) throw new Error(FOREGROUND_ONLY_MESSAGE);
          return receiptResult(pi, ctx, input.timeoutMs, jobs.submit(ctx, name, toolCallId, signal, run, command), "Background job accepted; its outcome will be reported when it finishes.");
        }
        const autoMs = jobs && (input.timeoutMs === undefined || input.timeoutMs === MAX_TIMEOUT_MS) ? resolveAutoBackgroundMs(pi.getSettings?.()) : 0;
        // Without a UI nobody can press the detach shortcut, so only the timer can trigger a handoff.
        if (!jobs || (autoMs === 0 && !ctx.hasUI)) return await run(signal);
        // The SAME process is adopted by a background job, so the turn is released. It is never restarted.
        // Triggers: the user's detach shortcut (any foreground command), or the autoMs safety net for a
        // command without timeoutMs (e.g. an endless loop). A timeoutMs keeps applying inside the adopted run.
        let manualDetach!: () => void;
        let manual!: Promise<"manual">;
        const track = () => {
          manual = new Promise<"manual">(resolve => { manualDetach = () => resolve("manual"); });
          return ctx.hasUI ? trackForeground(toolCallId, manualDetach) : () => {};
        };
        let untrack = track();
        const handoff = createForegroundHandoff();
        const foreground = new AbortController();
        const forwardAbort = () => foreground.abort(signal?.reason);
        if (signal?.aborted) forwardAbort(); else signal?.addEventListener("abort", forwardAbort, { once: true });
        const unlink = () => signal?.removeEventListener("abort", forwardAbort);
        const running = run(foreground.signal, handoff.wrap, onUpdate && (update => { if (!handedOff) onUpdate(update); }));
        const settled = running.then(value => ({ value }), error => ({ error }));
        let waitMs = autoMs;
        let outcome: "manual" | "timer" | { value: Awaited<typeof running> } | { error: unknown };
        let receipt;
        let unlinkJob: (() => void) | undefined;
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          outcome = await Promise.race([
            settled,
            manual,
            ...(waitMs > 0 ? [new Promise<"timer">(resolve => { timer = setTimeout(() => resolve("timer"), waitMs); })] : []),
          ]);
          if (timer !== undefined) clearTimeout(timer);
          untrack();
          if (typeof outcome !== "string") {
            unlink();
            if ("error" in outcome) throw outcome.error;
            return outcome.value;
          }
          if (signal?.aborted) { unlink(); return await running; }
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
            break;
          } catch {
            // No capacity (or owner unavailable): stay a normal foreground command, still linked to the turn's abort.
            unlinkJob?.(); unlinkJob = undefined;
            // A rejection is not final: offer the handoff again (shortcut, steer) and retry the safety net shortly, so the
            // command that was meant to be released is adopted as soon as room appears instead of holding the turn.
            if (waitMs === 0 && !ctx.hasUI) { try { return await running; } finally { unlink(); } }
            untrack = track();
            waitMs = autoMs > 0 ? Math.min(autoMs, RETRY_HANDOFF_MS) : 0;
          }
        }
        handedOff = true; unlink();
        const why = outcome === "manual"
          ? "Command moved to a background job at the user's request"
          : `Command still running after ${autoMs / 1000}s without timeoutMs; moved to a background job automatically`;
        return receiptResult(pi, ctx, input.timeoutMs, receipt, `${why} (the same process keeps running; Esc no longer stops it, use shell_job_cancel). Its outcome will be reported when it finishes.`);
      } catch (error) {
        await logFailure({ kind: "exception", error });
        throw withTimeoutHint(error, input.timeoutMs, foregroundOnly);
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
  ensureDetachShortcut(pi);
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
      name: `shell_job_${action}`, label: `Shell job ${action}`, defaultActive: true,
      description: action === "status"
        ? "Shell background jobs owned by this session. With jobId: status, exit code, head output (output) and last ~8 KiB (outputTail; only the last 2000 characters while the job is running, read liveLogPath for more). Without jobId: list jobs (running first) with command, start time and elapsed time."
        : "Request cancellation of a shell background job owned by this session. cancelling does not confirm the process tree has exited.",
      parameters: Type.Object(action === "status"
        ? { jobId: Type.Optional(Type.String({ description: "Job to inspect; omit to list all jobs." })) }
        : { jobId: Type.String({ description: "Job to cancel: the jobId from the background receipt or from shell_job_status." }) }, { additionalProperties: false }),
      outputSchema: action === "status" ? Type.Union([jobSchema, listSchema]) : jobSchema,
      renderCall(args, theme) {
        return new Text(theme.fg("toolTitle", `Shell job ${action} ${display(typeof args?.jobId === "string" ? args.jobId : action === "status" ? "(list)" : "…", 64)}`), 0, 0);
      },
      renderResult(result, options, theme, context) {
        const component = renderShellJobResult(result, options, theme, context)!;
        const status = (result.structuredContent as { status?: string } | undefined)?.status;
        if (action !== "cancel" || result.isError || !status || isActiveJobStatus(status)) return component;
        const notice = new Text(theme.fg("dim", ALREADY_FINISHED_NOTICE), 0, 0);
        return { invalidate() { component.invalidate(); notice.invalidate(); }, render(width) { return [...notice.render(width), ...component.render(width)].slice(0, 300); } };
      },
      async execute(_id, input, _signal, _onUpdate, ctx) {
        if (action === "cancel" && (typeof input.jobId !== "string" || input.jobId === "")) {
          throw new Error(`jobId is required (non-empty string); received ${describeReceived(input.jobId)}. Call shell_job_status with no arguments to list job ids, then pass one as jobId.`);
        }
        if (action === "status" && input.jobId !== undefined && (typeof input.jobId !== "string" || input.jobId === "")) {
          throw new Error(`jobId must not be empty and must be a string; received ${describeReceived(input.jobId)}. Call shell_job_status with no arguments (omit jobId) to list job ids.`);
        }
        const result = action === "status" && input.jobId === undefined
          ? { jobs: jobs.list(ctx) }
          : jobs[action](ctx, input.jobId as string);
        // Model text is compacted; structuredContent keeps the full schema-compatible result.
        const text = "jobs" in result
          ? JSON.stringify(result.jobs.map(j => ({ jobId: j.jobId, status: j.status, command: j.command.slice(0, 80), elapsedMs: j.elapsedMs, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.error ? { error: j.error } : {}) })))
          : JSON.stringify(compactJob(result, { output: action === "status", outputLimit: isActiveJobStatus(result.status) ? RUNNING_TAIL_CHARS : undefined })) + (action === "cancel" ? result.status === "cancelling" ? "\nCancellation requested; waiting for cleanup. Exit of all descendant processes is not confirmed." : `\n${ALREADY_FINISHED_NOTICE}` : "");
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
