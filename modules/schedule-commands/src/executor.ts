/** Dispatches a due job to the runner of its kind. Everything environmental is injected, so tests never start a process or a model. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgentJob, type ChildFactory } from "./agent-run.ts";
import { createChildFactory } from "./child-session.ts";
import { realClock, type Clock } from "./clock.ts";
import { LiveRuns } from "./live-runs.ts";
import type { Executor } from "./engine.ts";
import { runMonitorJob } from "./monitor-link.ts";
import { runPromptJob } from "./prompt-run.ts";
import { runShellJob } from "./shell-run.ts";

export interface ExecutorOptions {
	pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage" | "getActiveTools" | "getSettings">;
	context: () => ExtensionContext;
	trusted: () => boolean;
	clock?: Clock;
	/** Test seams; production uses the shared rendezvous and the Pi SDK. */
	shellStarter?: Parameters<typeof runShellJob>[0]["starter"];
	createChild?: ChildFactory;
	monitorStarter?: Parameters<typeof runMonitorJob>[0]["starter"];
	/** Called when a running job gains or loses its live copy, so the panel can refresh. */
	onLiveChange?: () => void;
}

export function createExecutor(o: ExecutorOptions) {
	const clock = o.clock ?? realClock;
	const active = new Set<AbortController>();
	const live = new LiveRuns(o.onLiveChange);
	const lastMonitor = new Map<string, string>();
	const createChild = o.createChild ?? createChildFactory(o.context, o.trusted);

	const execute: Executor = (job, info) => {
		switch (job.kind) {
			case "prompt": return runPromptJob(o.pi, job, info);
			case "agent": return runAgentJob({ pi: o.pi, clock, createChild, active, live }, job, info);
			case "shell": return runShellJob({ pi: o.pi, context: o.context, activeTools: () => o.pi.getActiveTools(), ...(o.shellStarter ? { starter: o.shellStarter } : {}) }, job, info);
			case "monitor": return runMonitorJob({ pi: o.pi, context: o.context, activeTools: () => o.pi.getActiveTools(), last: lastMonitor, ...(o.monitorStarter ? { starter: o.monitorStarter } : {}) }, job, info);
		}
	};

	return {
		execute,
		live,
		/** Requests cancellation of every run in flight; it does not prove that any process tree has stopped. */
		abortAll(): void { for (const controller of [...active]) controller.abort(); },
	};
}
