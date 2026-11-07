import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MAX_TIMER_MS } from "../src/clock.ts";
import { ScheduleEngine, type EngineEvent, type EngineSettings } from "../src/engine.ts";
import { fakeExecutor, get, iso, makeJob, ManualClock, put, T0, workspace } from "./helpers.ts";

const HOUR = 3_600_000;

function setup(settings: Partial<EngineSettings> = {}, sessionId = "S1", exec = fakeExecutor({ autoFinish: true })) {
	const w = workspace();
	const clock = new ManualClock();
	const events: EngineEvent[] = [];
	const engine = new ScheduleEngine({ store: w.store, clock, sessionId, settings, execute: exec.execute, onEvent: (e) => events.push(e) });
	return { ...w, clock, events, engine, exec, sessionId };
}

test("load arms a job that has never run: nextDue is persisted, nothing runs", async () => {
	const s = setup();
	try {
		const job = makeJob();
		put(s.store, job);
		await s.engine.start();
		assert.equal(get(s.store, job.id).state.nextDue, iso(T0 + HOUR));
		assert.equal(s.exec.calls.length, 0);
	} finally { s.engine.stop(); s.done(); }
});

test("an on-time tick runs the job once, advances nextDue and records the outcome", async () => {
	const s = setup();
	try {
		const job = makeJob({ state: { runCount: 0, nextDue: iso(T0 + 60_000) }, schedule: { type: "interval", everyMs: 60_000 } });
		put(s.store, job);
		await s.engine.start();
		await s.clock.advance(60_000);
		assert.equal(s.exec.calls.length, 1);
		assert.equal(s.exec.calls[0].info.missed, undefined);
		const after = get(s.store, job.id);
		assert.equal(after.state.nextDue, iso(T0 + 120_000));
		assert.equal(after.state.lastStatus, "success");
		assert.equal(after.state.runCount, 1);
		await s.clock.advance(60_000);
		assert.equal(s.exec.calls.length, 2, "it keeps going");
	} finally { s.engine.stop(); s.done(); }
});

test("missed policy skip (default): nothing runs and nextDue moves to the future", async () => {
	const s = setup();
	try {
		const job = makeJob({ state: { runCount: 0, nextDue: iso(T0 - 3 * HOUR) } });
		put(s.store, job);
		await s.engine.start();
		assert.equal(s.exec.calls.length, 0);
		const after = get(s.store, job.id);
		assert.equal(after.state.lastStatus, "skipped");
		assert.match(after.state.lastError!, /missed 4 run\(s\); not caught up \(missed policy skip\)/);
		assert.ok(Date.parse(after.state.nextDue!) > T0);
		assert.equal(s.events[0].type, "skipped");
	} finally { s.engine.stop(); s.done(); }
});

test("run-once catches up once with the missed count, but only inside maxLateMs", async () => {
	const s = setup();
	try {
		const recent = makeJob({ name: "recent", missed: "run-once", state: { runCount: 0, nextDue: iso(T0 - 2 * HOUR) }, maxLateMs: 90 * 60_000 });
		const stale = makeJob({ name: "stale", missed: "run-once", state: { runCount: 0, nextDue: iso(T0 - 5 * HOUR) }, maxLateMs: 30 * 60_000 });
		put(s.store, recent, stale);
		await s.clock.advance(40 * 60_000); // the hourly run at T0 is now 40 minutes late
		await s.engine.start();
		assert.equal(s.exec.calls.length, 1);
		assert.equal(s.exec.calls[0].job.id, recent.id);
		assert.equal(s.exec.calls[0].info.missed, 3);
		assert.equal(s.exec.calls[0].info.scheduledFor, iso(T0));
		assert.equal(get(s.store, stale.id).state.lastStatus, "skipped");
		assert.ok(s.events.some((e) => e.type === "catch-up" && e.message === "catch-up (missed 3)"));
	} finally { s.engine.stop(); s.done(); }
});

