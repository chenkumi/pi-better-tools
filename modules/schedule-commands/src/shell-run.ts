/**
 * Shell job runner. The process is started through an injected `exec` (in production Monitor's Shell helper, which
 * owns shell resolution, environment and best-effort process-tree cancellation). It starts no model and wakes no
 * agent; output only reaches the display marker. `timeoutMs` is an output-stall limit, not a total time limit.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OutputTranscript } from "../../../shared/src/background/index.ts";
import type { Clock } from "./clock.ts";
import { CommandApprovals, resolveCwd } from "./cwd.ts";
import type { RunHandle, RunInfo, RunOutcome } from "./engine.ts";
import { defaultShell, shellProblem } from "./guard.ts";
import type { LiveRuns } from "./live-runs.ts";
import { postMarker, type MarkerDetails } from "./markers.ts";
import { TailBuffer } from "./tail.ts";
import type { Job } from "./types.ts";

export interface ProcessEvents {
	stdout(data: Buffer): void;
	stderr(data: Buffer): void;
	started(): void;
	closed(code: number | null, signal: NodeJS.Signals | null, spawnError: boolean): void;
}
export type ExecFn = (tool: "bash" | "powershell", command: string, signal: AbortSignal, events: ProcessEvents, options: { cwd: string; abortGraceMs: number; exitIdleMs: number }) => Promise<void>;

export const DEFAULT_STALL_MS = 300_000;
export const DEFAULT_TAIL_BYTES = 8 * 1024;
const ABORT_GRACE_MS = 500;
const CLOSE_WAIT_MS = 5_000;
const EXIT_IDLE_MS = 250;
const SHOWN_CHARS = 500;

export interface ShellDeps {
	pi: Pick<ExtensionAPI, "sendMessage">;
	clock: Clock;
	exec: ExecFn;
	projectCwd: () => string;
	activeTools: () => readonly string[];
	approvals: CommandApprovals;
	tailBytes: number;
	/** Controllers of runs in flight, so a shutdown can request cancellation of all of them. */
	active: Set<AbortController>;
	/** Where a running job's output copy is shown (Jobs overlay); released when the run ends. */
	live?: LiveRuns;
}

export function runShellJob(d: ShellDeps, job: Extract<Job, { kind: "shell" }>, info: RunInfo): RunHandle {
	const shell = job.shell ?? defaultShell();
	let resolveStarted!: (value: boolean) => void;
	const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });
	const base: MarkerDetails = { jobId: job.id, jobName: job.name, kind: "shell", phase: "start", scheduledFor: info.scheduledFor, ...(info.missed !== undefined ? { catchUp: info.missed } : {}), command: job.command, shell };
	const refuse = (error: string, cwd?: string): RunOutcome => {
		postMarker(d.pi, { ...base, phase: "error", error, ...(cwd ? { cwd } : {}) });
		return { status: "error", error };
	};

	const done = (async (): Promise<RunOutcome> => {
		const problem = shellProblem(d.activeTools(), shell);
		if (problem) return refuse(problem);
		// Resolved at every run: a swapped link or a deleted directory is caught, and there is never a fallback directory.
		const resolved = resolveCwd(d.projectCwd(), job.cwd);
		if (!resolved.ok) return refuse(resolved.error);
		if (resolved.outsideProject && !d.approvals.isApproved(job.command, shell, resolved.cwd)) {
			return refuse("cwd: the directory is outside the project and was not approved in this session; re-enable or re-add the job to approve it", resolved.cwd);
		}
		const cwd = resolved.cwd;
		postMarker(d.pi, { ...base, cwd });

		const stallMs = job.timeoutMs ?? DEFAULT_STALL_MS;
		const controller = new AbortController();
		d.active.add(controller);
		const tail = new TailBuffer(d.tailBytes);
		let stalled = false, thrown: string | undefined;
		let closed: { code: number | null; signal: NodeJS.Signals | null; spawnError: boolean } | undefined;
		let stallTimer: unknown, closeTimer: unknown;
		const armStall = () => {
			if (stallTimer !== undefined) d.clock.clearTimeout(stallTimer);
			stallTimer = d.clock.setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
		};
		const copy = new OutputTranscript();
		d.live?.set(job.id, copy);
		const onData = (data: Buffer) => { armStall(); tail.push(data); copy.append(data); };
		armStall();
		// After an abort, stop waiting for the pipes when a surviving descendant keeps them open.
		const abortedWait = new Promise<void>((resolve) => {
			controller.signal.addEventListener("abort", () => { closeTimer = d.clock.setTimeout(resolve, CLOSE_WAIT_MS); }, { once: true });
		});
		try {
			await Promise.race([
				d.exec(shell, job.command, controller.signal, {
					stdout: onData, stderr: onData, started: () => resolveStarted(true),
					closed: (code, signal, spawnError) => { closed = { code, signal, spawnError }; },
				}, { cwd, abortGraceMs: ABORT_GRACE_MS, exitIdleMs: EXIT_IDLE_MS }),
				abortedWait,
			]);
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		} finally {
			if (stallTimer !== undefined) d.clock.clearTimeout(stallTimer);
			if (closeTimer !== undefined) d.clock.clearTimeout(closeTimer);
			d.active.delete(controller);
			if (d.live) d.live.release(job.id, copy); else copy.release();
		}
		// Aborted by a shutdown: the host may already be gone, so touch neither chat nor storage.
		if (controller.signal.aborted && !stalled) return { status: "error", error: "cancelled because the session ended; cancellation was only requested, descendant processes may still be running" };

		const output = tail.text();
		const shown = output.length > SHOWN_CHARS ? `…${output.slice(-SHOWN_CHARS)}` : output;
		const withOutput = (message: string) => (shown ? `${message}\n${shown}` : message);
		let error: string | undefined;
		if (thrown !== undefined) error = withOutput(`command could not run: ${thrown}`);
		else if (stalled) error = withOutput(`command produced no output for ${stallMs} ms and was stopped; cancellation was only requested, and descendant processes may still be running`);
		else if (!closed) error = withOutput("command ended without reporting an exit status");
		else if (closed.spawnError) error = withOutput("command could not be started");
		else if (closed.signal) error = withOutput(`command was terminated by signal ${closed.signal}`);
		else if (closed.code !== 0) error = withOutput(`command exited with code ${closed.code}`);
		if (error === undefined) {
			postMarker(d.pi, { ...base, cwd, phase: "done", exitCode: 0, output: shown });
			return { status: "success" };
		}
		postMarker(d.pi, { ...base, cwd, phase: "error", error, output: shown, ...(closed?.code != null ? { exitCode: closed.code } : {}) });
		return { status: "error", error };
	})();
	void done.finally(() => resolveStarted(false));
	return { started, done };
}
