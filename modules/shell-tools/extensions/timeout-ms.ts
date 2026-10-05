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
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

import { ShellJobs, compactJob, idleTimeoutMessage } from "../src/background-jobs.js";

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

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  background: Type.Optional(Type.Boolean({ description: "Run as a background job: returns a receipt at once and wakes this session on completion. Cancelled on quit, reload or session replacement." })),
  timeoutMs: Type.Optional(
    Type.Integer({
      description:
        "Idle (stall) timeout in ms: the command is killed after this long with no stdout/stderr output; any output resets it. Omit for no timeout. Not a total time limit: continuous output never times out, while quiet long commands (sleep, silent builds) are killed.",
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
    }),
  ),
}, { additionalProperties: false });

function withIdleTimeout(operations: BashOperations): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (timeout === undefined) {
        return operations.exec(command, cwd, { onData, signal, env });
      }

      const timeoutMs = timeout * 1000;
      const timeoutController = new AbortController();
      const executionSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const refreshTimeout = () => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, timeoutMs);
      };

      refreshTimeout();
      try {
        return await operations.exec(command, cwd, {
          onData(data) {
            refreshTimeout();
            onData(data);
          },
          signal: executionSignal,
          // The local backend's timeout is absolute. Idle timing is managed here.
          env,
        });
      } catch (error) {
        if (timedOut && !signal?.aborted) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    },
  };
}

const STALLED = /Command timed out after (\S+) seconds/;
const stalledMessage = (message: string) => message.replace(STALLED, (_m, seconds: string) => idleTimeoutMessage(seconds));

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
    operations: wrap(withIdleTimeout(createLocalBashOperations({ shellPath }))),
  });
}