test("run-all runs missed times oldest first, one after another, capped by maxCatchUp", async () => {
	const exec = fakeExecutor();
	const s = setup({ maxCatchUp: 3 }, "S1", exec);
	try {
		const job = makeJob({ missed: "run-all", maxLateMs: 24 * HOUR, state: { runCount: 0, nextDue: iso(T0 - 5 * HOUR) } });
		put(s.store, job);
		await s.engine.start();
		await s.clock.settle();
		assert.equal(exec.calls.length, 1, "the next catch-up waits for the previous one");
		assert.equal(exec.calls[0].info.scheduledFor, iso(T0 - 5 * HOUR));
		assert.equal(exec.calls[0].info.missed, 6);
		exec.calls[0].finish(); await s.clock.settle();
		exec.calls[1].finish(); await s.clock.settle();
		exec.calls[2].finish(); await s.clock.settle();
		assert.deepEqual(exec.calls.map((c) => c.info.scheduledFor), [iso(T0 - 5 * HOUR), iso(T0 - 4 * HOUR), iso(T0 - 3 * HOUR)]);
		assert.equal(exec.calls.length, 3, "the rest is dropped");
		assert.equal(get(s.store, job.id).state.runCount, 3);
	} finally { s.engine.stop(); s.done(); }
});

test("shell run-all is downgraded to run-once unless allowShellRunAll is set", async () => {
	for (const [allow, expected] of [[false, 1], [true, 4]] as const) {
		const exec = fakeExecutor({ autoFinish: true });
		const s = setup({ allowShellRunAll: allow }, "S1", exec);
		try {
			put(s.store, makeJob({ kind: "shell", command: "echo", missed: "run-all", maxLateMs: 24 * HOUR, state: { runCount: 0, nextDue: iso(T0 - 3 * HOUR) } }));
			await s.engine.start();
			await s.clock.settle();
			assert.equal(exec.calls.length, expected, `allowShellRunAll=${allow}`);
		} finally { s.engine.stop(); s.done(); }
	}
});

test("monitor jobs default to skip even when the setting says run-once", async () => {
	const s = setup({ defaultMissed: "run-once" });
	try {
		put(s.store, makeJob({ kind: "monitor", start: { source: { kind: "system" } }, state: { runCount: 0, nextDue: iso(T0 - 2 * HOUR) } }));
		await s.engine.start();
		assert.equal(s.exec.calls.length, 0);
	} finally { s.engine.stop(); s.done(); }
});

test("once: runs and is switched off; a missed once outside the window is skipped and switched off", async () => {
	const s = setup();
	try {
		const soon = makeJob({ name: "soon", schedule: { type: "once", at: iso(T0 + 60_000) }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } });
		const gone = makeJob({ name: "gone", schedule: { type: "once", at: iso(T0 - 5 * HOUR) }, missed: "run-once", maxLateMs: HOUR, state: { runCount: 0, nextDue: iso(T0 - 5 * HOUR) } });
		put(s.store, soon, gone);
		await s.engine.start();
		assert.equal(get(s.store, gone.id).enabled, false);
		assert.equal(get(s.store, gone.id).state.lastStatus, "skipped");
		await s.clock.advance(60_000);
		assert.equal(s.exec.calls.length, 1);
		assert.equal(get(s.store, soon.id).enabled, false);
		assert.equal(get(s.store, soon.id).state.nextDue, undefined);
		assert.equal(get(s.store, soon.id).state.lastStatus, "success");
	} finally { s.engine.stop(); s.done(); }
});

test("endAt: a run due after endAt never happens and the job is switched off; the end check works on its own", async () => {
	const s = setup();
	try {
		const job = makeJob({ endAt: iso(T0 + 150_000), schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } });
		put(s.store, job);
		await s.engine.start();
		await s.clock.advance(60_000);
		await s.clock.advance(60_000);
		assert.equal(s.exec.calls.length, 2);
		assert.equal(get(s.store, job.id).enabled, false, "the next due time (T0+180s) is past endAt");
		const long = makeJob({ name: "long", endAt: iso(T0 + 10 * 60_000), schedule: { type: "interval", everyMs: 3 * HOUR }, state: { runCount: 0, nextDue: iso(T0 + 3 * HOUR) } });
		put(s.store, long);
		s.engine.reload();
		await s.clock.advance(10 * 60_000);
		assert.equal(get(s.store, long.id).enabled, false);
		assert.ok(s.events.some((e) => e.type === "expired" && e.job?.name === "long"));
	} finally { s.engine.stop(); s.done(); }
});

