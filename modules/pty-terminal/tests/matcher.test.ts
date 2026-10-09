import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { matchPattern, type MatcherOptions } from "../src/matcher.ts";

function clock() {
	let now = 0, next = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		timers: {
			set(callback: () => void, ms: number) { const id = ++next; timers.set(id, { at: now + ms, callback }); return id; },
			clear(handle: unknown) { timers.delete(handle as number); },
		},
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]); now = due[1].at; due[1].callback();
			}
			now = target;
		},
		get size() { return timers.size; },
	};
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(holdExit = false) {
	const time = clock();
	const worker = new EventEmitter();
	let finishExit!: (code: number) => void;
	let terminationCalls = 0;
	const exited = new Promise<number>(resolve => { finishExit = resolve; });
	const options: MatcherOptions = {
		timers: time.timers,
		createWorker(_url, config) {
			assert.deepEqual(config.execArgv, [], "host loaders must not leak into the worker");
			return Object.assign(worker, { terminate() { terminationCalls++; if (!holdExit) finishExit(0); return exited; } }) as unknown as Worker;
		},
	};
	return { time, worker, options, finishExit, get terminationCalls() { return terminationCalls; } };
}

test("M14: online/import startup does not consume even a 1ms compute budget; ready does", async () => {
	const h = harness();
	const pending = matchPattern(/READY/, "READY", undefined, 1, h.options);
	let settled = false; void pending.then(() => { settled = true; });
	h.worker.emit("online"); h.time.advance(4_999); await flush();
	assert.equal(settled, false, "online is not a module-ready receipt");
	h.worker.emit("message", { ready: true });
	h.worker.emit("message", { matched: true });
	assert.equal(await pending, true);
	assert.equal(h.terminationCalls, 1); assert.equal(h.time.size, 0);
});

test("M14: startup is separately bounded and stalled computation is terminated", async () => {
	for (const ready of [false, true]) {
		const h = harness();
		const pending = matchPattern(/a/, "a", undefined, 7, h.options);
		const rejected = assert.rejects(pending, ready ? /exceeded 7ms worker budget/ : /did not start within 5000ms/);
		if (ready) h.worker.emit("message", { ready: true });
		h.time.advance(ready ? 7 : 5_000);
		await rejected;
		assert.equal(h.terminationCalls, 1); assert.equal(h.time.size, 0);
	}
});

test("worker capacity stays held until confirmed termination after result, abort, or timeout", async () => {
	for (const reason of ["result", "abort", "timeout"] as const) {
		const handles = Array.from({ length: 16 }, () => harness(true));
		const controller = new AbortController();
		const pending = handles.map(h => matchPattern(/x/, "x", controller.signal, 1, h.options));
		const completed = pending.map(p => reason === "result" ? p : assert.rejects(p, reason === "abort" ? /cancelled/ : /worker budget/));
		try {
			for (const h of handles) h.worker.emit("message", { ready: true });
			if (reason === "result") for (const h of handles) h.worker.emit("message", { matched: true });
			else if (reason === "abort") controller.abort(new Error("cancelled"));
			else for (const h of handles) h.time.advance(1);
			await flush();
			assert.ok(handles.every(h => h.terminationCalls === 1));
			await assert.rejects(matchPattern(/x/, "x"), /capacity exhausted/);
		} finally {
			for (const h of handles) h.finishExit(0);
			await Promise.all(completed);
		}
		const fresh = harness();
		const read = matchPattern(/x/, "x", undefined, 1, fresh.options);
		fresh.worker.emit("message", { ready: true }); fresh.worker.emit("message", { matched: true });
		assert.equal(await read, true, "capacity is reusable only after all owned workers exit");
	}
});
