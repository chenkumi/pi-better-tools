/**
 * Job service: the one place that creates, changes and removes stored jobs. Tools (and later the panel) go through it,
 * so naming, ownership, deadline and state rules are written once. Every change is a locked read-modify-write; messages
 * name arguments only and never include the store path.
 */
import type { Clock } from "./clock.ts";
import { nextDue, parseIso } from "./schedule.ts";
import type { ScheduleStore } from "./storage.ts";
import { newJobId } from "./storage.ts";
import type { Job, JobBody, JobCommon, JobKind, MissedPolicy, Schedule } from "./types.ts";
import { validateJob, ValidationError } from "./validate.ts";

export class JobError extends Error {}

export type Owns = (job: Job) => boolean;
export const ownsPromptTool: Owns = (job) => job.kind === "prompt" || job.kind === "agent";
export const ownsShellTool: Owns = (job) => job.kind === "shell";

export interface NewJob {
	name?: string;
	description?: string;
	schedule: Schedule;
	endAt?: string;
	missed?: MissedPolicy;
	maxLateMs?: number;
	body: JobBody;
}

/** Fields an update may change. `endAt: null` clears the deadline. Body fields are merged into the job's own kind. */
export interface JobPatch {
	name?: string;
	description?: string;
	schedule?: Schedule;
	endAt?: string | null;
	missed?: MissedPolicy;
	maxLateMs?: number;
	body?: Record<string, unknown>;
}

export interface JobServiceOptions {
	store: ScheduleStore;
	clock: Clock;
	sessionId: string;
	/** "session" binds new jobs to this session; "workdir" leaves them visible to every session of the directory. */
	scope: () => "session" | "workdir";
	/** Called after the stored jobs changed so the engine can re-arm. */
	changed: () => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const KIND_TOOL: Record<JobKind, string> = { prompt: "schedule_prompt", agent: "schedule_prompt", shell: "schedule_shell", monitor: "schedule_monitor" };

export class JobService {
	readonly #o: JobServiceOptions;
	constructor(options: JobServiceOptions) { this.#o = options; }

	visible = (job: Job): boolean => job.session === undefined || job.session === this.#o.sessionId;

	list(owns: Owns): Job[] {
		return this.#o.store.read().store.jobs.filter((job) => this.visible(job) && owns(job));
	}

	get(id: string, owns: Owns): Job {
		const all = this.#o.store.read().store.jobs.filter(this.visible);
		const job = all.find((j) => j.id === id);
		if (!job) {
			const shown = all.slice(0, 10).map((j) => `${j.id} (${j.name})`);
			throw new JobError(`jobId: "${id}" was not found. Use an id exactly as action "list" shows it (jobs of other sessions are hidden).${all.length ? ` Known jobs: ${shown.join(", ")}${all.length > shown.length ? `, and ${all.length - shown.length} more` : ""}.` : " No jobs are visible to this session."}`);
		}
		if (!owns(job)) throw new JobError(`jobId: "${id}" is a ${job.kind} job; manage it with ${KIND_TOOL[job.kind]}.`);
		return job;
	}

	/** Deadline rules shared by add, update and enable: in the future, and at least one run must fit before it. */
	#checkDeadline(schedule: Schedule, endAt: string | undefined, anchor: Date, nowMs: number): string | undefined {
		const first = nextDue(schedule, new Date(nowMs), anchor);
		if (!first) return "schedule: no future run is left (the time is in the past)";
		if (endAt === undefined) return undefined;
		const end = parseIso(endAt);
		if (!end) return "endAt: must be an ISO time with a time zone";
		if (end.getTime() <= nowMs) return "endAt: must be in the future";
		if (first.getTime() >= end.getTime()) return "endAt: no run would happen before this time";
		return undefined;
	}

	add(input: NewJob): Job {
		const nowMs = this.#o.clock.now();
		const id = newJobId();
		const createdAt = iso(nowMs);
		const problem = this.#checkDeadline(input.schedule, input.endAt, new Date(createdAt), nowMs);
		if (problem) throw new JobError(problem);
		const first = nextDue(input.schedule, new Date(nowMs), new Date(createdAt))!;
		const common: JobCommon = {
			id, name: input.name ?? `job-${id.slice(-6).toLowerCase()}`, schedule: input.schedule, enabled: true, createdAt,
			...(input.description ? { description: input.description } : {}),
			...(input.endAt ? { endAt: new Date(input.endAt).toISOString() } : {}),
			...(this.#o.scope() === "session" ? { session: this.#o.sessionId } : {}),
			...(input.missed ? { missed: input.missed } : {}),
			...(input.maxLateMs !== undefined ? { maxLateMs: input.maxLateMs } : {}),
			state: { runCount: 0, nextDue: first.toISOString() },
		};
		const job = this.#validated({ ...common, ...input.body });
		this.#o.store.update((jobs) => {
			if (jobs.some((j) => j.name === job.name && this.visible(j))) throw new JobError(`name: a job named "${job.name}" already exists; choose another name or remove it first`);
			return { jobs: [...jobs, job], result: undefined };
		});
		this.#o.changed();
		return job;
	}

