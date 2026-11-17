/**
 * Shell job runner. At the scheduled time it asks this session's Shell Tools (shared rendezvous) to add one ordinary
 * background shell job and ends right there: the schedule run is finished once the job is accepted. The job then lives
 * in Shell's own job list, and Shell reports its completion to the agent. Output never passes through this module.
 * The agent is told when the job starts (a model-visible marker that does not wake it) and when it could not start.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalMonitorCwd, requestScheduledShell, type ScheduledShellStarter } from "../../../shared/src/background/index.ts";
import type { RunHandle, RunInfo, RunOutcome } from "./engine.ts";
import { defaultShell, shellProblem } from "./guard.ts";
import { postMarker, type MarkerDetails } from "./markers.ts";
import type { Job } from "./types.ts";

export interface ShellDeps {
	pi: Pick<ExtensionAPI, "sendMessage">;
	context: () => ExtensionContext;
	activeTools: () => readonly string[];
	/** Test seam; production asks the shared rendezvous for this session's Shell Tools. */
	starter?: () => ScheduledShellStarter | undefined;
}

const scopeOf = (ctx: ExtensionContext) => ({ sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) });
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").slice(0, 200);

export function runShellJob(d: ShellDeps, job: Extract<Job, { kind: "shell" }>, info: RunInfo): RunHandle {
	const shell = job.shell ?? defaultShell();
	const base: MarkerDetails = { jobId: job.id, jobName: job.name, kind: "shell", phase: "start", scheduledFor: info.scheduledFor, ...(info.missed !== undefined ? { catchUp: info.missed } : {}), command: job.command, shell };
	const finish = (outcome: RunOutcome, started: boolean): RunHandle => ({ started: Promise.resolve(started), done: Promise.resolve(outcome) });
	// The text is fixed apart from the schedule's own name and ids; it never carries the command or any output.
	const refuse = (error: string): RunHandle => {
		postMarker(d.pi, { ...base, phase: "error", error }, { content: `Scheduled job "${clean(job.name)}" (${job.id}) could not start its shell job: ${clean(error)}` });
		return finish({ status: "error", error }, false);
	};
	try {
		if (job.cwd !== undefined) return refuse("cwd: schedule_shell no longer supports a working directory (shell jobs run in the project directory); remove and add the job again");
		const problem = shellProblem(d.activeTools(), shell);
		if (problem) return refuse(problem);
		const starter = (d.starter ?? (() => requestScheduledShell(scopeOf(d.context()))))();
		if (!starter) return refuse("Shell Tools is not available in this session (not loaded, or a different session); nothing was started");
		const result = starter.start({ tool: shell, command: job.command, ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}) });
		if ("error" in result) return refuse(result.error);
		postMarker(d.pi, { ...base, phase: "done", output: `shell job ${result.jobId} started` }, {
			content: `Scheduled job "${clean(job.name)}" (${job.id}) started shell job ${result.jobId} at ${info.scheduledFor}. Its completion will be reported separately.`,
		});
		return finish({ status: "success" }, true);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
}
