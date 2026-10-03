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
import { writeFailureDebugLog, type FailureDetails } from "../src/debug-log.mjs";
import {
  MAX_TIMEOUT_MS,
  timeoutMsToRenderSeconds,
  timeoutMsToSeconds,
} from "../src/timeout-ms.mjs";

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
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

function createConfiguredBashDefinition(pi: ExtensionAPI, ctx: ExtensionContext) {
  // Read the host's effective settings at execution time, including trust-aware
  // project settings and SDK in-memory overrides. Do not independently reread disk.
  const settings = pi.getSettings();
  // Reuse Pi's public normalization for ~, file URLs, and Windows shell paths.
  // This temporary manager is strictly in-memory and performs no file I/O.
  const shellPath = SettingsManager.inMemory({ shellPath: settings.shellPath }).getShellPath();
  return createBashToolDefinition(ctx.cwd, {
    shellPath,
    commandPrefix: settings.shellCommandPrefix,
    operations: withIdleTimeout(createLocalBashOperations({ shellPath })),
  });
}

function registerTimeoutMsOverride(
  pi: ExtensionAPI,
  name: "bash" | "powershell",
  createBase: typeof createBashToolDefinition | typeof createPowerShellToolDefinition,
  createConfiguredBase: (ctx: ExtensionContext) => ReturnType<typeof createBashToolDefinition>,
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
    description: `${descriptionWithoutOldTimeout} Optionally provide timeoutMs in milliseconds (for example, 20000 = 20 seconds).`,
    parameters,
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
        const configuredBase = createConfiguredBase(ctx);
        const result = await configuredBase.execute(
          toolCallId,
          {
            command: input.command,
            timeout: timeoutMsToSeconds(input.timeoutMs),
          },
          signal,
          onUpdate,
          ctx,
        );
        if (result.isError === true) await logFailure({ kind: "error-result", result });
        return result;
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
  registerTimeoutMsOverride(
    pi,
    "bash",
    createBashToolDefinition,
    (ctx) => createConfiguredBashDefinition(pi, ctx),
  );
  registerTimeoutMsOverride(
    pi,
    "powershell",
    createPowerShellToolDefinition,
    // Pi's PowerShell tool options accept no shellPath/commandPrefix, so
    // Bash-only shell settings intentionally do not apply here.
    (ctx) => createPowerShellToolDefinition(ctx.cwd, {
      operations: withIdleTimeout(createLocalPowerShellOperations()),
    }),
  );
}