test("jobs due at the same time run shell, agent, monitor, prompt; the prompt waits for the shell to start", async () => {
	const exec = fakeExecutor({ autoStart: false });
	const s = setup({}, "S1", exec);
	try {
		const due = { state: { runCount: 0, nextDue: iso(T0 + 60_000) } };
		put(s.store,
			makeJob({ name: "p", ...due }),
			makeJob({ name: "m", kind: "monitor", start: { source: { kind: "system" } }, ...due }),
			makeJob({ name: "a", kind: "agent", prompt: "x", model: "m", ...due }),
			makeJob({ name: "s", kind: "shell", command: "echo", state: { runCount: 0, nextDue: iso(T0 + 60_500) } }));
		await s.engine.start();
		await s.clock.advance(60_000);
		assert.deepEqual(exec.calls.map((c) => c.job.name), ["s", "a", "m"], "the prompt is held back until the earlier jobs started");
		exec.calls[0].startOk(); exec.calls[1].startOk(); exec.calls[2].startOk();
		await s.clock.settle();
		assert.deepEqual(exec.calls.map((c) => c.job.name), ["s", "a", "m", "p"]);
	} finally { s.engine.stop(); s.done(); }
});

test("a prompt waits at most 2 seconds for a shell that never reports started", async () => {
	const exec = fakeExecutor({ autoStart: false });
	const s = setup({}, "S1", exec);
	try {
		const due = { state: { runCount: 0, nextDue: iso(T0 + 60_000) } };
		put(s.store, makeJob({ name: "p", ...due }), makeJob({ name: "s", kind: "shell", command: "echo", ...due }));
		await s.engine.start();
		await s.clock.advance(60_000);
		assert.deepEqual(exec.calls.map((c) => c.job.name), ["s"]);
		await s.clock.advance(1_999);
		assert.equal(exec.calls.length, 1);
		await s.clock.advance(1);
		assert.deepEqual(exec.calls.map((c) => c.job.name), ["s", "p"]);
	} finally { s.engine.stop(); s.done(); }
});

test("a job whose previous run is still going is skipped, and the shell concurrency limit is enforced", async () => {
	const exec = fakeExecutor();
	const s = setup({ maxConcurrentCommands: 1 }, "S1", exec);
	try {
		const slow = makeJob({ name: "slow", schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } });
		const a = makeJob({ name: "a", kind: "shell", command: "x", schedule: { type: "interval", everyMs: 3 * HOUR }, state: { runCount: 0, nextDue: iso(T0 + 3 * HOUR) } });
		const b = makeJob({ name: "b", kind: "shell", command: "y", schedule: { type: "interval", everyMs: 3 * HOUR }, state: { runCount: 0, nextDue: iso(T0 + 3 * HOUR) } });
		put(s.store, slow, a, b);
		await s.engine.start();
		await s.clock.advance(60_000);
		await s.clock.advance(60_000);
		assert.equal(exec.calls.filter((c) => c.job.name === "slow").length, 1);
		assert.match(get(s.store, slow.id).state.lastError ?? "", /previous run is still running/);
		await s.clock.advance(3 * HOUR - 120_000);
		const shells = exec.calls.filter((c) => c.job.kind === "shell");
		assert.equal(shells.length, 1);
		const skipped = [a, b].map((j) => get(s.store, j.id)).filter((j) => j.state.lastStatus === "skipped");
		assert.equal(skipped.length, 1);
		assert.match(skipped[0].state.lastError!, /too many shell jobs/);
	} finally { s.engine.stop(); s.done(); }
});

test("two sessions on the same directory: exactly one runs a shared job", async () => {
	const w = workspace();
	const clock = new ManualClock();
	const exec = fakeExecutor({ autoFinish: true });
	const make = (id: string) => new ScheduleEngine({ store: w.store, clock, sessionId: id, execute: exec.execute });
	const a = make("A"), b = make("B");
	try {
		put(w.store, makeJob({ schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } }));
		await a.start(); await b.start();
		await clock.advance(60_000);
		assert.equal(exec.calls.length, 1);
		await clock.advance(60_000);
		assert.equal(exec.calls.length, 2);
	} finally { a.stop(); b.stop(); w.done(); }
});

