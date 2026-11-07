import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/clock.ts";
import type { Executor, RunInfo, RunOutcome } from "../src/engine.ts";
import { newJobId, ScheduleStore } from "../src/storage.ts";
import type { Job } from "../src/types.ts";
import { validateJob } from "../src/validate.ts";

export const T0 = Date.parse("2030-01-01T00:00:00Z");

export function workspace() {
	const cwd = mkdtempSync(join(tmpdir(), "sc-engine-"));
	mkdirSync(join(cwd, ".pi"));
	return { cwd, store: new ScheduleStore(cwd), done: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** A clock that only moves when the test says so; timers fire in order and every continuation settles in between. */
export class ManualClock implements Clock {
	#now: number;
	#timers: Array<{ at: number; fn: () => void; id: number }> = [];
	#next = 1;
	delays: number[] = [];
	constructor(start = T0) { this.#now = start; }
	now() { return this.#now; }
	setTimeout(fn: () => void, ms: number) {
		this.delays.push(ms);
		const id = this.#next++;
		this.#timers.push({ at: this.#now + ms, fn, id });
		return id;
	}
	clearTimeout(handle: unknown) { this.#timers = this.#timers.filter((t) => t.id !== handle); }
	get pending() { return this.#timers.length; }
	async settle() { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
	async advance(ms: number) {
		const target = this.#now + ms;
		for (;;) {
			const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!due) break;
			this.#timers = this.#timers.filter((t) => t !== due);
			this.#now = Math.max(this.#now, due.at);
			due.fn();
			await this.settle();
		}
		this.#now = target;
		await this.settle();
	}
}

export interface Call { job: Job; info: RunInfo; finish: (outcome?: RunOutcome) => void; startOk: (ok?: boolean) => void }

/** Executor double. `autoStart` resolves `started` immediately; `autoFinish` also completes the run. */
export function fakeExecutor(options: { autoStart?: boolean; autoFinish?: boolean } = {}) {
	const calls: Call[] = [];
	const execute: Executor = (job, info) => {
		let startOk!: (ok?: boolean) => void, finish!: (outcome?: RunOutcome) => void;
		const started = new Promise<boolean>((resolve) => { startOk = (ok = true) => resolve(ok); });
		const done = new Promise<RunOutcome>((resolve) => { finish = (outcome = { status: "success" }) => resolve(outcome); });
		const call: Call = { job, info, finish, startOk };
		calls.push(call);
		if (options.autoStart !== false) startOk();
		if (options.autoFinish) finish();
		return { started, done };
	};
	return { calls, execute };
}

const defaults = { enabled: true, createdAt: "2029-12-01T00:00:00Z", state: { runCount: 0 }, schedule: { type: "interval", everyMs: 3_600_000 } };
export function makeJob(over: Record<string, unknown> = {}): Job {
	return validateJob({ id: newJobId(), name: "job", ...(over.kind ? {} : { kind: "prompt", prompt: "hi" }), ...defaults, ...over });
}
export const put = (store: ScheduleStore, ...jobs: Job[]) => store.update((existing) => ({ jobs: [...existing, ...jobs], result: undefined }));
export const get = (store: ScheduleStore, id: string): Job => store.read().store.jobs.find((j) => j.id === id)!;
export const iso = (ms: number) => new Date(ms).toISOString();
