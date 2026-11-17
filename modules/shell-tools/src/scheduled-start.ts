/**
 * Scheduled Shell start: Schedule Commands asks this session's Shell Tools (shared rendezvous) to add one ordinary
 * background shell job at a scheduled time. The job is a normal ShellJob: it appears in the Shell jobs list, can be
 * inspected or cancelled with the shell_job tools, and its completion is reported to the agent by Shell itself.
 * Nothing about the schedule is kept here.
 */
import { ulid } from "ulid";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalMonitorCwd, publishScheduledShell, type ScheduledShellParams } from "../../../shared/src/background/index.ts";
import type { ShellJobs } from "./background-jobs.ts";
import { timeoutMsToSeconds } from "./timeout-ms.mjs";

type Wrap = (ops: BashOperations) => BashOperations;
/** The same configured tool definitions the `bash`/`powershell` tools execute with. */
export interface ConfiguredBases {
  bash: (ctx: ExtensionContext, wrap?: Wrap) => { execute: (...args: any[]) => Promise<any> };
  powershell: (ctx: ExtensionContext, wrap?: Wrap) => { execute: (...args: any[]) => Promise<any> };
}

export function createScheduledShellPublisher(pi: Pick<ExtensionAPI, "getActiveTools">, jobs: ShellJobs, bases: ConfiguredBases) {
  let revoke: (() => void) | undefined;
  const stop = () => { revoke?.(); revoke = undefined; };
  return {
    stop,
    start(ctx: ExtensionContext) {
      stop();
      try {
        const scope = { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) }, epoch = jobs.monitorEpoch;
        const valid = () => {
          try { return jobs.monitorEpoch === epoch && ctx.sessionManager.getSessionId() === scope.sessionId && canonicalMonitorCwd(ctx.cwd) === scope.cwd; } catch { return false; }
        };
        revoke = publishScheduledShell(scope, {
          start(params: ScheduledShellParams) {
            if (!valid()) return { error: "Shell Tools is shutting down or belongs to another session; nothing was started" };
            let active: readonly string[] = [];
            try { active = pi.getActiveTools(); } catch { /* treated as not enabled */ }
            if (!active.includes(params.tool)) return { error: `the ${params.tool} tool is not enabled; nothing was started` };
            try {
              const toolCallId = `schedule-${ulid().toUpperCase()}`;
              const timeout = timeoutMsToSeconds(params.timeoutMs);
              let jobWrap: Wrap | undefined;
              const base = bases[params.tool](ctx, ops => ({ exec: (command, cwd, options) => (jobWrap ? jobWrap(ops) : ops).exec(command, cwd, options) }));
              const run = async (signal: AbortSignal | undefined, wrap?: Wrap) => {
                jobWrap = wrap;
                if (signal?.aborted) throw new Error("Command aborted");
                return await base.execute(toolCallId, { command: params.command, timeout }, signal, undefined, ctx);
              };
              const receipt = jobs.submit(ctx, params.tool, toolCallId, undefined, run as never, params.command);
              return { jobId: receipt.jobId };
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error) };
            }
          },
        });
      } catch { /* No canonical scope: scheduled shell jobs are unavailable, everything else is unchanged. */ }
    },
  };
}
