import { ulid } from "ulid";
import type { SubagentWidgetRow } from "./live-widget.ts";
import { panelUsage, safeJobText, usageDetails, type PanelJob, type PanelUsage } from "../../../shell-tools/src/job-view.js";
export interface TaskPresentation { activity: string; usage?: PanelUsage; usageReported: boolean }
import type { RecoverySnapshot, RecoveryWriter } from "../../../shell-tools/src/recovery.js";
import { copyResultSummary, resultSummary } from "./result.ts";
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
	readOnlyQuery?: boolean;
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
	/** UI-only titles: deliberately absent from receipts/model/structured content. */
	widgetTitles: string[];
	widgetProgress: Array<TaskPresentation | undefined>;
	widgetStartedAt: number;
	recovery?: RecoveryWriter;
	/** Ready-session query has its own job but never claims a main-task result. */
	readonlyQueryId?: string;
	readonlyQueryStarted?: boolean;
	readonlyQueryNotice?: InteractionNotice & { taskId: string; subagentSessionId?: string; action: "query" };
	readonlyQueryRunnerError?: string;
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
	if (task.readOnlyQuery) out.readOnlyQuery = true;
	out.canMessage = task.canMessage === true;
	out.logPending = task.logPending;
	if (task.controls?.length) out.controls = task.controls.map(control => ({ messageId: control.messageId, status: control.status }));
	if (task.queries?.length) out.queries = task.queries.map(query => ({ queryId: query.queryId, status: query.status }));
	if (isPlainRecord(task.result)) {
		const result = task.result, slim: Record<string, unknown> = {};
		for (const key of ["output", "errorCode", "errorMessage", "error", "logError", "logPath"]) if (typeof result[key] === "string" && result[key]) slim[key] = result[key];
		if (typeof result.exitCode === "number" && result.exitCode !== 0) slim.exitCode = result.exitCode;
		if (typeof result.stopReason === "string" && result.stopReason && result.stopReason !== "stop") slim.stopReason = result.stopReason;
		if (result.outputTruncated === true) slim.outputTruncated = true;
		if (typeof result.canResume === "boolean") slim.canResume = result.canResume;
		if (typeof result.subagentSessionId === "string" && result.subagentSessionId !== task.subagentSessionId) slim.subagentSessionId = result.subagentSessionId;
		// Background usage is not added to host totals, so keep the two numbers needed for accounting.
		if (isPlainRecord(result.usage) && typeof result.usage.totalTokens === "number") slim.usage = { totalTokens: result.usage.totalTokens, ...(typeof result.usage.cost === "number" && result.usage.cost > 0 ? { cost: result.usage.cost } : {}) };
		out.result = slim;
	}
	return out;
}

export function slimReceipt(receipt: BackgroundReceipt, kind?: string): Record<string, unknown> {
	return { ...(kind ? { kind } : {}), jobId: receipt.jobId, status: receipt.status, cancelRequested: receipt.cancelRequested, tasks: receipt.tasks.map(slimTask) };
}

