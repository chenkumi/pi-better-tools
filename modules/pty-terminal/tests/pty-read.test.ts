import assert from "node:assert/strict";
import test from "node:test";
import { PtySessionManager } from "../src/pty-manager.ts";
import { compileWaitFor } from "../src/wait-for.ts";

/** Deterministic clock whose timers only fire when the test advances time. */
function fakeClock() {
	let time = 0;
	let nextId = 0;
	const pending = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => time,
		timers: {
			set: (callback: () => void, ms: number) => { const id = ++nextId; pending.set(id, { at: time + ms, callback }); return id; },
			clear: (handle: unknown) => { pending.delete(handle as number); },
		},
		advance(ms: number) {
			const target = time + ms;
			for (;;) {
				const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				pending.delete(due[0]); time = Math.max(time, due[1].at); due[1].callback();
			}
			time = target;
		},
		get timerCount() { return pending.size; },
	};
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(options: ConstructorParameters<typeof PtySessionManager>[0] = {}) {
	const clock = fakeClock();
	let emit!: (data: string) => void;
	const fakePty = {
		pid: 1, write() {}, resize() {}, kill() {},
		onData: (callback: (data: string) => void) => { emit = callback; return { dispose() {} }; },
		onExit: () => ({ dispose() {} }),
	};
	const manager = new PtySessionManager({ now: clock.now, timers: clock.timers, spawnPty: (() => fakePty) as never, matchPattern: async (pattern, input, signal) => { if (signal?.aborted) throw signal.reason; return pattern.test(input); }, ...options });
	const { sessionId } = manager.spawn("fake", [], {}, process.cwd());
	return { manager, clock, sessionId, emit: (data: string) => emit(data) };
}
function track<T>(promise: Promise<T>) {
	const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
	promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
	return state;
}

test("waitFor matches ANSI-stripped output after the bounded retry debounce", async () => {
	const { manager, clock, sessionId, emit } = harness();
	const read = track(manager.readEx(sessionId, { timeoutMs: 10_000, waitFor: compileWaitFor("ready>\\s*$") }));
	await flush(); emit("booting\n"); await flush();
	assert.equal(read.settled, false);
	emit("\x1b[32mready>\x1b[0m "); await flush();
	assert.equal(read.settled, false, "new output coalesces during the retry debounce");
	clock.advance(50); await flush();
	assert.equal(read.settled, true);
	assert.equal(read.value?.wait, "matched");
	assert.match(read.value?.text ?? "", /booting/);
	assert.equal(clock.timerCount, 0);
});

test("waitFor times out on the total limit and reports it; output stays unconsumed until consume()", async () => {
	const { manager, clock, sessionId, emit } = harness();
	const read = track(manager.readEx(sessionId, { timeoutMs: 500, waitFor: /never/ }));
	await flush(); emit("something"); await flush();
	clock.advance(499); await flush(); assert.equal(read.settled, false);
	clock.advance(1); await flush();
	assert.equal(read.value?.wait, "timeout");
	assert.equal(read.value?.text, "something");
	assert.equal((await manager.readEx(sessionId, { timeoutMs: 0 })).text, "something");
	manager.consume(sessionId, read.value!.end);
	assert.equal((await manager.readEx(sessionId, { timeoutMs: 0 })).text, "");
});

test("settleMs waits for quiet, restarts on new output and is bounded by timeoutMs", async () => {
	const { manager, clock, sessionId, emit } = harness();
	const read = track(manager.readEx(sessionId, { timeoutMs: 10_000, settleMs: 200 }));
	await flush(); emit("a"); clock.advance(150); await flush();
	emit("b"); clock.advance(199); await flush(); assert.equal(read.settled, false);
	clock.advance(1); await flush();
	assert.equal(read.value?.text, "ab");
	const bounded = track(manager.readEx(sessionId, { timeoutMs: 300, settleMs: 200 }));
	await flush();
	for (let i = 0; i < 6; i++) { emit("."); clock.advance(100); await flush(); }
	assert.equal(bounded.settled, true);
});

