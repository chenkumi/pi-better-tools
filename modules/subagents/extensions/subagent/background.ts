import { ulid } from "ulid";
import type { RpcInteraction, ControlReceipt, QueryReceipt, InteractionNotice } from "./rpc.ts";

export interface BackgroundTask {
	taskId: string;
	agent: string;
	status: "queued" | "running" | "completed" | "failed" | "aborted" | "skipped";
	logPending: boolean;
	subagentSessionId?: string;
	liveLogPath?: string;
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

export class BackgroundJobs {
	private jobs = new Map<string, Job>();
	private generation = 0;
	private closed = false;
	constructor(private readonly notify: (kind: "task_result" | "log_ready" | "control_result" | "query_result", receipt: BackgroundReceipt, interaction?: InteractionNotice & { taskId: string }) => void) {}
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
		if (!agents.length || agents.length > MAX_SUBMITTED || submittedTasks + agents.length > MAX_SUBMITTED) throw new Error("BACKGROUND_CAPACITY: at most 32 submitted background tasks process-wide");
		for (const [id, job] of this.jobs) {
			if (this.jobs.size < MAX_RETAINED_JOBS) break;
			if (!["queued", "running"].includes(job.status)) this.jobs.delete(id);
		}
		if (this.jobs.size >= MAX_RETAINED_JOBS) throw new Error("BACKGROUND_CAPACITY: retained job limit reached");
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
					Object.assign(job.tasks[index], { status: "running", subagentSessionId: sessionId, liveLogPath: path, logPending: false });
					send("log_ready");
				}, (index, result, status) => {
					const task = job.tasks[index];
					const handle = job.interactive.get(index);
					if (handle) { Object.assign(task, handle.snapshot(), { canMessage: false }); job.interactive.delete(index); }
					task.result = result; task.status = status;
					if (result && typeof result === "object" && "logPath" in result && result.logPath) delete task.liveLogPath;
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