function registerTimeoutMsOverride(
  pi: ExtensionAPI,
  name: "bash" | "powershell",
  createBase: typeof createBashToolDefinition | typeof createPowerShellToolDefinition,
  createConfiguredBase: (ctx: ExtensionContext, wrap?: (ops: BashOperations) => BashOperations) => ReturnType<typeof createBashToolDefinition>,
  jobs: ShellJobs,
) {
  // Keep the built-in renderer and tool metadata. Execution recreates the
  // built-in definition with the current session's cwd and shell settings.
  const base = createBase(process.cwd());

  const timeoutGuideline = `For ${name}, timeoutMs is an idle timeout in milliseconds, not seconds and not a total limit; it resets whenever the command writes to stdout or stderr (20000 = stop after 20 seconds without output). Omit it for no timeout; quiet long commands should omit it or use background:true.`;
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
    description: `${descriptionWithoutOldTimeout} timeoutMs is an idle timeout in ms. background:true returns a jobId/liveLogPath receipt (no exit code) and reports completion automatically; shell_job_status/cancel need explicit selection. ${platformNote}`,
    parameters,
    outputSchema: Type.Union([base.outputSchema!, receiptSchema]),
    promptGuidelines: [...(base.promptGuidelines ?? []), timeoutGuideline],
    renderCall: base.renderCall && ((args, theme, context) => {
      const timeoutMs = args?.timeoutMs;
      // Streaming can provide incomplete/missing args. Old sessions only carry
      // the legacy seconds-based timeout; leave those arguments unchanged.
      const renderArgs = timeoutMs === undefined
        ? args
        : { ...args, timeout: timeoutMsToRenderSeconds(timeoutMs) };
      return base.renderCall!(renderArgs, theme, context);
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
        // Schema validation can be skipped when AJV is unavailable, so reject the
        // legacy seconds field explicitly instead of silently running unbounded.
        if ((input as { timeout?: unknown }).timeout !== undefined) {
          throw new Error(
            `${name} no longer accepts timeout (seconds); use timeoutMs in milliseconds, e.g. 20000 for 20 seconds.`,
          );
        }
        if (input.background !== undefined && typeof input.background !== "boolean") throw new Error("background must be a boolean");
        if (typeof input.command !== "string") throw new Error("command must be a string");
        const timeout = timeoutMsToSeconds(input.timeoutMs);
        const command = input.command;
        const background = input.background === true;
        // Snapshot effective shell settings before accepting, rather than reading
        // a later turn's overrides when the deferred runner starts.
        let jobWrap: ((ops: BashOperations) => BashOperations) | undefined;
        const configuredBase = createConfiguredBase(ctx, operations => ({
          exec: (command, cwd, options) => (jobWrap ? jobWrap(operations) : operations).exec(command, cwd, options),
        }));
        const run = async (executionSignal: AbortSignal | undefined, wrap?: (ops: BashOperations) => BashOperations) => {
          jobWrap = wrap;
          try {
            if (executionSignal?.aborted && background) throw new Error("Command aborted");
            const result = await configuredBase.execute(toolCallId, { command, timeout }, executionSignal, background ? undefined : onUpdate, ctx);
            if (result.isError === true) await logFailure({ kind: "error-result", result });
            return result;
          } catch (error) {
            if (background) await logFailure({ kind: "exception", error });
            if (error instanceof Error && input.timeoutMs !== undefined) {
              const stalled = stalledMessage(error.message);
              if (stalled !== error.message) throw new Error(stalled, { cause: error });
            }
            throw error;
          }
        };
        if (background) {
          const receipt = jobs.submit(ctx, name, toolCallId, signal, run, command);
          // The receipt names only what this loadout can actually do.
          let canQuery = false;
          try { canQuery = pi.getActiveTools?.().includes("shell_job_status") ?? false; } catch { /* host may not expose it */ }
          const next = canQuery
            ? "Progress: shell_job_status or read log tail. Completion is auto-reported."
            : "Progress: read log tail. Completion is auto-reported (shell_job_status/cancel not selected).";
          return { content: [{ type: "text", text: `job ${receipt.jobId} running\nlog ${receipt.liveLogPath}\n${next}` }], details: undefined, structuredContent: receipt };
        }
        return await run(signal);
      } catch (error) {
        await logFailure({ kind: "exception", error });
        // The host formats `timeout:<s>` as an absolute-timeout message, but
        // here it means an output stall. Make the message accurate.
        if (input.timeoutMs !== undefined && error instanceof Error) {
          const stalled = stalledMessage(error.message);
          if (stalled !== error.message) throw new Error(stalled, { cause: error });
        }
        throw error;
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  const jobs = new ShellJobs(pi);
  pi.on("session_start", (_event, ctx) => { jobs.start(ctx); });
  pi.on("session_shutdown", () => jobs.shutdown());
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
      renderResult(result, { expanded, isPartial }, theme) {
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const caveat = action === "cancel" ? "Cancellation is a request; process-tree termination not confirmed.\n" : "";
        return new Text(theme.fg("muted", `${isPartial ? "Pending…\n" : ""}${caveat}${display(text, expanded ? 8192 : 512)}`), 0, 0);
      },
      async execute(_id, input, _signal, _onUpdate, ctx) {
        const result = action === "status" && input.jobId === undefined
          ? { jobs: jobs.list(ctx) }
          : jobs[action](ctx, input.jobId as string);
        // Model text is compacted; structuredContent keeps the full schema-compatible result.
        const text = "jobs" in result
          ? JSON.stringify(result.jobs.map(j => ({ jobId: j.jobId, status: j.status, command: j.command.slice(0, 80), elapsedMs: j.elapsedMs, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.error ? { error: j.error } : {}) })))
          : JSON.stringify(compactJob(result, { output: action === "status", outputLimit: result.status === "running" || result.status === "cancelling" ? RUNNING_TAIL_CHARS : undefined })) + (action === "cancel" && result.status === "cancelling" ? "\nCancel requested; completion is auto-reported." : "");
        return { content: [{ type: "text", text }], details: undefined, structuredContent: result };
      },
    });
  }
  registerTimeoutMsOverride(
    pi,
    "bash",
    createBashToolDefinition,
    (ctx, wrap) => createConfiguredBashDefinition(pi, ctx, wrap),
    jobs,
  );
  registerTimeoutMsOverride(
    pi,
    "powershell",
    createPowerShellToolDefinition,
    // Pi's PowerShell tool options accept no shellPath/commandPrefix, so
    // Bash-only shell settings intentionally do not apply here.
    (ctx, wrap = ops => ops) => createPowerShellToolDefinition(ctx.cwd, {
      operations: wrap(withIdleTimeout(createLocalPowerShellOperations())),
    }),
    jobs,
  );
}
