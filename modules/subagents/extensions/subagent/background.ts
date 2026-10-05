import { ulid } from "ulid";
import { firstLineSummary } from "./result.ts";
import type { RpcInteraction, ControlReceipt, QueryReceipt, InteractionNotice } from "./rpc.ts";

export interface BackgroundTask {
	taskId: string;
	agent: string;
	status: "queued" | "running" | "completed" | "failed" | "aborted" | "skipped";
	logPending: boolean;
	subagentSessionId?: string;
	liveLogPath?: string;
	/** Where liveLogPath is renamed to on completion; the live path stops existing then. */
	finalLogPath?: string;
	result?: unknown;
	canMessage?: boolean;
	controls?: ControlReceipt[];
	queries?: QueryReceipt[];
}
export interface BackgroundReceipt {
	jobId: string;
	status: "queued" | "running" | "completed" | "failed" | "aborted";
	tasks: BackgroundTask[];
	cancelRequested: boolean;
}
interface Job extends BackgroundReceipt {
	owner: string;
	cwd: string;
	generation: number;
	controller: AbortController;
	done: Promise<void>;
	interactive: Map<number, RpcInteraction>;
}
// Shared admission budget across extension instances/reloads; active child permits
// remain owned by the existing runner. Cancellation retains admission until cleanup.
let submittedTasks = 0;
const MAX_SUBMITTED = 32;
const MAX_RETAINED_JOBS = 64;
const MAX_ACTIVE = 8;

export interface BackgroundJobSummary {
	jobId: string;
	status: BackgroundReceipt["status"];
	cancelRequested: boolean;
	tasks: Array<{ taskId: string; agent: string; status: BackgroundTask["status"]; canMessage?: boolean; summary?: string }>;
}

/** Model-visible text view: omit defaults (false flags, zero exit, empty lists) and duplicates; full data stays in structuredContent/details. */
export function slimTask(task: BackgroundTask): Record<string, unknown> {
	const out: Record<string, unknown> = { taskId: task.taskId, agent: task.agent, status: task.status };
	if (task.liveLogPath) out.liveLogPath = task.liveLogPath;
	if (task.finalLogPath) out.finalLogPath = task.finalLogPath;
	if (task.subagentSessionId) out.subagentSessionId = task.subagentSessionId;
	if (task.canMessage === true) out.canMessage = true;
	if (task.controls?.length) out.controls = task.controls.map(control => ({ messageId: control.messageId, status: control.status }));
	if (task.queries?.length) out.queries = task.queries.map(query => ({ queryId: query.queryId, status: query.status }));
	if (isPlainRecord(task.result)) {
		const result = task.result, slim: Record<string, unknown> = {};
		for (const key of ["output", "errorCode", "errorMessage", "error", "logError", "logPath"]) if (typeof result[key] === "string" && result[key]) slim[key] = result[key];
		if (typeof result.exitCode === "number" && result.exitCode !== 0) slim.exitCode = result.exitCode;
		if (typeof result.stopReason === "string" && result.stopReason && result.stopReason !== "stop") slim.stopReason = result.stopReason;
		if (result.outputTruncated === true) slim.outputTruncated = true;
		if (result.canResume === true) slim.canResume = true;
		if (typeof result.subagentSessionId === "string" && result.subagentSessionId !== task.subagentSessionId) slim.subagentSessionId = result.subagentSessionId;
		// Background usage is not added to host totals, so keep the two numbers needed for accounting.
		if (isPlainRecord(result.usage) && typeof result.usage.totalTokens === "number") slim.usage = { totalTokens: result.usage.totalTokens, ...(typeof result.usage.cost === "number" && result.usage.cost > 0 ? { cost: result.usage.cost } : {}) };
		out.result = slim;
	}
	return out;
}

export function slimReceipt(receipt: BackgroundReceipt, kind?: string): Record<string, unknown> {
	return { ...(kind ? { kind } : {}), jobId: receipt.jobId, status: receipt.status, ...(receipt.cancelRequested ? { cancelRequested: true } : {}), tasks: receipt.tasks.map(slimTask) };
}

