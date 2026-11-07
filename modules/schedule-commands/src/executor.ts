/** Dispatches a due job to the runner of its kind. Everything environmental is injected, so tests never start a process or a model. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execMonitorCommand } from "../../shell-tools/src/monitor-exec.ts";
import { runAgentJob, type ChildFactory } from "./agent-run.ts";
import { createChildFactory } from "./child-session.ts";
import { realClock, type Clock } from "./clock.ts";
import { CommandApprovals } from "./cwd.ts";
import type { Executor } from "./engine.ts";
import { postMarker } from "./markers.ts";
import { runPromptJob } from "./prompt-run.ts";
import { DEFAULT_TAIL_BYTES, runShellJob, type ExecFn } from "./shell-run.ts";

export interface ExecutorOptions {
	pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage" | "getActiveTools" | "getSettings">;
	context: () => ExtensionContext;
	trusted: () => boolean;
	clock?: Clock;
	tailBytes?: number;
	/** Test seams; production uses Monitor's Shell helper and the Pi SDK. */
	exec?: ExecFn;
	createChild?: ChildFactory;
}

export function createExecutor(o: ExecutorOptions) {
	const clock = o.clock ?? realClock;
	const approvals = new CommandApprovals();
	const active = new Set<AbortController>();
	const exec: ExecFn = o.exec ?? ((tool, command, signal, events, options) => execMonitorCommand(o.pi, o.context(), tool, command, signal, events, {}, options));
	const createChild = o.createChild ?? createChildFactory(o.context, o.trusted);

	const execute: Executor = (job, info) => {
		switch (job.kind) {
			case "prompt": return runPromptJob(o.pi, job, info);
			case "agent": return runAgentJob({ pi: o.pi, clock, createChild, active }, job, info);
			case "shell": return runShellJob({ pi: o.pi, clock, exec, projectCwd: () => o.context().cwd, activeTools: () => o.pi.getActiveTools(), approvals, tailBytes: o.tailBytes ?? DEFAULT_TAIL_BYTES, active }, job, info);
			case "monitor": {
				// Starting a Monitor from a schedule arrives with the Monitor linkage phase; until then the run is an honest error.
				const error = "monitor jobs cannot run yet: the Monitor linkage is not available in this version";
				postMarker(o.pi, { jobId: job.id, jobName: job.name, kind: "monitor", phase: "error", scheduledFor: info.scheduledFor, error });
				return { started: Promise.resolve(false), done: Promise.resolve({ status: "error", error }) };
			}
		}
	};

	return {
		execute,
		approvals,
		/** Requests cancellation of every run in flight; it does not prove that any process tree has stopped. */
		abortAll(): void { for (const controller of [...active]) controller.abort(); },
	};
}
