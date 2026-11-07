/**
 * Monitor jobs: at the scheduled time the schedule module asks the Monitor of this session (through the shared
 * rendezvous) to start one watch with `monitor_start` parameters. Monitor stays the only place that validates and
 * decides; this module adds the gates that belong to schedules (shell tools for command sources, one watch per job).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalMonitorCwd, requestScheduledMonitor, type ScheduledMonitorStarter } from "../../../shared/src/background/index.js";
import type { RunHandle, RunInfo } from "./engine.ts";
import { shellProblem, type ShellName } from "./guard.ts";
import { postMarker, type MarkerDetails } from "./markers.ts";
import type { Job, MonitorStart } from "./types.ts";

export const MONITOR_SOURCES = ["command", "file", "system"] as const;

/** Problem text (naming arguments only) when the start parameters cannot be scheduled right now, or undefined. */
export function monitorProblem(start: MonitorStart, activeTools: readonly string[]): string | undefined {
	const kind = start.source.kind;
	if (!(MONITOR_SOURCES as readonly string[]).includes(kind)) return `start.source.kind: "${String(kind)}" is not available to schedules; use ${MONITOR_SOURCES.join(", ")}`;
	if (kind !== "command") return undefined;
	// A command source is unattended command execution, so it needs the same tools a scheduled shell job needs.
	if (!activeTools.includes("schedule_shell")) return 'start.source: a command source needs the schedule_shell tool to be enabled; ask the user to enable it';
	const tool = start.source.tool;
	if (tool !== "bash" && tool !== "powershell") return 'start.source.tool: must be "bash" or "powershell"';
	return shellProblem(activeTools, tool as ShellName)?.replace("shell:", "start.source.tool:");
}

/** The text the user approves for a monitor job. */
export function monitorLines(start: MonitorStart): string[] {
	const source = start.source;
	const lines = source.kind === "command"
		? [`Source: command (${String(source.tool)})`, `Command: ${String(source.command)}`, "It runs unattended while this Pi session is open; it is not a sandbox."]
		: source.kind === "file" ? [`Source: file metadata of ${String(source.path)} (content is never read)`]
			: [`Source: whole-host ${String(source.metric)} utilisation at or above ${String(source.thresholdPercent)}% for ${String(source.sustainMs)} ms`];
	return [...lines, `Duration: ${String(start.durationMs ?? "default")} ms`, start.wakeAgent === true ? "WAKES THE AGENT when it reports (uses model quota unattended)." : "Does not wake the agent."];
}

export interface MonitorRunDeps {
	pi: Pick<ExtensionAPI, "sendMessage">;
	context: () => ExtensionContext;
	activeTools: () => readonly string[];
	/** Test seam; production asks the shared rendezvous for this session's Monitor. */
	starter?: () => ScheduledMonitorStarter | undefined;
	/** The monitor each job started last, so a job never piles up watches while the previous one still runs. */
	last: Map<string, string>;
}

export const scopeOf = (ctx: ExtensionContext) => ({ sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) });

export function runMonitorJob(d: MonitorRunDeps, job: Extract<Job, { kind: "monitor" }>, info: RunInfo): RunHandle {
	const base: MarkerDetails = { jobId: job.id, jobName: job.name, kind: "monitor", phase: "start", scheduledFor: info.scheduledFor, ...(info.missed !== undefined ? { catchUp: info.missed } : {}) };
	const finish = (outcome: { status: "success" | "error" | "skipped"; error?: string }, started: boolean): RunHandle =>
		({ started: Promise.resolve(started), done: Promise.resolve(outcome) });
	const refuse = (error: string): RunHandle => {
		postMarker(d.pi, { ...base, phase: "error", error });
		return finish({ status: "error", error }, false);
	};
	try {
		const problem = monitorProblem(job.start, d.activeTools());
		if (problem) return refuse(problem);
		const starter = (d.starter ?? (() => requestScheduledMonitor(scopeOf(d.context()))))();
		if (!starter) return refuse("Monitor is not available in this session (not loaded, or a different session); nothing was started");
		const previous = d.last.get(job.id);
		if (previous && starter.isActive(previous)) {
			const reason = `the monitor started by the previous run (${previous}) is still running; this run was skipped`;
			postMarker(d.pi, { ...base, phase: "skipped", error: reason });
			return finish({ status: "skipped", error: reason }, false);
		}
		const result = starter.start(job.start);
		if ("error" in result) return refuse(result.error);
		d.last.set(job.id, result.monitorId);
		postMarker(d.pi, { ...base, phase: "done", output: `monitor ${result.monitorId} started` });
		return finish({ status: "success" }, true);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
}