export function slimJobList(jobs: BackgroundJobSummary[]): Record<string, unknown> {
	return { jobs: jobs.map(job => ({ jobId: job.jobId, status: job.status, cancelRequested: job.cancelRequested,
		tasks: job.tasks.map(task => ({ taskId: task.taskId, agent: task.agent, status: task.status, ...(typeof task.canMessage === "boolean" ? { canMessage: task.canMessage } : {}), ...(task.summary ? { summary: task.summary } : {}) })) })) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface NotificationObservation {
	phase: "canonical_applied" | "callback_attempted" | "callback_returned" | "callback_threw" | "suppressed";
	kind: "task_result" | "log_ready" | "control_result" | "query_result";
	jobId: string;
	taskId?: string;
	generation: number;
	/** The extension API supplies no queue/persistence acknowledgment. */
	hostAcknowledgment: "unknown";
}

export class BackgroundJobs {
	private jobs = new Map<string, Job>();
	private generation = 0;
	private closed = false;
	private observations: NotificationObservation[] = [];
	private omittedObservations = 0;
	constructor(
		private readonly notify: (kind: "task_result" | "log_ready" | "control_result" | "query_result", receipt: BackgroundReceipt, interaction?: InteractionNotice & { taskId: string; subagentSessionId?: string; action: "control" | "query" }) => void,
		/** Optional process-wide active-child count, used only for diagnostics. */
		private readonly activeCount?: () => number,
		/** Optional presentation observer; errors cannot change execution. */
		private readonly onChange?: () => void,
		private readonly observer?: (event: NotificationObservation) => void,
		/** Acceptance journal must succeed before a runner can start. */
		private readonly persist?: (owner: string, cwd: string, snapshot: RecoverySnapshot) => RecoveryWriter,
	) {}
	private snapshot(job: Job, terminal = false): RecoverySnapshot {
		return { jobId: job.jobId, state: job.status, started: job.readonlyQueryId ? job.readonlyQueryStarted === true : job.tasks.some(t => !t.logPending), cancelRequested: job.cancelRequested, terminal,
			tasks: job.tasks.map(t => {
				const r = isPlainRecord(t.result) ? t.result : {};
				return { taskId: t.taskId, subagentSessionId: t.subagentSessionId, state: t.status,
					...(Number.isSafeInteger(r.exitCode) ? { exitCode: r.exitCode as number } : {}), ...(typeof r.errorCode === "string" ? { errorCode: r.errorCode } : {}) };
			}) };
	}
	private record(job: Job, terminal = false) { job.recovery?.update(this.snapshot(job, terminal)); }
	/** Internal, bounded, payload-free diagnostic evidence; never a delivery receipt. */
	notificationEvidence() { return { events: this.observations.map(event => ({ ...event })), omitted: this.omittedObservations }; }
	private observe(job: Job, kind: NotificationObservation["kind"], phase: NotificationObservation["phase"], taskId?: string) {
		const event: NotificationObservation = Object.freeze({ phase, kind, jobId: job.jobId, ...(taskId ? { taskId } : {}), generation: job.generation, hostAcknowledgment: "unknown" });
		if (this.observations.length === 128) { this.observations.shift(); this.omittedObservations++; }
		this.observations.push(event);
		try { this.observer?.(event); } catch { /* diagnostics cannot change lifecycle */ }
	}
	private deliver(job: Job, kind: NotificationObservation["kind"], admitted: boolean, interaction?: InteractionNotice & { taskId: string; subagentSessionId?: string; action: "control" | "query" }) {
		if (!admitted || this.closed || job.generation !== this.generation || this.jobs.get(job.jobId) !== job) {
			this.observe(job, kind, "suppressed", interaction?.taskId); return;
		}
		if (job.readonlyQueryId && (kind === "task_result" || kind === "log_ready")) { this.observe(job, kind, "suppressed"); return; }
		this.observe(job, kind, "callback_attempted", interaction?.taskId);
		try {
			this.notify(kind, this.view(job), interaction);
			this.observe(job, kind, "callback_returned", interaction?.taskId);
		} catch {
			this.observe(job, kind, "callback_threw", interaction?.taskId);
			void this.shutdown(); // Existing fail-closed behavior; no retry/async host ack.
		}
	}
	private changed(job?: Job) {
		if (job && (this.closed || job.generation !== this.generation)) return;
		try { this.onChange?.(); } catch { /* UI/observer failures are isolated. */ }
	}
	/** Minimal UI-only projection; never copies outputs or queries/controls. */
	activePanel(owner: string, cwd: string): SubagentWidgetRow[] {
		if (this.closed) return [];
		return [...this.jobs.values()].filter(job => job.owner === owner && job.cwd === cwd && job.generation === this.generation && (job.status === "queued" || job.status === "running")).flatMap(job => {
			const rows: SubagentWidgetRow[] = job.tasks.flatMap((task, index) => task.status === "queued" || task.status === "running" ? [{ jobId: job.jobId, taskId: task.taskId, agent: `${task.agent}${task.readOnlyQuery ? " (query)" : ""}`.slice(0, 256), title: job.widgetTitles[index], status: task.status, cancelRequested: job.cancelRequested }] : []);
			return rows.length ? rows : [{ jobId: job.jobId, status: "finalizing" as const, cancelRequested: job.cancelRequested }];
		});
	}
	/** Owned retained metadata only, grouped by job. No output/prompt/query answers or execution handles escape. */
	panelJobs(owner: string, cwd: string): PanelJob[] {
		if (this.closed) return [];
		return [...this.jobs.values()].filter(job => job.owner === owner && job.cwd === cwd && job.generation === this.generation).map(job => {
			const active = job.status === "queued" || job.status === "running";
			const running = job.tasks.filter(t => t.status === "running").length, queued = job.tasks.filter(t => t.status === "queued").length;
			const finalizing = active && !queued && (!running || job.tasks.every((t, i) => t.status !== "running" || job.interactive.get(i)?.isRunning === false));
			const state = active && job.cancelRequested ? "cancelling" : finalizing ? "finalizing" : job.status;
			const usage: PanelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
			let reported = 0;
			const details: string[] = [];
			for (const [index, task] of job.tasks.entries()) {
				const result = isPlainRecord(task.result) ? task.result : {}, progress = job.widgetProgress[index];
				// Query usage is independent. Never add live query usage to its main task.
				let queries = job.interactive.get(index)?.snapshot().queries ?? task.queries ?? [];
				if (job.readonlyQueryId && active) { const q = this.provisionalReadyQuery(job, queries[0]); queries = q ? [q] : []; }
				const query = job.readonlyQueryId ? queries.find(q => q.queryId === job.readonlyQueryId) : undefined;
				const finalUsage = panelUsage(result.usage);
				// A positive final total proves observed use even if a logging failure prevented the last UI event.
				// Reported zero needs the runner's private evidence; initialization zero must stay unknown.
				const value = query ? panelUsage(query.usage) : finalUsage && (finalUsage.totalTokens > 0 || progress?.usageReported) ? finalUsage : progress?.usageReported ? panelUsage(progress.usage) : undefined;
				if (value) { reported++; for (const key of Object.keys(usage) as (keyof PanelUsage)[]) usage[key] += value[key]; }
				details.push(`Task ${index + 1}: ${safeJobText(task.agent, 256)} · ${task.status} · ${safeJobText(job.widgetTitles[index] ?? "", 256)}`,
					`Task ID: ${safeJobText(task.taskId)} · Session ID: ${safeJobText(task.subagentSessionId ?? "pending")}`,
					`Activity: ${safeJobText(progress?.activity ?? (task.status === "queued" ? "Queued" : task.status))}`,
					usageDetails(value));
				const log = typeof result.logPath === "string" ? result.logPath : task.liveLogPath;
				if (log) details.push(`Log: ${safeJobText(log)}`);
				if (typeof result.model === "string") details.push(`Model: ${safeJobText(result.model, 256)}`);
				if (task.finalLogPath) details.push(`Future final log path (not confirmed): ${safeJobText(task.finalLogPath)}`);
				if (typeof result.exitCode === "number") details.push(`Exit code: ${result.exitCode}`);
				if (typeof result.errorCode === "string") details.push(`Reason code: ${safeJobText(result.errorCode, 256)}`);
				for (const q of queries.slice(0, 32)) details.push(`Independent query ${safeJobText(q.queryId, 256)} · ${q.status}${q.cleanupPending ? " · cleanup pending" : ""}${q.usageUnknown ? " · usage unknown" : ""} · ${usageDetails(panelUsage(q.usage))}`);
			}
			let activity = state === "cancelling" ? `Cancel requested · ${finalizing ? "finalizing · " : ""}awaiting settlement` : state === "finalizing" ? "Finalizing · finishing cleanup" : !active ? job.status : job.tasks.length > 1 ? `${running} running / ${queued} queued / ${job.tasks.length - running - queued} finished` : job.widgetProgress[0]?.activity ?? (queued ? "Queued" : job.readonlyQueryId ? "Query running · snapshot request" : "Starting");
			if (reported && reported < job.tasks.length) activity += " · usage partial";
			details.unshift(`Reported task usage: ${reported}/${job.tasks.length} · ${usageDetails(reported ? usage : undefined)}`);
			return { kind: "subagents", jobId: job.jobId, label: job.tasks.length > 1 ? `batch (${job.tasks.length} tasks)` : `${safeJobText(job.tasks[0].agent, 64)}${job.readonlyQueryId ? " (query)" : ""}`,
				title: safeJobText(job.widgetTitles[0] ?? "", 256), state, active, activity, startedAt: job.widgetStartedAt,
				usage: reported ? usage : undefined, usageState: reported ? "reported" : active ? "pending" : "unknown", details };
		});
	}
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
				const summary = isPlainRecord(task.result) ? resultSummary(task.result, 200) : "";
				return { taskId: task.taskId, agent: task.agent, status: task.status, ...(task.canMessage === undefined ? {} : { canMessage: task.canMessage }), ...(summary ? { summary } : {}) };
			}) };
		});
	}
	get epoch() { return this.generation; }
	start() { this.closed = false; this.changed(); }
	/** Shared ready-query arbitration: model terminal evidence is not worker/lease settlement. */
	private provisionalReadyQuery(job: Job, source?: QueryReceipt): QueryReceipt | undefined {
		const notice = job.readonlyQueryNotice;
		const query: QueryReceipt | undefined = notice
			? { ...notice, queryId: job.readonlyQueryId!, status: notice.status as QueryReceipt["status"] }
			: source ? { ...source } : undefined;
		if (query) {
			query.cleanupPending = true;
			query.cleanupEvidence = { ...(isPlainRecord(query.cleanupEvidence) ? query.cleanupEvidence : {}), originalLeaseReleased: false };
			if (query.status === "completed") query.status = "accepted";
			delete query.output;
		}
		return query;
	}
	private view(job: Job): BackgroundReceipt {
		const view = structuredClone({ jobId: job.jobId, status: job.status, tasks: job.tasks.map((task, index) => {
			const handle = job.interactive.get(index);
			const projected = { ...task, ...(handle ? { canMessage: !job.readonlyQueryId && handle.isRunning && !job.cancelRequested, ...handle.snapshot() } : {}) };
			if (job.readonlyQueryId && ["queued", "running"].includes(job.status)) {
				// RPC terminal evidence describes the model request, not worker/lease cleanup.
				// Worker faults outrank it until settlement installs the final retained receipt.
				const query = this.provisionalReadyQuery(job, projected.queries?.[0]);
				if (query) projected.queries = [query];
				if (projected.status === "completed") projected.status = "running";
				// The worker-local result cannot certify original-lease settlement.
				delete projected.result;
			}
			return projected;
		}), cancelRequested: job.cancelRequested });
		for (const [index, task] of view.tasks.entries()) if (isPlainRecord(job.tasks[index].result) && isPlainRecord(task.result)) copyResultSummary(job.tasks[index].result, task.result);
		return view;
	}
	get(id: string, owner: string, cwd: string) {
		const job = this.jobs.get(id);
		if (!job || job.owner !== owner || job.cwd !== cwd || job.generation !== this.generation || this.closed) throw new Error("BACKGROUND_JOB_NOT_FOUND: job belongs to a different owner/runtime or is no longer retained");
		return this.view(job);
	}
	cancel(id: string, owner: string, cwd: string) {
		this.get(id, owner, cwd);
		const job = this.jobs.get(id)!;
		if (job.status === "queued" || job.status === "running") { job.cancelRequested = true; this.record(job); job.controller.abort(); this.changed(job); }
		return this.view(job);
	}
	/** Resolve current state, never a parent's canMessage snapshot. No await between lookup and delivery. */
	locate(sessionId: string, owner: string, cwd: string) {
		if (this.closed) throw new Error("BACKGROUND_RUNTIME_CLOSED: runtime is closed");
		for (const job of [...this.jobs.values()].reverse()) {
			const index = job.tasks.findIndex(task => task.subagentSessionId === sessionId);
			if (index < 0 || !["queued", "running"].includes(job.status)) continue;
			if (job.owner !== owner || job.cwd !== cwd || job.generation !== this.generation) throw new Error("OWNER_MISMATCH: active session is not owned by this parent/canonical cwd/runtime");
			const task = job.tasks[index], handle = job.interactive.get(index);
			const state = job.cancelRequested ? "canceling" : task.status === "queued" ? "queued" : job.readonlyQueryId ? "busy" : handle?.isRunning ? "running" : handle ? "finalizing" : task.status === "running" ? "startup" : "finalizing";
			return { jobId: job.jobId, taskId: task.taskId, state };
		}
		return undefined;
	}
	/** Hold admission while allocating real managed identities; no runner is admitted before prepare succeeds. */
	async submitManaged(owner: string, cwd: string, epoch: number, agents: string[], prepare: (signal: AbortSignal) => Promise<string[]>, run: Parameters<BackgroundJobs["submit"]>[4], titles: readonly (string | undefined)[] = [], beforeAccept?: () => void, readonlyQueryId?: string, toolSignal?: AbortSignal) {
		let start!: () => void, reject!: (error: unknown) => void;
		const ready = new Promise<void>((resolve, fail) => { start = resolve; reject = fail; });
		// submit installs its rejection handler before prepare can fail.
		const receipt = this.submit(owner, cwd, epoch, agents, run, titles, ready, readonlyQueryId);
		const job = this.jobs.get(receipt.jobId)!;
		let preparation: Promise<string[]> | undefined;
		const abortTool = () => { job.cancelRequested = true; job.controller.abort(); };
		let abortPreparation!: () => void;
		const aborted = new Promise<never>((_resolve, fail) => {
			abortPreparation = () => fail(new Error("BACKGROUND_PREPARATION_ABORTED: managed allocation cancelled; actual I/O cleanup remains owned"));
			job.controller.signal.addEventListener("abort", abortPreparation, { once: true });
		});
		// Install rejection ownership before checking an already-aborted signal.
		void aborted.catch(() => undefined);
		toolSignal?.addEventListener("abort", abortTool, { once: true });
		if (toolSignal?.aborted) abortTool();
		try {
			// Persist queued intent before managed allocation touches child metadata.
			// Identity enrichment follows preparation; no child runner exists yet.
			job.recovery = this.persist?.(owner, cwd, this.snapshot(job));
			preparation = Promise.resolve().then(() => {
				if (job.controller.signal.aborted) throw new Error("BACKGROUND_PREPARATION_ABORTED: allocation not started");
				return prepare(job.controller.signal);
			});
			const ids = await Promise.race([preparation, aborted]);
			beforeAccept?.(); // Last synchronous abort fence before publishing acceptance.
			if (this.closed || epoch !== this.generation || job.cancelRequested) throw new Error("BACKGROUND_RUNTIME_CLOSED: owner changed during managed allocation");
			if (ids.length !== agents.length) throw new Error("INVALID_DISPATCH: missing managed session identity");
			for (const [index, id] of ids.entries()) job.tasks[index].subagentSessionId = id;
			const accepted = this.view(job);
			this.record(job);
			start();
			return accepted;
		} catch (error) {
			// Rejection of the caller's wait is NOT allocation settlement. Keep ready,
			// job.done and submitted capacity owned until the actual prepare finishes.
			const cleanup = Promise.resolve(preparation).catch(() => undefined).then(async () => {
				reject(error); await job.done;
				if (this.jobs.get(job.jobId) === job) this.jobs.delete(job.jobId);
			});
			if (job.controller.signal.aborted) void cleanup.catch(() => undefined);
			else await cleanup;
			throw error;
		} finally {
			toolSignal?.removeEventListener("abort", abortTool);
			job.controller.signal.removeEventListener("abort", abortPreparation);
		}
	}
	message(id: string, taskId: string, mode: "control" | "query", text: string, owner: string, cwd: string) {
		this.get(id, owner, cwd);
		const job = this.jobs.get(id)!;
		const index = job.tasks.findIndex(task => task.taskId === taskId);
		const handle = job.interactive.get(index);
		if (index < 0 || job.cancelRequested || job.tasks[index].status !== "running" || !handle?.isRunning) throw new Error("TASK_NOT_RUNNING: exact running taskId with canMessage:true required; no broadcast or queued-step messaging");
		if (mode === "query") {
			const queries = job.tasks.flatMap((task, taskIndex) => job.interactive.get(taskIndex)?.snapshot().queries ?? task.queries ?? []);
			if (queries.filter(query => query.status === "accepted" || query.cleanupPending === true).length >= 2 || queries.length >= 32) throw new Error("QUERY_CAPACITY: Request not accepted: capacity limit reached. at most two concurrent and 32 retained queries per job");
		}
		return mode === "control" ? handle.control(text) : handle.query(text);
	}
	submit(owner: string, cwd: string, epoch: number, agents: string[], run: (signal: AbortSignal, taskIds: string[], live: (index: number, sessionId: string, path: string) => void, finish: (index: number, result: unknown, status: BackgroundTask["status"]) => void, attach: (index: number, handle: RpcInteraction) => void, interaction: (index: number, notice: InteractionNotice) => void, progress: (index: number, data: TaskPresentation) => void) => Promise<void>, widgetTitles: readonly (string | undefined)[] = [], admission?: Promise<void>, readonlyQueryId?: string) {
		if (this.closed || epoch !== this.generation) throw new Error("BACKGROUND_RUNTIME_CLOSED: owner session changed during preflight");
		if (!agents.length || agents.length > MAX_SUBMITTED || submittedTasks + agents.length > MAX_SUBMITTED) throw new Error(`BACKGROUND_CAPACITY: Request not accepted: capacity limit reached. at most ${MAX_SUBMITTED} submitted background tasks process-wide (now ${this.load()}; this request adds ${agents.length}). Next: call subagent_status (no jobId lists your jobs) to see what is still running, subagent_cancel jobs you no longer need, or split the work into smaller batches and submit the rest after task_result completion notifications arrive.`);
		for (const [id, job] of this.jobs) {
			if (this.jobs.size < MAX_RETAINED_JOBS) break;
			if (!["queued", "running"].includes(job.status)) this.jobs.delete(id);
		}
		if (this.jobs.size >= MAX_RETAINED_JOBS) throw new Error(`BACKGROUND_CAPACITY: Request not accepted: capacity limit reached. retained job limit (${MAX_RETAINED_JOBS}) reached with unfinished jobs (now ${this.load()}). Next: call subagent_status to list jobs and subagent_cancel ones you no longer need, then retry.`);
		const job: Job = { jobId: ulid().toUpperCase(), owner, cwd, generation: this.generation, status: "queued", cancelRequested: false,
			tasks: agents.map(agent => ({ taskId: ulid().toUpperCase(), agent, status: "queued", logPending: true })), controller: new AbortController(), done: Promise.resolve(), interactive: new Map(), readonlyQueryId, widgetTitles: agents.map((_agent, index) => widgetTitles[index]?.slice(0, 256) ?? ""), widgetProgress: [], widgetStartedAt: Date.now() };
		if (!admission) job.recovery = this.persist?.(owner, cwd, this.snapshot(job));
		if (readonlyQueryId) Object.assign(job.tasks[0], { queries: [{ queryId: readonlyQueryId, status: "accepted" }], readOnlyQuery: true, logPending: false, canMessage: false });
		this.jobs.set(job.jobId, job);
		submittedTasks += agents.length;
		const receipt = this.view(job);
		this.changed(job);
		// Defer runner admission until the queued receipt has been constructed. Do not
		// bind background lifetime to a tool-turn signal after acceptance.
		job.done = Promise.resolve().then(async () => {
			let admitted = !admission;
			const send = (kind: "task_result" | "log_ready") => this.deliver(job, kind, admitted);
			try {
				if (admission) await admission;
				admitted = true;
				job.status = "running";
				this.record(job); this.changed(job);
				await run(job.controller.signal, job.tasks.map(task => task.taskId), (index, sessionId, path) => {
					Object.assign(job.tasks[index], { status: "running", subagentSessionId: sessionId, liveLogPath: path, finalLogPath: path.endsWith(".partial") ? path.slice(0, -".partial".length) : undefined, logPending: false });
					this.record(job); this.changed(job);
					send("log_ready");
				}, (index, result, status) => {
					const task = job.tasks[index];
					const handle = job.interactive.get(index);
					if (handle) { Object.assign(task, handle.snapshot(), { canMessage: false }); job.interactive.delete(index); }
					task.result = result; task.status = status;
					if (result && typeof result === "object" && "logPath" in result && result.logPath) { delete task.liveLogPath; delete task.finalLogPath; }
					if (result && typeof result === "object" && "subagentSessionId" in result && typeof result.subagentSessionId === "string") task.subagentSessionId = result.subagentSessionId;
					this.record(job); this.changed(job);
				}, (index, handle) => { if (job.readonlyQueryId) { job.tasks[index].status = "running"; job.readonlyQueryStarted = true; this.record(job); } job.interactive.set(index, handle); this.changed(job); send("log_ready"); }, (index, notice) => {
					if (notice.kind === "control_result" && notice.status === "applied") this.observe(job, notice.kind, "canonical_applied", job.tasks[index].taskId);
					if (!this.closed && job.generation === this.generation && this.jobs.get(job.jobId) === job) {
						// After finish(), retain plain snapshots, not the child handle. Reconcile
						// only a previously accepted receipt; no late event revives a task.
						if (!job.interactive.has(index)) {
							const { kind, ...receipt } = notice;
							const saved = kind === "query_result"
								? job.tasks[index].queries?.find(query => query.queryId === notice.queryId)
								: job.tasks[index].controls?.find(control => control.messageId === notice.messageId);
							if (saved) Object.assign(saved, receipt);
						}
					}
					if (job.readonlyQueryId && notice.kind === "query_result") {
						job.readonlyQueryNotice = { ...notice, taskId: job.tasks[index].taskId, subagentSessionId: job.tasks[index].subagentSessionId, action: "query" };
						if (notice.cleanupPending === true) { this.deliver(job, "query_result", admitted, job.readonlyQueryNotice); }
					} else this.deliver(job, notice.kind, admitted, { ...notice, taskId: job.tasks[index].taskId, subagentSessionId: job.tasks[index].subagentSessionId, action: notice.kind === "query_result" ? "query" : "control" });
					this.changed(job);
				}, (index, data) => {
					if (this.closed || job.generation !== this.generation || this.jobs.get(job.jobId) !== job || !["queued", "running"].includes(job.status) || !["queued", "running"].includes(job.tasks[index]?.status)) return;
					job.widgetProgress[index] = { activity: safeJobText(data.activity, 256), usageReported: data.usageReported, usage: data.usageReported ? panelUsage(data.usage) : undefined };
					this.changed(job);
				});
				for (const task of job.tasks) if (task.status === "queued") task.status = job.controller.signal.aborted ? "aborted" : "skipped";
				job.status = job.controller.signal.aborted ? "aborted" : job.tasks.some(task => task.status !== "completed") ? "failed" : "completed";
			} catch (error) {
				if (job.readonlyQueryId) job.readonlyQueryRunnerError = error instanceof Error ? error.message : String(error);
				job.status = job.controller.signal.aborted ? "aborted" : "failed";
				for (const task of job.tasks) if (job.readonlyQueryId || ["queued", "running"].includes(task.status)) {
					task.status = job.status; task.result = job.readonlyQueryId ? { ...(isPlainRecord(task.result) ? task.result : {}), status: job.status, error: error instanceof Error ? error.message : String(error) } : { error: error instanceof Error ? error.message : String(error) };
					if (job.readonlyQueryId && isPlainRecord(task.result)) {
						delete task.result.output;
						task.result.cleanupPending = true;
						task.result.cleanupEvidence = { ...(isPlainRecord(task.result.cleanupEvidence) ? task.result.cleanupEvidence : {}), originalLeaseReleased: false };
					}
				}
			} finally {
				// Retain only bounded plain receipts, not exited ChildProcess/event
				// closures that can retain native contexts and full runner output.
				for (const [index, handle] of job.interactive) { handle.close(job.controller.signal.aborted); Object.assign(job.tasks[index], handle.snapshot(), { canMessage: false }); }
				job.interactive.clear(); submittedTasks -= agents.length;
				if (job.readonlyQueryId) {
					let notice = job.readonlyQueryNotice;
					if (!notice || job.readonlyQueryRunnerError !== undefined) {
						notice = { ...notice, kind: "query_result", queryId: job.readonlyQueryId, status: job.status === "aborted" ? "aborted" : "failed", taskId: job.tasks[0].taskId, subagentSessionId: job.tasks[0].subagentSessionId, action: "query", cleanupPending: true, usageUnknown: !notice?.usage, error: job.readonlyQueryRunnerError ?? "Ready query cleanup unconfirmed" };
						delete notice.output;
					}
					// A fulfilled runner includes original read-lease release; a failed
					// runner must never infer it from model terminal evidence.
					notice = { ...notice, cleanupEvidence: { ...(isPlainRecord(notice.cleanupEvidence) ? notice.cleanupEvidence : {}), originalLeaseReleased: job.readonlyQueryRunnerError === undefined } };
					const { kind: _kind, taskId: _taskId, subagentSessionId: _sessionId, action: _action, ...queryReceipt } = notice;
					job.tasks[0].queries = [{ ...queryReceipt, queryId: job.readonlyQueryId, status: notice.status as QueryReceipt["status"] }];
					this.record(job, true); this.changed(job);
					this.deliver(job, "query_result", admitted, notice);
				} else { this.record(job, true); this.changed(job); }
				send("task_result");
			}
		});
		return receipt;
	}
	async shutdown(waitMs = 15_000) {
		this.closed = true;
		this.generation++;
		this.changed();
		const jobs = [...this.jobs.values()];
		for (const job of jobs) { if (["queued", "running"].includes(job.status)) { job.cancelRequested = true; this.record(job); } job.controller.abort(); }
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([Promise.allSettled(jobs.map(job => job.done)), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
		} finally { if (timer) clearTimeout(timer); this.jobs.clear(); }
	}
}