test("abort stops only the wait and keeps the session and its output", async () => {
	const { manager, sessionId, emit } = harness();
	const controller = new AbortController();
	const read = track(manager.readEx(sessionId, { timeoutMs: 10_000, waitFor: /never/, signal: controller.signal }));
	await flush(); emit("keep"); await flush();
	controller.abort(new Error("cancelled")); await flush();
	assert.match(String(read.error), /cancelled/);
	assert.equal((await manager.readEx(sessionId, { timeoutMs: 0 })).text, "keep");
	assert.equal(manager.list().length, 1);
});

test("cursors are monotonic; since re-reads without draining and default read still drains", async () => {
	const { manager, sessionId, emit } = harness();
	emit("hello "); emit("world");
	const first = await manager.readEx(sessionId, { timeoutMs: 0 });
	assert.deepEqual([first.start, first.end, first.text], [0, 11, "hello world"]);
	manager.consume(sessionId, first.end);
	emit("!");
	const again = await manager.readEx(sessionId, { timeoutMs: 0, since: 6 });
	assert.deepEqual([again.start, again.end, again.text], [6, 12, "world!"]);
	const drained = await manager.readEx(sessionId, { timeoutMs: 0 });
	assert.deepEqual([drained.start, drained.text], [11, "!"]);
	assert.equal(manager.list()[0].cursor, 12);
	await assert.rejects(manager.readEx(sessionId, { timeoutMs: 0, since: 99 }), /since must be a cursor between 0 and 12/);
});

test("buffer overflow reports the dropped cursor range; since before the buffer reports its dropped part", async () => {
	const { manager, sessionId, emit } = harness({ maxBufferChars: 10 });
	emit("0123456789"); manager.consume(sessionId, 10);
	emit("abcdefghij"); // overflow drops only already-read output: nothing unread was lost
	assert.equal((await manager.readEx(sessionId, { timeoutMs: 0 })).dropped, undefined);
	emit("KLMNOPQRST"); // now unread "abcdefghij" is lost
	const lost = await manager.readEx(sessionId, { timeoutMs: 0 });
	assert.deepEqual(lost.dropped, { from: 10, to: 20 });
	assert.equal(lost.text, "KLMNOPQRST");
	const old = await manager.readEx(sessionId, { timeoutMs: 0, since: 5 });
	assert.deepEqual(old.dropped, { from: 5, to: 20 });
	assert.match(await manager.read(sessionId, 0), /earlier characters were dropped \(cursor 10-20\)/);
});

test("waitFor regex is validated with actionable errors", () => {
	assert.throws(() => compileWaitFor("("), /Invalid waitFor regular expression.*without slashes/);
	assert.throws(() => compileWaitFor("a".repeat(201)), /too long/);
	assert.throws(() => compileWaitFor(""), /non-empty/);
	assert.throws(() => compileWaitFor("(a+)+$"), /nested quantifiers/);
	assert.ok(compileWaitFor("^\\$ $").test("x\n$ "));
});

test("text format keeps waiting while only an incomplete escape sequence is buffered; raw returns immediately", async () => {
	const { manager, clock, sessionId, emit } = harness();
	const completed = track(manager.readEx(sessionId, { timeoutMs: 1_000, format: "text" }));
	await flush(); emit("\x1b[3"); await flush();
	assert.equal(completed.settled, false);
	emit("2mok"); await flush();
	assert.equal(completed.settled, true);
	assert.equal(completed.value?.text, "\x1b[32mok");
	manager.consume(sessionId, completed.value!.end);

	const stuck = track(manager.readEx(sessionId, { timeoutMs: 300, format: "text" }));
	await flush(); emit("\x1b["); await flush();
	clock.advance(299); await flush();
	assert.equal(stuck.settled, false);
	clock.advance(1); await flush();
	assert.equal(stuck.settled, true); // bounded by timeoutMs; the fragment stays buffered
	assert.equal(stuck.value?.text, "\x1b[");

	const raw = track(manager.readEx(sessionId, { timeoutMs: 300 }));
	await flush();
	assert.equal(raw.settled, true);
	assert.equal(raw.value?.text, "\x1b[");
	assert.equal(clock.timerCount, 0);
});