	#validated(raw: unknown): Job {
		try { return validateJob(raw); }
		catch (error) {
			if (error instanceof ValidationError) throw new JobError(error.message);
			throw error;
		}
	}

	remove(id: string, owns: Owns): Job {
		const job = this.get(id, owns);
		const removed = this.#o.store.update((jobs) => (jobs.some((j) => j.id === id) ? { jobs: jobs.filter((j) => j.id !== id), result: true } : { result: false }));
		if (!removed) throw new JobError(`jobId: "${id}" was no longer stored (another session may have removed it); run action "list" to check`);
		this.#o.changed();
		return job;
	}

	/**
	 * Switch a job on or off. Enabling recomputes the next due time from now (a job is never "caught up" for the time it was off).
	 * `expect` runs under the lock so a spec the user confirmed is applied only if nobody changed it meanwhile.
	 */
	setEnabled(id: string, enabled: boolean, owns: Owns, expect?: (current: Job) => boolean): Job {
		this.get(id, owns);
		const nowMs = this.#o.clock.now();
		const updated = this.#o.store.update((jobs) => {
			const index = jobs.findIndex((j) => j.id === id);
			if (index < 0) throw new JobError(`jobId: "${id}" was no longer stored; run action "list" to check`);
			const current = jobs[index];
			if (expect && !expect(current)) throw new JobError("the job changed while waiting for confirmation; nothing was changed. Run action \"list\" to see its current definition, then try again");
			let next: Job = { ...current, enabled } as Job;
			if (enabled) {
				const problem = this.#checkDeadline(current.schedule, current.endAt, new Date(current.createdAt), nowMs);
				if (problem) throw new JobError(problem);
				const { lastError: _gone, ...state } = current.state;
				next = { ...next, state: { ...state, nextDue: nextDue(current.schedule, new Date(nowMs), new Date(current.createdAt))!.toISOString() } } as Job;
			}
			return { jobs: jobs.map((j, i) => (i === index ? next : j)), result: next };
		});
		this.#o.changed();
		return updated;
	}

	update(id: string, patch: JobPatch, owns: Owns, expect?: (current: Job) => boolean): Job {
		this.get(id, owns);
		const nowMs = this.#o.clock.now();
		const updated = this.#o.store.update((jobs) => {
			const index = jobs.findIndex((j) => j.id === id);
			if (index < 0) throw new JobError(`jobId: "${id}" was no longer stored; run action "list" to check`);
			const current = jobs[index];
			if (expect && !expect(current)) throw new JobError("the job changed while waiting for confirmation; nothing was changed. Run action \"list\" to see its current definition, then try again");
			if (patch.name !== undefined && jobs.some((j) => j.id !== id && j.name === patch.name && this.visible(j))) throw new JobError(`name: a job named "${patch.name}" already exists`);
			const merged: Record<string, unknown> = { ...current, ...(patch.body ?? {}) };
			for (const key of ["name", "description", "schedule", "missed", "maxLateMs"] as const) if (patch[key] !== undefined) merged[key] = patch[key];
			if (patch.endAt === null) delete merged.endAt; else if (patch.endAt !== undefined) merged.endAt = new Date(patch.endAt).toISOString();
			const scheduleChanged = patch.schedule !== undefined;
			if (scheduleChanged || patch.endAt !== undefined) {
				const problem = this.#checkDeadline(merged.schedule as Schedule, merged.endAt as string | undefined, new Date(current.createdAt), nowMs);
				if (problem && (current.enabled || scheduleChanged)) throw new JobError(problem);
			}
			if (scheduleChanged) {
				const first = nextDue(patch.schedule!, new Date(nowMs), new Date(current.createdAt));
				merged.state = { ...current.state, ...(first ? { nextDue: first.toISOString() } : {}) };
				if (!first) delete (merged.state as Record<string, unknown>).nextDue;
			}
			const next = this.#validated(merged);
			return { jobs: jobs.map((j, i) => (i === index ? next : j)), result: next };
		});
		this.#o.changed();
		return updated;
	}

	/** Removes this session's visible disabled jobs of the caller's kind; jobs bound to other sessions are never touched. */
	cleanup(owns: Owns): Job[] {
		const removed = this.#o.store.update((jobs) => {
			const gone = jobs.filter((j) => !j.enabled && this.visible(j) && owns(j));
			return gone.length ? { jobs: jobs.filter((j) => !gone.includes(j)), result: gone } : { result: gone };
		});
		if (removed.length) this.#o.changed();
		return removed;
	}
}
