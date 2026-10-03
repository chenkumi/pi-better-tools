import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test, { beforeEach, type TestContext } from "node:test";
import { emitManagedHeader, installManagedBoundary } from "./fixtures/managed-boundary.ts";
beforeEach(installManagedBoundary);
import { runSingleAgent } from "../extensions/subagent/index.ts";
import { IoGate, SUBAGENT_IO_TIMEOUT_MS } from "../extensions/subagent/io-gate.ts";
import { SubsessionWriter, MAX_PENDING_LOG_BYTES } from "../extensions/subagent/subsession-log.ts";
import { ToolResultSpool } from "../extensions/subagent/tool-result-spool.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const fallback = { type: "tool_execution_end", toolCallId: "call", toolName: "read", isError: false, result: { content: [{ type: "text", text: "provisional" }] } };
const canonical = { type: "message_end", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "canonical" }] } };
const terminal = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } };

type Mode = "spool-read-cleanup" | "writer-create-failure" | "managed-close-stall" | "terminal-trailing" | "slow" | "abort" | "stall" | "final-stall" | "final-abort" | "header-abort" | "close-stall" | "rename-failure" | "unlink-failure" | "spool-failure" | "spool-read-stall";
async function setup(t: TestContext, mode: Mode) {
	const root = await fs.promises.mkdtemp(join(tmpdir(), "pi-runner-io-"));
	const agentPath = join(root, "agent.md");
	await fs.promises.writeFile(agentPath, "test");
	const blocked = deferred();
	const entered = deferred();
	const closed = deferred();
	const cleanupReadBlocked = deferred();
	const cleanupWaiting = deferred();
	const spoolIterations = new Set<Promise<void>>();
	const originalRecords = ToolResultSpool.prototype.records;
	t.mock.method(ToolResultSpool.prototype, "records", function (this: ToolResultSpool) {
		const completed = deferred();
		spoolIterations.add(completed.promise);
		const source = originalRecords.call(this);
		return (async function* () {
			try { yield* source; }
			finally { completed.resolve(); spoolIterations.delete(completed.promise); }
		})();
	});
	const controller = new AbortController();
	const signals: string[] = [];
	const originalOpen = fs.promises.open;
	const originalCreate = SubsessionWriter.create.bind(SubsessionWriter);
	let writer: SubsessionWriter | undefined;
	let writerCreation: Promise<void> | undefined;
	let transcriptOpened = false;
	let closeCount = 0;
	let started = false;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
		const handle = await originalOpen(...args);
		if (String(args[0]).endsWith(".jsonl.partial")) {
			transcriptOpened = true;
			const originalWrite = handle.writeFile.bind(handle);
			const originalClose = handle.close.bind(handle);
			const sync = handle.sync.bind(handle);
			t.mock.method(handle, "sync", async () => {
				if (["final-stall", "final-abort"].includes(mode)) { entered.resolve(); await blocked.promise; }
				return sync();
			});
			t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof handle.writeFile>) => {
				const record = JSON.parse(String(writeArgs[0]));
				const target = "tool_result";
				if (mode === "managed-close-stall" && record.type === target) throw new Error("ENOSPC injected managed write failure");
				if (["slow", "abort", "stall"].includes(mode) && record.type === target) {
					entered.resolve();
					await blocked.promise;
				}
				return originalWrite(...writeArgs);
			});
			t.mock.method(handle, "close", async () => {
				closeCount++;
				if (["close-stall", "managed-close-stall"].includes(mode)) { entered.resolve(); await blocked.promise; }
				await originalClose();
				closed.resolve();
			});
		} else if (["spool-read-stall", "spool-read-cleanup"].includes(mode) && String(args[0]).includes("tool-results-") && String(args[0]).endsWith(".json")) {
			const originalRead = handle.read.bind(handle);
			t.mock.method(handle, "read", async (...readArgs: any[]) => {
				entered.resolve();
				await blocked.promise;
				if (mode === "spool-read-cleanup") await cleanupReadBlocked.promise;
				return originalRead(...readArgs as [any, any, any, any]);
			});
		}
		return handle;
	});
	t.mock.method(SubsessionWriter, "create", (options: any) => {
		const creation = (async () => {
			if (mode === "writer-create-failure") throw new Error("EACCES injected writer creation failure");
			writer = await originalCreate(options);
			if (mode === "header-abort") { entered.resolve(); await blocked.promise; }
			return writer;
		})();
		// Track even late creation after the runner's I/O gate has stopped waiting.
		writerCreation = creation.then(() => undefined, () => undefined);
		return creation;
	});
	if (mode === "rename-failure") {
		const original = fs.promises.rename;
		t.mock.method(fs.promises, "rename", (...args: Parameters<typeof original>) => {
			if (String(args[1]).endsWith(".jsonl")) return Promise.reject(new Error("EACCES injected final rename"));
			return original(...args);
		});
	}
	if (mode === "unlink-failure") {
		const original = fs.promises.unlink;
		t.mock.method(fs.promises, "unlink", (...args: Parameters<typeof original>) => {
			if (String(args[0]).endsWith(".json")) return Promise.reject(new Error("EACCES injected fallback unlink"));
			return original(...args);
		});
	}
	if (mode === "spool-failure") {
		const original = fs.promises.writeFile;
		t.mock.method(fs.promises, "writeFile", (...args: Parameters<typeof original>) => {
			if (String(args[0]).includes("tool-results-") && String(args[0]).endsWith(".partial")) return Promise.reject(new Error("ENOSPC injected spool write"));
			return original(...args);
		});
	}
	t.mock.method(childProcess, "spawn", (_command, args: readonly string[]) => {
		started = true;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), {
			stdout, stderr, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
			kill(signal: NodeJS.Signals) {
				signals.push(signal);
				if (heartbeat) clearInterval(heartbeat);
				if (signal === "SIGKILL") {
					proc.signalCode = signal;
					stdout.end(); stderr.end();
					setImmediate(() => proc.emit("close", null, signal));
				}
				return true;
			},
		});
		setImmediate(() => {
			emitManagedHeader(stdout, args, root);
			const events = ["spool-read-stall", "spool-read-cleanup"].includes(mode) ? [fallback, terminal] : [fallback, canonical, canonical, terminal];
			stdout.write([...events, { type: "agent_settled" }].map((event) => JSON.stringify(event)).join("\n") + "\n");
			stderr.write("diagnostic");
			const finish = () => { stdout.end(); stderr.end(); proc.exitCode = 0; proc.emit("close", 0, null); };
			if (mode === "slow") void blocked.promise.then(() => setImmediate(finish));
			else if (mode === "terminal-trailing") heartbeat = setInterval(() => stderr.write("trailing"), 5);
			else if (!["abort", "stall"].includes(mode)) finish();
		});
		return proc;
	});
	syncBuiltinESMExports();
	const result = runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false },
		[{ name: "worker", description: "test", source: "bundled", filePath: agentPath, systemPrompt: "test" }],
		"worker", "I/O test", undefined, undefined, controller.signal, undefined,
		(results, progress) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results, progress }),
		"parent", "call", { sessionRootDir: join(root, "managed"), invocation: (args) => ({ command: "mock", args }), inactivityTimeoutMs: 100, ioTimeoutMs: ["slow", "terminal-trailing", "writer-create-failure"].includes(mode) ? 2000 : 300, forceKillDelayMs: 15 });
	return {
		root, result, controller, release: blocked.resolve, signals,
		entered: () => Promise.race([entered.promise, result.then(settled => { throw new Error(`Runner settled before injected ${mode} I/O; ${JSON.stringify(settled)}`); })]),
		transcriptClosed: closed.promise, cleanupWaiting: cleanupWaiting.promise, releaseRead: cleanupReadBlocked.resolve,
		get pendingSpoolIterations() { return spoolIterations.size; },
		get writer() { return writer; }, get closeCount() { return closeCount; }, get started() { return started; },
		async files() { return fs.promises.readdir(root, { recursive: true }); },
		async dispose() {
			blocked.resolve();
			const settled = await result;
			let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					(async () => {
						await writerCreation;
						// A failure before opening the transcript has no handle to close.
						// If creation was in flight, wait for it first and retain the real close barrier.
						if (transcriptOpened) await closed.promise;
						while (spoolIterations.size) {
							cleanupWaiting.resolve();
							await Promise.all([...spoolIterations]);
						}
					})(),
					new Promise<never>((_resolve, reject) => {
						cleanupTimer = setTimeout(() => reject(new Error(`Fixture cleanup stalled; retained ${root}; mode=${mode}; started=${started}; transcriptOpened=${transcriptOpened}; result=${JSON.stringify(settled)}`)), 3000);
					}),
				]);
			} finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
			// Any released spool read/iterator-return must finish before test directory removal.
			t.mock.restoreAll(); syncBuiltinESMExports();
			await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
		},
	};
}