test("a job bound to another session is left alone", async () => {
	const s = setup();
	try {
		const theirs = makeJob({ session: "OTHER", schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 - 5 * 60_000) } });
		put(s.store, theirs);
		await s.engine.start();
		await s.clock.advance(5 * 60_000);
		assert.equal(s.exec.calls.length, 0);
		assert.deepEqual(get(s.store, theirs.id), theirs);
	} finally { s.engine.stop(); s.done(); }
});

test("stop() cancels everything: no run after stop, and a later start works", async () => {
	const s = setup();
	try {
		put(s.store, makeJob({ schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } }));
		await s.engine.start();
		s.engine.stop();
		assert.equal(s.clock.pending, 0);
		await s.clock.advance(5 * 60_000);
		assert.equal(s.exec.calls.length, 0);
		await s.engine.start();
		await s.clock.advance(60_000);
		assert.ok(s.exec.calls.length >= 1);
	} finally { s.engine.stop(); s.done(); }
});

test("a run left 'running' by a dead session is marked interrupted, but only by the owning session", async () => {
	const s = setup();
	try {
		const mine = makeJob({ name: "mine", session: "S1", state: { runCount: 0, lastStatus: "running", nextDue: iso(T0 + HOUR) } });
		const shared = makeJob({ name: "shared", state: { runCount: 0, lastStatus: "running", nextDue: iso(T0 + HOUR) } });
		put(s.store, mine, shared);
		await s.engine.start();
		assert.equal(get(s.store, mine.id).state.lastStatus, "error");
		assert.match(get(s.store, mine.id).state.lastError!, /interrupted/);
		assert.equal(get(s.store, shared.id).state.lastStatus, "running");
	} finally { s.engine.stop(); s.done(); }
});

test("an interval longer than the timer limit is armed in pieces and does not fire early", async () => {
	const s = setup();
	try {
		const job = makeJob({ schedule: { type: "interval", everyMs: 90 * 24 * HOUR } });
		put(s.store, job);
		await s.engine.start();
		assert.ok(s.clock.delays.every((d) => d <= MAX_TIMER_MS), "no single wait exceeds what a timer accepts");
		const due = Date.parse(get(s.store, job.id).state.nextDue!);
		await s.clock.advance(due - T0 - 1);
		assert.equal(s.exec.calls.length, 0);
		await s.clock.advance(1);
		assert.equal(s.exec.calls.length, 1);
	} finally { s.engine.stop(); s.done(); }
});

test("a locked store at tick time is retried, not lost", async () => {
	const previous = process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS;
	process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS = "0";
	const s = setup();
	try {
		put(s.store, makeJob({ schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } }));
		await s.engine.start();
		const lock = join(s.cwd, ".pi", "schedule-commands.lock");
		mkdirSync(lock);
		await s.clock.advance(60_000);
		assert.equal(s.exec.calls.length, 0);
		assert.ok(s.events.some((e) => e.type === "error" && /locked/.test(e.message)));
		rmSync(lock, { recursive: true });
		await s.clock.advance(1_000);
		assert.equal(s.exec.calls.length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS; else process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS = previous;
		s.engine.stop(); s.done();
	}
});

test("a failing executor is recorded as an error and does not stop the engine", async () => {
	const exec = fakeExecutor();
	const s = setup({}, "S1", { ...exec, execute: (job, info) => { if (job.name === "bad") throw new Error("boom"); return exec.execute(job, info); } });
	try {
		const due = { schedule: { type: "interval", everyMs: 60_000 }, state: { runCount: 0, nextDue: iso(T0 + 60_000) } };
		const bad = makeJob({ name: "bad", ...due }), ok = makeJob({ name: "ok", ...due });
		put(s.store, bad, ok);
		await s.engine.start();
		await s.clock.advance(60_000);
		assert.equal(get(s.store, bad.id).state.lastStatus, "error");
		assert.equal(get(s.store, bad.id).state.lastError, "boom");
		assert.equal(exec.calls.length, 1);
	} finally { s.engine.stop(); s.done(); }
});
