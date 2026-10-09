import assert from "node:assert/strict";
import test from "node:test";
import { PtySessionManager } from "../src/pty-manager.ts";

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

interface FakeHandle { emit(data: string): void; exit(code?: number): void; writes: string[] }
function harness(options: ConstructorParameters<typeof PtySessionManager>[0] = {}) {
	const clock = fakeClock();
	const handles: FakeHandle[] = [];
	const spawnPty = (() => {
		let dataCb: (data: string) => void = () => {};
		let exitCb: (event: { exitCode: number; signal?: number }) => void = () => {};
		const writes: string[] = [];
		handles.push({ emit: data => dataCb(data), exit: (code = 0) => exitCb({ exitCode: code }), writes });
		return {
			pid: handles.length, write(data: string) { writes.push(data); }, resize() {}, kill() {},
			onData: (callback: (data: string) => void) => { dataCb = callback; return { dispose() {} }; },
			onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => { exitCb = callback; return { dispose() {} }; },
		};
	}) as never;
	const manager = new PtySessionManager({ now: clock.now, timers: clock.timers, spawnPty, ...options });
	const open = () => manager.spawn("fake", [], {}, process.cwd()).sessionId;
	return { manager, clock, handles, open };
}

test("waitFor debounces re-matching when output keeps arriving during a failed match", async () => {
	let release!: (matched: boolean) => void;
	let calls = 0;
	const { manager, clock, handles, open } = harness({
		matchPattern: async (pattern, input) => ++calls === 1 ? new Promise<boolean>(resolve => { release = resolve; }) : pattern.test(input),
	});
	const sessionId = open();
	const read = manager.readEx(sessionId, { timeoutMs: 10_000, waitFor: /READY/ });
	await flush();
	handles[0].emit("busy"); release(false); await flush();
	assert.equal(calls, 1, "no second worker before the debounce interval");
	clock.advance(49); await flush();
	assert.equal(calls, 1);
	handles[0].emit("READY"); clock.advance(1); await flush();
	assert.equal((await read).wait, "matched");
	assert.equal(calls, 2, "one re-match covers all output that arrived during the debounce");
});

test("pty_write to an exited session fails with a clear error", async () => {
	const { manager, handles, open } = harness();
	const sessionId = open();
	manager.write(sessionId, "ok");
	handles[0].emit("final output"); handles[0].exit(3);
	assert.throws(() => manager.write(sessionId, "x"), /has exited \(exitCode 3\); input was not sent/);
	assert.deepEqual(handles[0].writes, ["ok"], "rejected input never reaches the backend");
	assert.equal((await manager.readEx(sessionId, { timeoutMs: 0 })).text, "final output");
});

test("pause is cut short when the process exits", async () => {
	const { manager, handles, open } = harness();
	const sessionId = open();
	let done = false;
	const paused = manager.pause(sessionId, 30_000).then(() => { done = true; });
	await flush(); assert.equal(done, false);
	handles[0].exit(0); await paused;
	assert.equal(done, true);
});

test("a full session table evicts fully-read exited sessions before exited sessions with unread output", async () => {
	const { manager, handles, open } = harness({ maxSessions: 2 });
	const unread = open();
	const read = open();
	handles[0].emit("important unread output"); handles[0].exit();
	handles[1].emit("seen"); handles[1].exit();
	await manager.read(read, 0);
	const fresh = open();
	const ids = manager.list().map(session => session.sessionId);
	assert.ok(ids.includes(unread), "exited session with unread output is retained");
	assert.ok(!ids.includes(read), "fully-read exited session is evicted first");
	assert.ok(ids.includes(fresh));
});

test("batched ring-buffer trimming keeps the maximum, cursor arithmetic and newest output", async () => {
	const max = 128 * 1024;
	const { manager, handles, open } = harness({ maxBufferChars: max });
	const sessionId = open();
	let total = 0;
	for (let i = 0; i < 40; i++) { const chunk = `${i}:`.padEnd(8 * 1024, "x"); total += chunk.length; handles[0].emit(chunk); }
	const snapshot = await manager.readEx(sessionId, { timeoutMs: 0 });
	assert.ok(snapshot.text.length <= max, "retained output never exceeds the maximum");
	assert.ok(snapshot.text.length > max / 2);
	assert.equal(snapshot.end, total);
	assert.equal(snapshot.start + snapshot.text.length, total);
	assert.ok(snapshot.text.endsWith("39:".padEnd(8 * 1024, "x")));
	assert.deepEqual(snapshot.dropped, { from: 0, to: snapshot.start });
});

