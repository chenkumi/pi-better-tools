/**
 * Scheduling engine: one master timer driven by the persisted `nextDue` of this session's jobs.
 *
 * Every state change happens inside the store lock as read-modify-write, so several sessions on the same
 * directory race safely: whoever advances `nextDue` first owns that run. Execution is delegated to an injected
 * executor (P3), time to an injected clock (tests never sleep). Nothing here is an OS scheduler: it only runs
 * while the session is alive, and missed runs are handled when the next session loads the jobs.
 */
import { MAX_TIMER_MS, type Clock } from "./clock.ts";
import { missedRuns, nextDue } from "./schedule.ts";
import { StoreLockUnavailable, type ScheduleStore } from "./storage.ts";
import type { Job, JobKind, JobState, MissedPolicy } from "./types.ts";

export interface EngineSettings {
	defaultMissed: MissedPolicy;
	defaultMaxLateMs: number;
	maxCatchUp: number;
	allowShellRunAll: boolean;
	maxConcurrentAgents: number;
	maxConcurrentCommands: number;
}
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
	defaultMissed: "skip", defaultMaxLateMs: 3_600_000, maxCatchUp: 10, allowShellRunAll: false, maxConcurrentAgents: 4, maxConcurrentCommands: 4,
};

export interface RunOutcome { status: "success" | "error" | "skipped"; error?: string }
/** `missed` is set on catch-up runs: how many due times were missed in total. */
export interface RunInfo { scheduledFor: string; missed?: number }
/** `started` resolves true once the work has begun (a shell spawned, an agent session created), false if it could not. */
export interface RunHandle { started: Promise<boolean>; done: Promise<RunOutcome> }
export type Executor = (job: Job, info: RunInfo) => RunHandle;
export interface EngineEvent { type: "skipped" | "catch-up" | "expired" | "error"; job?: Job; message: string }

export interface EngineOptions {
	store: ScheduleStore;
	clock: Clock;
	sessionId: string;
	settings?: Partial<EngineSettings>;
	execute: Executor;
	onEvent?: (event: EngineEvent) => void;
	/** Called after the stored jobs changed (state advanced, run finished, job disabled). */
	onChange?: () => void;
}

/** A timer that fires this much later than planned is a missed run (system sleep), not an on-time run. */
export const LATE_GRACE_MS = 5000;
/** Jobs due within this window of each other form one batch and run in kind order. */
export const SAME_TIME_WINDOW_MS = 1000;
export const START_WAIT_MS = 2000;
const END_CHECK_MS = 60_000;
const RETRY_LOCK_MS = 1000;
const RETRY_READ_MS = 5000;

const KIND_ORDER: Record<JobKind, number> = { shell: 0, agent: 1, monitor: 2, prompt: 3 };
const iso = (ms: number) => new Date(ms).toISOString();

interface PlannedRun { job: Job; infos: RunInfo[] }
interface Plan { job: Job; run?: PlannedRun; events: EngineEvent[] }
interface Budget { agent: number; shell: number }

function advance(job: Job, nowMs: number, patch: Partial<JobState>): Job {
	const state: JobState = { ...job.state, ...patch };
	delete state.nextDue;
	const next = nextDue(job.schedule, new Date(nowMs), new Date(job.createdAt));
	const endMs = job.endAt ? Date.parse(job.endAt) : Infinity;
	if (!next || next.getTime() >= endMs) return { ...job, enabled: false, state } as Job;
	return { ...job, state: { ...state, nextDue: next.toISOString() } } as Job;
}

function policyOf(job: Job, settings: EngineSettings): MissedPolicy {
	const base = job.missed ?? (job.kind === "monitor" ? "skip" : settings.defaultMissed);
	return job.kind === "shell" && base === "run-all" && !settings.allowShellRunAll ? "run-once" : base;
}

