/** Dispatches a due job to the runner of its kind. Everything environmental is injected, so tests never start a process or a model. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execMonitorCommand } from "../../shell-tools/src/monitor-exec.ts";
import { runAgentJob, type ChildFactory } from "./agent-run.ts";
import { createChildFactory } from "./child-session.ts";
import { realClock, type Clock } from "./clock.ts";
import { CommandApprovals } from "./cwd.ts";
import { LiveRuns } from "./live-runs.ts";
import type { Executor } from "./engine.ts";
import { runMonitorJob } from "./monitor-link.ts";
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
	monitorStarter?: Parameters<typeof runMonitorJob>[0]["starter"];
	/** Called when a running job gains or loses its live copy, so the panel can refresh. */
	onLiveChange?: () => void;
}

export function createExecutor(o: ExecutorOptions) {
	const clock = o.clock ?? realClock;
	const approvals = new CommandApprovals();
	const active = new Set<AbortController>();
	const live = new LiveRuns(o.onLiveChange);
	const exec: ExecFn = o.exec ?? ((tool, command, signal, events, options) => execMonitorCommand(o.pi, o.context(), tool, command, signal, events, {}, options));
	const lastMonitor = new Map<string, string>();
	const createChild = o.createChild ?? createChildFactory(o.context, o.trusted);

	const execute: Executor = (job, info) => {
		switch (job.kind) {
			case "prompt": return runPromptJob(o.pi, job, info);
			case "agent": return runAgentJob({ pi: o.pi, clock, createChild, active, live }, job, info);
			case "shell": return runShellJob({ pi: o.pi, clock, exec, projectCwd: () => o.context().cwd, activeTools: () => o.pi.getActiveTools(), approvals, tailBytes: o.tailBytes ?? DEFAULT_TAIL_BYTES, active, live }, job, info);
			case "monitor": return runMonitorJob({ pi: o.pi, context: o.context, activeTools: () => o.pi.getActiveTools(), last: lastMonitor, ...(o.monitorStarter ? { starter: o.monitorStarter } : {}) }, job, info);
		}
	};

	return {
		execute,
		approvals,
		live,
		/** Requests cancellation of every run in flight; it does not prove that any process tree has stopped. */
		abortAll(): void { for (const controller of [...active]) controller.abort(); },
	};
}
