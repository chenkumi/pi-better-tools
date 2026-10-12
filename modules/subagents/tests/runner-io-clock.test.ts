import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IoGate, SUBAGENT_IO_TIMEOUT_MS } from "../extensions/subagent/io-gate.ts";
import { installIoFaultClock } from "./fixtures/runner-io-clock.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
function captureTimers(t: TestContext) {
	type Timer = { ms: number; cleared: boolean; fire: () => void };
	const timers: Timer[] = [];
	t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
		const timer = { ms, cleared: false, fire: () => callback(...args) };
		timers.push(timer);
		return timer;
	}) as unknown as typeof setTimeout);
	t.mock.method(globalThis, "clearTimeout", ((timer: Timer) => { timer.cleared = true; }) as unknown as typeof clearTimeout);
	return timers;
}

for (const wallTimeoutMs of [300, 2000]) {
	test(`fault clock arms ${wallTimeoutMs} ms only after entry and leaves other deadlines intact`, async t => {
		const timers = captureTimers(t);
		const clock = installIoFaultClock(t, ["JSONL write"], wallTimeoutMs);
		const gate = new IoGate();
		await gate.run(async () => {}, "allocate managed session");
		assert.equal(timers[0].ms, SUBAGENT_IO_TIMEOUT_MS);
		assert.equal(timers[0].cleared, true);
		const blocked = deferred();
		const pending = gate.run(() => blocked.promise, "JSONL write");
		const deadline = timers.at(-1)!;
		assert.equal(deadline.ms, SUBAGENT_IO_TIMEOUT_MS, "pre-entry target I/O keeps the production budget");
		assert.equal(deadline.cleared, false);
		const outside = setTimeout(() => {}, SUBAGENT_IO_TIMEOUT_MS);
		assert.equal(timers.at(-1)!.ms, SUBAGENT_IO_TIMEOUT_MS);
		const explicit = new IoGate(2000);
		await explicit.run(async () => {}, "JSONL write");
		assert.equal(timers.at(-1)!.ms, 2000, "other gate budgets are not rewritten");
		clock.arm();
		const replacement = timers.at(-1)!;
		assert.equal(deadline.cleared, true);
		assert.equal(replacement.ms, wallTimeoutMs);
		assert.throws(() => clock.arm(), /only be armed once/);
		const rejected = assert.rejects(pending, /logging I\/O stalled for 300000 ms \(JSONL write\)/);
		replacement.fire();
		await rejected;
		assert.equal(gate.pendingOperations, 1);
		let idle = false;
		const actualIdle = gate.whenIdle().then(() => { idle = true; });
		await Promise.resolve();
		assert.equal(idle, false);
		blocked.resolve(); await actualIdle;
		assert.equal(gate.pendingOperations, 0);
		clearTimeout(outside);
		assert.ok(timers.every(timer => timer.cleared));
	});
}

test("timeout stops the same gate but waits for both actual operations; cleared callbacks cannot fire again", async t => {
	const timers = captureTimers(t);
	const clock = installIoFaultClock(t, ["read tool fallback"], 300);
	const gate = new IoGate(), preparing = deferred(), blocked = deferred();
	const setup = gate.run(() => preparing.promise, "begin managed run");
	const target = gate.run(() => blocked.promise, "read tool fallback");
	const setupRejected = assert.rejects(setup, /read tool fallback/);
	const targetRejected = assert.rejects(target, /read tool fallback/);
	clock.arm(); const replacement = timers.at(-1)!;
	replacement.fire(); await Promise.all([setupRejected, targetRejected]);
	assert.equal(gate.pendingOperations, 2);
	gate.stop(new Error("second cancellation"));
	await assert.rejects(gate.run(async () => {}, "never started"), /read tool fallback/);
	assert.throws(() => clock.arm(), /one active target deadline/);
	let idle = false;
	const actualIdle = gate.whenIdle().then(() => { idle = true; });
	preparing.resolve(); await preparing.promise;
	assert.equal(idle, false);
	blocked.resolve(); await actualIdle;
	replacement.fire(); // Already fired/cleared: cannot revive any work or replace the first reason.
	assert.equal(gate.pendingOperations, 0);
	assert.ok(timers.every(timer => timer.cleared));
});

test("abort and completion cancel both tokens and prohibit arming an inactive target", async t => {
	const timers = captureTimers(t);
	const clock = installIoFaultClock(t, ["create sub-session log"], 300);
	const completed = new IoGate();
	await completed.run(async () => {}, "create sub-session log");
	assert.throws(() => clock.arm(), /one active target deadline/);
	const gate = new IoGate(), blocked = deferred();
	const pending = gate.run(() => blocked.promise, "create sub-session log");
	clock.arm(); const replacement = timers.at(-1)!;
	const rejected = assert.rejects(pending, /parent abort/);
	gate.stop(new Error("parent abort")); await rejected;
	assert.equal(replacement.cleared, true);
	replacement.fire();
	await assert.rejects(gate.run(async () => {}, "never started"), /parent abort/);
	blocked.resolve(); await gate.whenIdle();
	assert.ok(timers.every(timer => timer.cleared));
});

test("synchronous exceptions and nested run scopes cannot capture an unrelated timer", async t => {
	const timers = captureTimers(t);
	const realRun = IoGate.prototype.run;
	t.mock.method(IoGate.prototype, "run", function<T>(this: IoGate, operation: () => Promise<T>, label: string) {
		if (label === "throw synchronously") throw new Error("injected run failure");
		return realRun.call(this, operation, label) as Promise<T>;
	});
	const clock = installIoFaultClock(t, ["JSONL write", "throw synchronously"], 300);
	const gate = new IoGate();
	assert.throws(() => gate.run(async () => {}, "throw synchronously"), /injected run failure/);
	const outside = setTimeout(() => {}, SUBAGENT_IO_TIMEOUT_MS);
	assert.throws(() => clock.arm(), /one active target deadline/);
	clearTimeout(outside);
	let nested: Promise<void> | undefined;
	gate.onWaitingChange = () => {
		if (!nested) nested = new IoGate().run(async () => {}, "nested preparation");
	};
	const blocked = deferred(), pending = gate.run(() => blocked.promise, "JSONL write");
	assert.equal(timers.at(-1)!.ms, SUBAGENT_IO_TIMEOUT_MS);
	clock.arm();
	assert.equal(timers.at(-1)!.ms, 300, "outer target scope restored after nested preparation");
	blocked.resolve(); await pending; await nested;
	assert.ok(timers.every(timer => timer.cleared));
});
