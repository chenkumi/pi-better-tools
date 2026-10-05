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

import { ShellJobs } from "../src/background-jobs.js";
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
  background: Type.Optional(Type.Boolean({ description: "Return a background job receipt immediately; completion wakes this owner session. Jobs are cancelled on quit, reload, or session replacement." })),
  timeoutMs: Type.Optional(
    Type.Integer({
      description:
        "Idle timeout in milliseconds, refreshed whenever stdout or stderr produces output. For example, 20000 means 20 seconds without output. Omit or use 2147483647 for no timeout.",
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

  const timeoutGuideline = `For ${name}, timeoutMs is an idle timeout in milliseconds, not seconds; it resets whenever the command writes to stdout or stderr. Example: use 20000 to stop the command after 20 seconds without output. Omit it or use ${MAX_TIMEOUT_MS} to disable the idle timeout.`;
  const descriptionWithoutOldTimeout = base.description.replace(
    /\s*Optionally provide a timeout in seconds\./,
    "",
  );

  pi.registerTool({
    ...base,
    // Override the schema, not the user's loadout. Pi activates this tool only
    // when selected by defaults, --tools, or setActiveTools().
    defaultActive: false,
    description: `${descriptionWithoutOldTimeout} Optionally provide timeoutMs in milliseconds (for example, 20000 = 20 seconds). With background:true returns jobId/status/liveLogPath, not an exit code. Read that bounded progress log. shell_job_status and shell_job_cancel are inactive unless explicitly selected; with a bash/powershell-only loadout ask the user to select these management tools before relying on status/cancel. Completion automatically follows up in this session. Avoid concurrent edits to the same files.`,
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
              const stalled = error.message.replace(/Command timed out after (\S+) seconds/, "Command stopped: no output for $1 seconds (timeoutMs idle timeout)");
              if (stalled !== error.message) throw new Error(stalled, { cause: error });
            }
            throw error;
          }
        };
        if (background) {
          const receipt = jobs.submit(ctx, name, toolCallId, signal, run);
          return { content: [{ type: "text", text: `${JSON.stringify(receipt)}\nManagement requires explicitly selected shell_job_status / shell_job_cancel tools. If unavailable, read liveLogPath for bounded output and ask the user to select management tools; shell-only loadouts cannot request job cancellation.` }], details: undefined, structuredContent: receipt };
        }
        return await run(signal);
      } catch (error) {
        await logFailure({ kind: "exception", error });
        // The host formats `timeout:<s>` as an absolute-timeout message, but
        // here it means an output stall. Make the message accurate.
        if (input.timeoutMs !== undefined && error instanceof Error) {
          const stalled = error.message.replace(
            /Command timed out after (\S+) seconds/,
            "Command stopped: no output for $1 seconds (timeoutMs idle timeout)",
          );
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
  for (const action of ["status", "cancel"] as const) {
    pi.registerTool({
      name: `shell_job_${action}`, label: `Shell job ${action}`, defaultActive: false,
      description: action === "status" ? "Read a shell background job status and bounded result owned by this session." : "Request cancellation of a shell background job owned by this session. cancelling does not confirm the process tree has exited.",
      parameters: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({
        jobId: Type.String(), status: Type.String(), tool: Type.String(), toolCallId: Type.String(), liveLogPath: Type.String(), logPath: Type.String(),
        outputTruncated: Type.Boolean(), exitCode: Type.Optional(Type.Number()), output: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      renderCall(args, theme) {
        return new Text(theme.fg("toolTitle", `Shell job ${action} ${display(typeof args?.jobId === "string" ? args.jobId : "…", 64)}`), 0, 0);
      },
      renderResult(result, { expanded, isPartial }, theme) {
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const caveat = action === "cancel" ? "Cancellation is a request; process-tree termination not confirmed.\n" : "";
        return new Text(theme.fg("muted", `${isPartial ? "Pending…\n" : ""}${caveat}${display(text, expanded ? 8192 : 512)}`), 0, 0);
      },
      async execute(_id, input, _signal, _onUpdate, ctx) {
        const result = jobs[action](ctx, input.jobId);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined, structuredContent: result };
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