/** Decide what happens to one job at `nowMs`: nothing, a first arm, a run, or a skipped/expired record. */
function planJob(job: Job, nowMs: number, running: ReadonlyMap<string, JobKind>, budget: Budget, settings: EngineSettings): Plan {
	const none: Plan = { job, events: [] };
	if (!job.enabled) return none;
	const endMs = job.endAt ? Date.parse(job.endAt) : Infinity;
	if (nowMs >= endMs) {
		const { nextDue: _gone, ...state } = job.state;
		return { job: { ...job, enabled: false, state } as Job, events: [{ type: "expired", job, message: `job ${job.name} ended (endAt reached)` }] };
	}
	if (!job.state.nextDue) return { job: advance(job, nowMs, {}), events: [] };
	const due = Date.parse(job.state.nextDue);
	if (due > nowMs) return none;

	const anchor = new Date(job.createdAt);
	const events: EngineEvent[] = [];
	let dates: number[];
	let missed: number | undefined;
	let policy: MissedPolicy | undefined;
	if (nowMs - due <= LATE_GRACE_MS) {
		dates = [due];
	} else {
		policy = policyOf(job, settings);
		const total = missedRuns(job.schedule, new Date(due - 1), new Date(nowMs), anchor);
		missed = total.dates.length;
		if (policy === "skip") dates = [];
		else {
			const windowStart = Math.max(due - 1, nowMs - (job.maxLateMs ?? settings.defaultMaxLateMs) - 1);
			const eligible = missedRuns(job.schedule, new Date(windowStart), new Date(nowMs), anchor).dates.map((d) => d.getTime()).filter((t) => t < endMs);
			dates = policy === "run-once" ? eligible.slice(-1) : eligible.slice(0, settings.maxCatchUp);
		}
	}

	if (dates.length === 0) {
		const message = `missed ${missed} run(s); not caught up (missed policy ${policy})`;
		events.push({ type: "skipped", job, message });
		return { job: advance(job, nowMs, { lastStatus: "skipped", lastError: message }), events };
	}
	const blocked = running.has(job.id) ? "previous run is still running"
		: job.kind === "agent" && budget.agent <= 0 ? "too many agent jobs are running"
		: job.kind === "shell" && budget.shell <= 0 ? "too many shell jobs are running" : undefined;
	if (blocked) {
		events.push({ type: "skipped", job, message: blocked });
		return { job: advance(job, nowMs, { lastStatus: "skipped", lastError: blocked }), events };
	}
	if (job.kind === "agent") budget.agent--;
	if (job.kind === "shell") budget.shell--;
	if (missed !== undefined) events.push({ type: "catch-up", job, message: `catch-up (missed ${missed})` });
	const infos = dates.map((t): RunInfo => ({ scheduledFor: iso(t), ...(missed !== undefined ? { missed } : {}) }));
	const { lastError: _cleared, ...state } = job.state;
	const next = advance({ ...job, state } as Job, nowMs, { lastStatus: "running", lastRun: iso(nowMs) });
	return { job: next, run: { job: next, infos }, events };
}

export class ScheduleEngine {
	readonly #o: EngineOptions;
	readonly #settings: EngineSettings;
	readonly #running = new Map<string, JobKind>();
	#generation = 0;
	#timer: unknown;
	#endTimer: unknown;

	constructor(options: EngineOptions) {
		this.#o = options;
		this.#settings = { ...DEFAULT_ENGINE_SETTINGS, ...options.settings };
	}