test("MH2: output arriving after a failed match is also debounced, without losing cursor or unread output", async () => {
	let calls = 0;
	const { manager, clock, handles, open } = harness({ matchPattern: async (pattern, input) => { calls++; return pattern.test(input); } });
	const id = open();
	const pending = manager.readEx(id, { timeoutMs: 1_000, waitFor: /READY/ });
	await flush(); assert.equal(calls, 1);
	handles[0].emit("busy"); await flush();
	for (let i = 0; i < 49; i++) { handles[0].emit("."); clock.advance(1); await flush(); }
	assert.equal(calls, 1, "new chunks do not create workers throughout the debounce");
	handles[0].emit("READY"); clock.advance(1); await flush();
	const snapshot = await pending;
	assert.equal(snapshot.wait, "matched"); assert.equal(calls, 2);
	assert.deepEqual([snapshot.start, snapshot.end, snapshot.text], [0, 58, "busy" + ".".repeat(49) + "READY"]);
	assert.deepEqual(await manager.readEx(id, { timeoutMs: 0 }), { ...snapshot, wait: undefined });
});

test("MH2: debounce is bounded by the read deadline and cancellation preserves unread output", async () => {
	for (const cancel of [false, true]) {
		let release!: (value: boolean) => void, calls = 0;
		const { manager, clock, handles, open } = harness({ matchPattern: async () => { calls++; return new Promise<boolean>(resolve => { release = resolve; }); } });
		const id = open(), controller = new AbortController();
		const read = manager.readEx(id, { timeoutMs: 20, waitFor: /never/, signal: controller.signal });
		const stopped = cancel ? assert.rejects(read, /cancelled/) : read;
		handles[0].emit("kept"); release(false); await flush();
		if (cancel) controller.abort(new Error("cancelled")); else clock.advance(20);
		await stopped;
		assert.equal(calls, 1, "no extra full-budget worker after the debounce exhausts the deadline");
		assert.equal(clock.timerCount, 0);
		assert.equal((await manager.readEx(id, { timeoutMs: 0 })).text, "kept");
	}
});

test("MH2/L27: exit during debounce rechecks final output, and an already-exited pause allocates no timer", async () => {
	let calls = 0;
	const { manager, clock, handles, open } = harness({ matchPattern: async (pattern, input) => { calls++; return pattern.test(input); } });
	const id = open();
	const read = manager.readEx(id, { timeoutMs: 1_000, waitFor: /READY/ });
	await flush(); handles[0].emit("READY"); await flush();
	assert.equal(calls, 1);
	handles[0].exit();
	assert.equal((await read).wait, "matched"); assert.equal(calls, 2);
	await manager.pause(id, 60_000);
	assert.equal(clock.timerCount, 0);
});

test("L24: full table never sacrifices unread exited output; drain or explicit release permits admission", async () => {
	const { manager, handles, open } = harness({ maxSessions: 1 });
	const old = open(); handles[0].emit("important"); handles[0].exit();
	assert.throws(open, /unread exited output is retained.*pty_read.*pty_kill/);
	assert.equal(handles.length, 1, "rejected spawn never creates a transport");
	const retained = await manager.readEx(old, { timeoutMs: 0, since: 0 });
	assert.deepEqual([retained.start, retained.end, retained.text], [0, 9, "important"]);
	assert.throws(open, /session limit/, "cursor re-read does not drain unread output");
	assert.equal(await manager.read(old, 0), "important");
	const next = open(); assert.notEqual(next, old);
	handles[1].emit("discard only by explicit request"); handles[1].exit();
	assert.equal((await manager.kill(next)).released, true);
	assert.ok(open());
});

test("L24: a pending dropped-output notice also prevents capacity eviction", async () => {
	const { manager, handles, open } = harness({ maxSessions: 1, maxBufferChars: 4 });
	const id = open(); handles[0].emit("012345"); handles[0].exit();
	assert.throws(open, /session limit/);
	const retained = await manager.readEx(id, { timeoutMs: 0 });
	assert.deepEqual(retained.dropped, { from: 0, to: 2 });
	assert.equal(retained.text, "2345");
	assert.match(await manager.read(id, 0), /cursor 0-2/);
	assert.ok(open());
});

test("L25: small chunks use overflow slack rather than moving the retained start on every append", async () => {
	const max = 64 * 1024;
	const { manager, handles, open } = harness({ maxBufferChars: max });
	const id = open(); handles[0].emit("A".repeat(max)); manager.consume(id, max);
	handles[0].emit("B");
	const first = await manager.readEx(id, { timeoutMs: 0, since: 0 });
	assert.equal(first.start, max / 16 + 1);
	for (let i = 0; i < 64; i++) handles[0].emit("C");
	const last = await manager.readEx(id, { timeoutMs: 0, since: 0 });
	assert.equal(last.start, first.start, "capacity slack avoids a whole-buffer trim per small chunk");
	assert.equal(last.end, max + 65);
	assert.ok(last.text.length <= max);
	const unread = await manager.readEx(id, { timeoutMs: 0 });
	assert.deepEqual([unread.start, unread.text, unread.dropped], [max, "B" + "C".repeat(64), undefined]);
});