test("production logging I/O deadline is fixed at 300 seconds", () => {
	assert.equal(SUBAGENT_IO_TIMEOUT_MS, 300_000);
});

test("slow write freezes inactivity and keeps fallback until canonical acknowledgement", { timeout: 10000 }, async (t) => {
	const h = await setup(t, "slow");
	try {
		await h.entered();
		let settled = false; void h.result.then(() => { settled = true; });
		await delay(220); // deliberately beyond inactivity, while controlled write remains blocked
		assert.equal(settled, false);
		assert.deepEqual(h.signals, []);
		assert.ok((await h.files()).some((name) => name.endsWith(".json")));
		assert.ok(h.writer!.getPendingStats().bytes <= MAX_PENDING_LOG_BYTES);
		h.release();
		const result = await h.result;
		assert.equal(result.status, "completed");
		assert.equal(result.logError, undefined);
		const records = (await fs.promises.readFile(result.logPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const results = records.filter((record) => record.type === "tool_result");
		assert.equal(results.length, 1);
		assert.equal(results[0].content, "canonical");
		assert.ok(records.every(record => ["assistant", "tool_result"].includes(record.type)));
		assert.equal((await h.files()).filter((name) => name.includes("tool-results-")).length, 0);
		assert.equal(h.closeCount, 1);
		assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
	} finally { await h.dispose(); }
});

for (const mode of ["abort", "stall", "final-stall", "final-abort", "header-abort", "close-stall", "spool-read-stall"] as const) {
	test(`blocked I/O is bounded without premature handle or file cleanup: ${mode}`, { timeout: 10000 }, async (t) => {
		const h = await setup(t, mode);
		try {
			await h.entered();
			const abort = mode.includes("abort");
			if (abort) h.controller.abort();
			if (mode === "abort") assert.deepEqual(h.signals, ["SIGTERM"]); // synchronous, before releasing I/O
			const result = await h.result;
			assert.equal(result.status, abort ? "aborted" : "failed");
			assert.equal(result.logPath, undefined);
			assert.ok(result.logError);
			if (!abort) assert.match(`${result.errorMessage} ${result.logError}`, /logging I\/O stalled/);
			assert.doesNotMatch(result.errorMessage ?? "", /no stdout or stderr/);
			if (mode === "abort" || mode === "stall") {
				assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
				assert.ok((await h.files()).some((name) => name.endsWith(".json")));
			}
			if (mode === "header-abort") assert.equal(h.started, false);
			if (["abort", "stall", "final-stall", "final-abort", "header-abort"].includes(mode)) assert.equal(h.closeCount, 0);
			if (mode === "close-stall") assert.equal(h.closeCount, 1);
			assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
			h.controller.abort(); // must not replace I/O timeout or signal again after settlement
			if (!abort) assert.equal(result.status, "failed");
		} finally { await h.dispose(); }
	});
}

for (const mode of ["rename-failure", "unlink-failure", "spool-failure"] as const) {
	test(`disk failures retain artifacts and never claim a complete transcript: ${mode}`, { timeout: 10000 }, async (t) => {
		const h = await setup(t, mode);
		try {
			const result = await h.result;
			assert.equal(result.status, "failed");
			assert.equal(result.logPath, undefined);
			assert.ok(result.logError);
			assert.match(`${result.errorMessage} ${result.logError}`, /EACCES|ENOSPC/);
			const files = await h.files();
			assert.ok(files.some((name) => name.endsWith(".jsonl.partial")));
			assert.ok(files.some((name) => name.includes("tool-results-")));
		} finally { await h.dispose(); }
	});
}

test("managed failed writer retains lock while abandoned close is pending", { timeout: 10000 }, async (t) => {
	const h = await setup(t, "managed-close-stall");
	try {
		await h.entered();
		const result = await h.result;
		assert.equal(result.status, "failed"); assert.equal(result.canResume, false);
		assert.match(result.logError!, /close abandoned managed transcript/);
		const directory = join(h.root, "managed", result.subagentSessionId!);
		await fs.promises.stat(join(directory, "writer.lock"));
		assert.equal(JSON.parse(await fs.promises.readFile(join(directory, "manifest.json"), "utf8")).state, "running");
		h.release(); await delay(50);
		await fs.promises.stat(join(directory, "writer.lock")); // no asynchronous takeover/release
	} finally { await h.dispose(); }
});

test("cleanup retains artifacts after transcript close until the abandoned spool iterator finishes", { timeout: 10000 }, async (t) => {
	const h = await setup(t, "spool-read-cleanup");
	let disposing: Promise<void> | undefined;
	try {
		await h.entered();
		const result = await h.result;
		assert.equal(result.status, "failed");
		assert.match(result.logError!, /logging I\/O stalled/);
		await h.transcriptClosed;
		assert.equal(h.closeCount, 1);
		assert.equal(h.pendingSpoolIterations, 1);
		let removed = false;
		disposing = h.dispose().then(() => { removed = true; });
		await h.cleanupWaiting;
		assert.equal(removed, false);
		assert.ok((await h.files()).some(name => name.includes("tool-results-")));
		h.releaseRead();
		await disposing;
		assert.equal(h.pendingSpoolIterations, 0);
		await assert.rejects(fs.promises.stat(h.root), { code: "ENOENT" });
	} finally {
		h.releaseRead();
		if (disposing) await disposing; else await h.dispose();
	}
});

test("writer creation failure cleans up without waiting for a nonexistent transcript handle", { timeout: 10000 }, async (t) => {
	const h = await setup(t, "writer-create-failure");
	try {
		const result = await h.result;
		assert.equal(result.status, "failed");
		assert.match(result.logError!, /EACCES injected writer creation failure/);
		assert.equal(h.started, false);
		assert.equal(h.closeCount, 0);
	} finally { await h.dispose(); }
	await assert.rejects(fs.promises.stat(h.root), { code: "ENOENT" });
});

test("trailing stderr writes cannot renew the settled process-close deadline", { timeout: 10000 }, async (t) => {
	const h = await setup(t, "terminal-trailing");
	try {
		const result = await h.result;
		assert.equal(result.output, "done");
		assert.equal(result.status, "failed");
		assert.match(result.errorMessage!, /no stdout or stderr for 100 ms/);
		assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
	} finally { await h.dispose(); }
});

test("I/O gate contains observers, preserves undefined rejection and tracks late operations", async () => {
	const gate = new IoGate(200);
	gate.onWaitingChange = () => { throw new Error("observer"); };
	let rejected = false;
	await gate.run(() => Promise.reject(undefined), "undefined rejection").then(() => assert.fail("must reject"), (error) => { rejected = true; assert.equal(error, undefined); });
	assert.equal(rejected, true);
	assert.equal(gate.pendingOperations, 0);
	const blocked = deferred();
	const waiting = gate.run(() => blocked.promise, "blocked");
	gate.stop(new Error("first cancellation"));
	gate.stop(new Error("second cancellation"));
	await assert.rejects(waiting, /first cancellation/);
	assert.equal(gate.pendingOperations, 1);
	blocked.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(gate.pendingOperations, 0);
	await assert.rejects(gate.run(async () => {}, "never started"), /first cancellation/);
});