export function slimJobList(jobs: BackgroundJobSummary[]): Record<string, unknown> {
	return { jobs: jobs.map(job => ({ jobId: job.jobId, status: job.status, ...(job.cancelRequested ? { cancelRequested: true } : {}),
		tasks: job.tasks.map(task => ({ taskId: task.taskId, agent: task.agent, status: task.status, ...(task.canMessage === true ? { canMessage: true } : {}), ...(task.summary ? { summary: task.summary } : {}) })) })) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class BackgroundJobs {
	private jobs = new Map<string, Job>();
	private generation = 0;
	private closed = false;
	constructor(
		private readonly notify: (kind: "task_result" | "log_ready" | "control_result" | "query_result", receipt: BackgroundReceipt, interaction?: InteractionNotice & { taskId: string }) => void,
		/** Optional process-wide active-child count, used only for diagnostics. */
		private readonly activeCount?: () => number,
	) {}
	/** Current admission load, for actionable capacity diagnostics. */
	load(): string {
		const active = this.activeCount?.();
		return `submitted ${submittedTasks}/${MAX_SUBMITTED}${active === undefined ? "" : `, active ${active}/${MAX_ACTIVE}`}`;
	}
	/** Read-only listing of this owner's retained jobs, newest first. */
	list(owner: string, cwd: string): BackgroundJobSummary[] {
		if (this.closed) return [];
		return [...this.jobs.values()].reverse().filter(job => job.owner === owner && job.cwd === cwd && job.generation === this.generation).map(job => {
			const view = this.view(job);
			return { jobId: view.jobId, status: view.status, cancelRequested: view.cancelRequested, tasks: view.tasks.map(task => {
				const output = isPlainRecord(task.result) ? task.result.output ?? task.result.errorMessage ?? task.result.error : undefined;
				const summary = typeof output === "string" ? firstLineSummary(output, 200) : "";
				return { taskId: task.taskId, agent: task.agent, status: task.status, ...(task.canMessage === undefined ? {} : { canMessage: task.canMessage }), ...(summary ? { summary } : {}) };
			}) };
		});
	}
	get epoch() { return this.generation; }
	start() { this.closed = false; }
	private view(job: Job): BackgroundReceipt {
		return structuredClone({ jobId: job.jobId, status: job.status, tasks: job.tasks.map((task, index) => {
			const handle = job.interactive.get(index);
			return { ...task, ...(handle ? { canMessage: handle.isRunning && !job.cancelRequested, ...handle.snapshot() } : {}) };
		}), cancelRequested: job.cancelRequested });
	}
	get(id: string, owner: string, cwd: string) {
		const job = this.jobs.get(id);
		if (!job || job.owner !== owner || job.cwd !== cwd || job.generation !== this.generation || this.closed) throw new Error("BACKGROUND_JOB_NOT_FOUND: job belongs to a different owner/runtime or is no longer retained");
		return this.view(job);
	}
	cancel(id: string, owner: string, cwd: string) {
		this.get(id, owner, cwd);
		const job = this.jobs.get(id)!;
		if (job.status === "queued" || job.status === "running") { job.cancelRequested = true; job.controller.abort(); }
		return this.view(job);
	}
	message(id: string, taskId: string, mode: "control" | "query", text: string, owner: string, cwd: string) {
		this.get(id, owner, cwd);
		const job = this.jobs.get(id)!;
		const index = job.tasks.findIndex(task => task.taskId === taskId);
		const handle = job.interactive.get(index);
		if (index < 0 || job.cancelRequested || job.tasks[index].status !== "running" || !handle?.isRunning) throw new Error("TASK_NOT_RUNNING: exact running taskId with canMessage:true required; no broadcast or queued-step messaging");
		if (mode === "query") {
			const queries = job.tasks.flatMap((task, taskIndex) => job.interactive.get(taskIndex)?.snapshot().queries ?? task.queries ?? []);
			if (queries.filter(query => query.status === "accepted" || query.cleanupPending === true).length >= 2 || queries.length >= 32) throw new Error("QUERY_CAPACITY: at most two concurrent and 32 retained queries per job");
		}
		return mode === "control" ? handle.control(text) : handle.query(text);
	}
	submit(owner: string, cwd: string, epoch: number, agents: string[], run: (signal: AbortSignal, taskIds: string[], live: (index: number, sessionId: string, path: string) => void, finish: (index: number, result: unknown, status: BackgroundTask["status"]) => void, attach: (index: number, handle: RpcInteraction) => void, interaction: (index: number, notice: InteractionNotice) => void) => Promise<void>) {
		if (this.closed || epoch !== this.generation) throw new Error("BACKGROUND_RUNTIME_CLOSED: owner session changed during preflight");
		if (!agents.length || agents.length > MAX_SUBMITTED || submittedTasks + agents.length > MAX_SUBMITTED) throw new Error(`BACKGROUND_CAPACITY: at most ${MAX_SUBMITTED} submitted background tasks process-wide (now ${this.load()}; this request adds ${agents.length}). Next: call subagent_status (no jobId lists your jobs) to see what is still running, subagent_cancel jobs you no longer need, or split the work into smaller batches and submit the rest after task_result followUps arrive.`);
		for (const [id, job] of this.jobs) {
			if (this.jobs.size < MAX_RETAINED_JOBS) break;
			if (!["queued", "running"].includes(job.status)) this.jobs.delete(id);
		}
		if (this.jobs.size >= MAX_RETAINED_JOBS) throw new Error(`BACKGROUND_CAPACITY: retained job limit (${MAX_RETAINED_JOBS}) reached with unfinished jobs (now ${this.load()}). Next: call subagent_status to list jobs and subagent_cancel ones you no longer need, then retry.`);
		const job: Job = { jobId: ulid().toLowerCase(), owner, cwd, generation: this.generation, status: "queued", cancelRequested: false,
			tasks: agents.map(agent => ({ taskId: ulid().toLowerCase(), agent, status: "queued", logPending: true })), controller: new AbortController(), done: Promise.resolve(), interactive: new Map() };
		this.jobs.set(job.jobId, job);
		submittedTasks += agents.length;
		const receipt = this.view(job);
		// Defer runner admission until the queued receipt has been constructed. Do not
		// bind background lifetime to a tool-turn signal after acceptance.
		job.done = Promise.resolve().then(async () => {
			job.status = "running";
			const send = (kind: "task_result" | "log_ready") => {
				if (!this.closed && job.generation === this.generation) {
					try { this.notify(kind, this.view(job)); } catch { void this.shutdown(); /* stale/disposed owner: fail closed, no retry */ }
				}
			};
			try {
				await run(job.controller.signal, job.tasks.map(task => task.taskId), (index, sessionId, path) => {
					Object.assign(job.tasks[index], { status: "running", subagentSessionId: sessionId, liveLogPath: path, finalLogPath: path.endsWith(".partial") ? path.slice(0, -".partial".length) : undefined, logPending: false });
					send("log_ready");
				}, (index, result, status) => {
					const task = job.tasks[index];
					const handle = job.interactive.get(index);
					if (handle) { Object.assign(task, handle.snapshot(), { canMessage: false }); job.interactive.delete(index); }
					task.result = result; task.status = status;
					if (result && typeof result === "object" && "logPath" in result && result.logPath) { delete task.liveLogPath; delete task.finalLogPath; }
					if (result && typeof result === "object" && "subagentSessionId" in result && typeof result.subagentSessionId === "string") task.subagentSessionId = result.subagentSessionId;
				}, (index, handle) => { job.interactive.set(index, handle); send("log_ready"); }, (index, notice) => {
					if (!this.closed && job.generation === this.generation) {
						try { this.notify(notice.kind, this.view(job), { ...notice, taskId: job.tasks[index].taskId }); } catch { void this.shutdown(); /* stale/disposed owner: fail closed, no retry */ }
					}
				});
				for (const task of job.tasks) if (task.status === "queued") task.status = job.controller.signal.aborted ? "aborted" : "skipped";
				job.status = job.controller.signal.aborted ? "aborted" : job.tasks.some(task => task.status !== "completed") ? "failed" : "completed";
			} catch (error) {
				job.status = job.controller.signal.aborted ? "aborted" : "failed";
				for (const task of job.tasks) if (["queued", "running"].includes(task.status)) {
					task.status = job.status; task.result = { error: error instanceof Error ? error.message : String(error) };
				}
			} finally {
				// Retain only bounded plain receipts, not exited ChildProcess/event
				// closures that can retain native contexts and full runner output.
				for (const [index, handle] of job.interactive) { handle.close(job.controller.signal.aborted); Object.assign(job.tasks[index], handle.snapshot(), { canMessage: false }); }
				job.interactive.clear(); submittedTasks -= agents.length; send("task_result");
			}
		});
		return receipt;
	}
	async shutdown(waitMs = 15_000) {
		this.closed = true;
		this.generation++;
		const jobs = [...this.jobs.values()];
		for (const job of jobs) { if (["queued", "running"].includes(job.status)) job.cancelRequested = true; job.controller.abort(); }
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([Promise.allSettled(jobs.map(job => job.done)), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
		} finally { if (timer) clearTimeout(timer); this.jobs.clear(); }
	}
}