	get runningJobs(): ReadonlyMap<string, JobKind> { return this.#running; }

	#owned = (job: Job) => job.session === undefined || job.session === this.#o.sessionId;
	#emit = (event: EngineEvent) => this.#o.onEvent?.(event);

	/** Load: settle everything that became due while no session was running, then arm. Call once per session start. */
	async start(): Promise<void> {
		const generation = ++this.#generation;
		this.#clearTimers();
		await this.#run(generation, "load");
	}

	/** Cancel timers and ignore every pending continuation; running work is not stopped by this. */
	stop(): void {
		this.#generation++;
		this.#clearTimers();
	}

	/** Re-read the store and re-arm; call after jobs were added, changed or removed. */
	reload(): void {
		this.#arm(this.#generation);
	}

	#clearTimers() {
		if (this.#timer !== undefined) this.#o.clock.clearTimeout(this.#timer);
		if (this.#endTimer !== undefined) this.#o.clock.clearTimeout(this.#endTimer);
		this.#timer = this.#endTimer = undefined;
	}

	/** Claim due work under the lock, then dispatch it outside the lock. */
	async #run(generation: number, mode: "load" | "tick"): Promise<void> {
		let claimed: { runs: PlannedRun[]; events: EngineEvent[] };
		try {
			claimed = this.#claim(this.#o.clock.now(), mode);
		} catch (error) {
			if (generation !== this.#generation) return;
			const locked = error instanceof StoreLockUnavailable;
			this.#emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			this.#timer = this.#o.clock.setTimeout(() => { if (generation === this.#generation) void this.#run(generation, mode); }, locked ? RETRY_LOCK_MS : RETRY_READ_MS);
			return;
		}
		if (generation !== this.#generation) return;
		for (const event of claimed.events) this.#emit(event);
		this.#arm(generation);
		if (claimed.events.length || claimed.runs.length) this.#o.onChange?.();
		await this.#dispatch(claimed.runs, generation);
	}

	#claim(now: number, mode: "load" | "tick"): { runs: PlannedRun[]; events: EngineEvent[] } {
		const count = (kind: JobKind) => [...this.#running.values()].filter((k) => k === kind).length;
		const budget: Budget = { agent: this.#settings.maxConcurrentAgents - count("agent"), shell: this.#settings.maxConcurrentCommands - count("shell") };
		return this.#o.store.update((jobs) => {
			const mine = jobs.filter((j) => this.#owned(j) && j.enabled);
			let at = now;
			let batch: Set<Job>;
			if (mode === "load") batch = new Set(mine);
			else {
				const due = mine.filter((j) => j.state.nextDue !== undefined && Date.parse(j.state.nextDue) <= now);
				if (due.length === 0) return { result: { runs: [], events: [] } };
				const windowEnd = Math.min(...due.map((j) => Date.parse(j.state.nextDue!))) + SAME_TIME_WINDOW_MS;
				batch = new Set(mine.filter((j) => j.state.nextDue !== undefined && Date.parse(j.state.nextDue) <= windowEnd));
				at = Math.max(now, ...[...batch].map((j) => Date.parse(j.state.nextDue!)));
			}
			const runs: PlannedRun[] = [], events: EngineEvent[] = [];
			let changed = false;
			const next = jobs.map((job) => {
				// A run that was in flight when its session died can never report back; only the owning session may say so.
				let current = job;
				if (mode === "load" && job.session === this.#o.sessionId && job.state.lastStatus === "running" && !this.#running.has(job.id)) {
					current = { ...job, state: { ...job.state, lastStatus: "error", lastError: "interrupted before it finished" } } as Job;
					changed = true;
				}
				if (!batch.has(job)) return current;
				const plan = planJob(current, at, this.#running, budget, this.#settings);
				if (plan.job !== current) changed = true;
				if (plan.run) runs.push(plan.run);
				events.push(...plan.events);
				return plan.job;
			});
			return { jobs: changed ? next : undefined, result: { runs, events } };
		});
	}

	async #dispatch(runs: PlannedRun[], generation: number): Promise<void> {
		runs.sort((a, b) => {
			const ta = Math.floor(Date.parse(a.infos[0].scheduledFor) / 1000), tb = Math.floor(Date.parse(b.infos[0].scheduledFor) / 1000);
			return ta - tb || KIND_ORDER[a.job.kind] - KIND_ORDER[b.job.kind] || a.job.createdAt.localeCompare(b.job.createdAt) || a.job.id.localeCompare(b.job.id);
		});
		const started: Promise<boolean>[] = [];
		let waited = false;
		for (const run of runs) {
			// "Shell first" means spawned, not finished: a prompt waits briefly for the earlier starts, never for their completion.
			if (run.job.kind === "prompt" && !waited && started.length) {
				waited = true;
				await this.#startedOrTimeout(started);
				if (generation !== this.#generation) return;
			}
			started.push(this.#launch(run, generation));
		}
	}

	#startedOrTimeout(list: Promise<boolean>[]): Promise<void> {
		return new Promise((resolve) => {
			const handle = this.#o.clock.setTimeout(resolve, START_WAIT_MS);
			void Promise.all(list).then(() => { this.#o.clock.clearTimeout(handle); resolve(); });
		});
	}

	#launch({ job, infos }: PlannedRun, generation: number): Promise<boolean> {
		this.#running.set(job.id, job.kind);
		let resolveStarted!: (value: boolean) => void;
		const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });
		void (async () => {
			let first = true;
			try {
				for (const info of infos) {
					let handle: RunHandle;
					try { handle = this.#o.execute(job, info); }
					catch (error) { handle = { started: Promise.resolve(false), done: Promise.resolve({ status: "error", error: error instanceof Error ? error.message : String(error) }) }; }
					if (first) { first = false; handle.started.then(resolveStarted, () => resolveStarted(false)); }
					const outcome = await handle.done.catch((error): RunOutcome => ({ status: "error", error: error instanceof Error ? error.message : String(error) }));
					this.#record(job.id, outcome, generation);
					if (generation !== this.#generation) break;
				}
			} finally {
				resolveStarted(false);
				this.#running.delete(job.id);
			}
		})();
		return started;
	}

	#record(id: string, outcome: RunOutcome, generation: number): void {
		if (generation !== this.#generation) return;
		try {
			this.#o.store.update((jobs) => {
				const index = jobs.findIndex((j) => j.id === id);
				if (index < 0) return { result: undefined };
				const job = jobs[index];
				const { lastError: _old, ...state } = job.state;
				const patched = { ...job, state: { ...state, lastStatus: outcome.status, runCount: job.state.runCount + (outcome.status === "skipped" ? 0 : 1), ...(outcome.error ? { lastError: outcome.error } : {}) } } as Job;
				return { jobs: jobs.map((j, i) => (i === index ? patched : j)), result: undefined };
			});
			this.#o.onChange?.();
		} catch (error) {
			this.#emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}

	#arm(generation: number): void {
		if (generation !== this.#generation) return;
		this.#clearTimers();
		const clock = this.#o.clock;
		let mine: Job[];
		try { mine = this.#o.store.read().store.jobs.filter((j) => this.#owned(j) && j.enabled); }
		catch (error) {
			this.#emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			this.#timer = clock.setTimeout(() => this.#arm(generation), RETRY_READ_MS);
			return;
		}
		const dues = mine.flatMap((j) => (j.state.nextDue ? [Date.parse(j.state.nextDue)] : []));
		if (dues.length) {
			const target = Math.min(...dues);
			this.#timer = clock.setTimeout(() => {
				if (generation !== this.#generation) return;
				// Timers longer than MAX_TIMER_MS are cut short by the clock; arrive here early and wait again.
				if (clock.now() < target) this.#arm(generation);
				else void this.#run(generation, "tick");
			}, Math.min(Math.max(0, target - clock.now()), MAX_TIMER_MS));
		}
		const ends = mine.flatMap((j) => (j.endAt ? [Date.parse(j.endAt)] : []));
		if (ends.length) {
			this.#endTimer = clock.setTimeout(() => {
				if (generation !== this.#generation) return;
				this.#expire(generation);
			}, Math.min(END_CHECK_MS, Math.max(0, Math.min(...ends) - clock.now())));
		}
	}

	/** Independent end-of-life check so an ended job is switched off even if its own timer is far in the future. */
	#expire(generation: number): void {
		const now = this.#o.clock.now();
		try {
			const events = this.#o.store.update((jobs) => {
				const events: EngineEvent[] = [];
				const next = jobs.map((job) => {
					if (!this.#owned(job) || !job.enabled || !job.endAt || Date.parse(job.endAt) > now) return job;
					const { nextDue: _gone, ...state } = job.state;
					events.push({ type: "expired", job, message: `job ${job.name} ended (endAt reached)` });
					return { ...job, enabled: false, state } as Job;
				});
				return { jobs: events.length ? next : undefined, result: events };
			});
			for (const event of events) this.#emit(event);
			if (events.length) this.#o.onChange?.();
		} catch (error) {
			this.#emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}
		this.#arm(generation);
	}
}
