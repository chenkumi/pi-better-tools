import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ulid } from "ulid";
import { runSingleAgent } from "../extensions/subagent/index.ts";
import { ManagedSession, snapshotConfig } from "../extensions/subagent/session-store.ts";
import { SubsessionWriter } from "../extensions/subagent/subsession-log.ts";
import { emitManagedHeader, fixtureAgentPath, installManagedBoundary } from "./fixtures/managed-boundary.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
const agent = { name: "worker", description: "test", source: "bundled" as const, filePath: fixtureAgentPath, systemPrompt: "test" };
const details = (results: any[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });

test("M4 reload instances share live ownership and cannot steal a same-pid writer lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-review-reload-lock-"));
	let session: ManagedSession | undefined;
	try {
		const reloaded = await import(new URL("../extensions/subagent/session-store.ts?review-reload", import.meta.url).href);
		assert.notEqual(reloaded.ManagedSession, ManagedSession, "exercise a distinct loader instance");
		const config = await snapshotConfig(agent, "user", root, undefined, undefined, false);
		session = await ManagedSession.allocate(join(root, "managed"), { parentSessionId: "parent", parentCwd: config.cwd }, config);
		await session.acquire(ulid().toUpperCase());
		const other = await reloaded.ManagedSession.resolve(session.root, session.id, session.manifest.owner);
		await assert.rejects(other.assertResumable(), /SESSION_BUSY/);
		await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
	} finally { await session?.release(); await rm(root, { recursive: true, force: true }); }
});

test("M2 readable transcript retries transient Windows rename denial without losing success", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-review-rename-"));
	const rename = fs.promises.rename;
	let attempts = 0;
	t.mock.method(fs.promises, "rename", async (from: string, to: string) => {
		attempts++;
		if (process.platform === "win32" && attempts < 3) throw Object.assign(new Error("injected reader lock"), { code: "EBUSY" });
		await rename(from, to);
	});
	try {
		const writer = await SubsessionWriter.create({ formatVersion: 2, stagingDir: root, rootDir: root, taskId: "run", parentSessionId: "parent", parentToolCallId: "call", agent: "worker", agentSource: "bundled", task: "test", cwd: root });
		const admission = writer.tryAppend({ type: "assistant", content: "done" });
		assert.equal(admission.status, "accepted");
		if (admission.status === "accepted") assert.deepEqual(await admission.completion, {});
		const result = await writer.finalize({ status: "completed", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, contextTokens: 0, turns: 1 } });
		assert.equal(result.error, undefined);
		assert.equal(result.logPath, writer.finalPath);
		assert.equal(attempts, process.platform === "win32" ? 3 : 1);
		assert.equal(JSON.parse((await readFile(writer.finalPath, "utf8")).trim()).content, "done");
	} finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});

test("L4 thousands of tool identities do not exhaust the independent assistant-output budget", { timeout: 30000 }, async t => {
	installManagedBoundary(t);
	const root = await mkdtemp(join(tmpdir(), "pi-review-identities-"));
	const answer = "Full final answer";
	let retained = 0, resultsLogged = 0;
	// This case tests runner accounting only. Writer/real native commit validation is covered separately.
	t.mock.method(SubsessionWriter.prototype, "tryAppend", (record: any) => {
		if (record.type === "tool_result") resultsLogged++;
		return { status: "accepted", completion: Promise.resolve({}) };
	});
	t.mock.method(childProcess, "spawn", (_command: string, args: string[], options: any) => {
		const stdout = new PassThrough(), stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null, kill() { return true; } });
		setImmediate(() => {
			emitManagedHeader(stdout, args, options.cwd);
			for (let batch = 0; batch < 75; batch++) {
				const content = Array.from({ length: 100 }, (_, index) => ({ type: "toolCall", id: `call-${batch}-${index}`, name: "read", arguments: {} }));
				stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "toolUse" } }) + "\n");
				for (const call of content) stdout.write(JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] } }) + "\n");
			}
			stdout.end(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n");
			stderr.end(); proc.emit("close", 0, null);
		});
		return proc;
	});
	syncBuiltinESMExports();
	try {
		const result = await runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false }, [agent], "worker", "test", undefined, undefined, undefined, undefined, details, "parent", "identities", { sessionRootDir: join(root, "managed"), invocation: args => ({ command: "mock", args }), onResourceStats: stats => { retained = stats.retainedMessageBytes; } });
		assert.equal(result.status, "completed", result.errorMessage);
		assert.equal(result.output, answer);
		assert.equal(resultsLogged, 7500);
		assert.ok(retained > 2 * 1024 * 1024, `identity accounting must exceed the old shared 2 MiB cap: ${retained}`);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test("M1 abandoned children retain all eight permits and locks until actual close", { timeout: 30000 }, async t => {
	installManagedBoundary(t);
	const root = await mkdtemp(join(tmpdir(), "pi-review-abandon-"));
	const children: any[] = [];
	const controllers = Array.from({ length: 8 }, () => new AbortController());
	const released = deferred();
	let releases = 0;
	const release = ManagedSession.prototype.release;
	t.mock.method(ManagedSession.prototype, "release", async function (this: ManagedSession) {
		await release.call(this);
		if (++releases === 8) released.resolve();
	});
	t.mock.method(childProcess, "spawn", (command: string, args: string[], options: any) => {
		if (command === "taskkill") return Object.assign(new EventEmitter(), { unref() {} });
		const index = Number(command.slice("mock-".length));
		const stdout = new PassThrough(), stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null, kill() { return false; } });
		children.push(proc);
		setImmediate(() => { emitManagedHeader(stdout, args, options.cwd); controllers[index].abort(); });
		return proc;
	});
	syncBuiltinESMExports();
	try {
		const runs = controllers.map((controller, index) => runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false }, [agent], "worker", "test", undefined, undefined, controller.signal, undefined, details, "parent", `call-${index}`, { sessionRootDir: join(root, "managed"), invocation: args => ({ command: `mock-${index}`, args }), forceKillDelayMs: 1 }));
		const results = await Promise.all(runs);
		assert.equal(children.length, 8);
		for (const [index, result] of results.entries()) {
			assert.match(result.errorMessage!, /may still be running/);
			assert.equal(result.canResume, false);
			await stat(join(root, "managed", result.subagentSessionId!, "writer.lock"));
			assert.equal(children[index].stdout.destroyed, true);
			assert.equal(children[index].stderr.destroyed, true);
		}
		const ninthController = new AbortController();
		const ninth = runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false }, [agent], "worker", "queued", undefined, undefined, ninthController.signal, undefined, details, "parent", "ninth", { sessionRootDir: join(root, "managed"), invocation: args => ({ command: "mock", args }) });
		ninthController.abort();
		assert.equal((await ninth).status, "aborted");
		assert.equal(children.length, 8, "abandon must not admit a ninth live child");
		children.forEach(child => child.emit("close", null, "SIGKILL"));
		await released.promise;
		for (const result of results) await assert.rejects(stat(join(root, "managed", result.subagentSessionId!, "writer.lock")), { code: "ENOENT" });
	} finally {
		children.forEach(child => { child.stdout.destroy(); child.stderr.destroy(); child.emit("close", null, "SIGKILL"); });
		t.mock.restoreAll(); syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

for (const mode of ["normal", "write-failure", "late", "late-create"] as const) {
	test(`actual writer close rejection retains managed ownership: ${mode}`, { timeout: 10000 }, async t => {
		installManagedBoundary(t);
		const root = await mkdtemp(join(tmpdir(), "pi-review-close-reject-"));
		const syncEntered = deferred(), finishSync = deferred(), lateReported = deferred();
		const controller = new AbortController();
		const open = fs.promises.open;
		let actualClose: (() => Promise<void>) | undefined;
		let releases = 0, blocks = 0, commits = 0;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		process.on("unhandledRejection", onUnhandled);
		t.mock.method(ManagedSession.prototype, "release", async () => { releases++; });
		t.mock.method(ManagedSession.prototype, "blocked", async () => { blocks++; return true; });
		t.mock.method(ManagedSession.prototype, "commit", async () => { commits++; });
		t.mock.method(console, "error", (message: unknown) => {
			assert.match(String(message), /Late managed cleanup failed:.*close.*injected actual close failure/i);
			lateReported.resolve();
		});
		t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
			const handle = await open(...args);
			if (String(args[0]).endsWith("transcript.jsonl.partial")) {
				actualClose = handle.close.bind(handle);
				const sync = handle.sync.bind(handle);
				const write = handle.writeFile.bind(handle);
				t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof handle.writeFile>) => {
					if (mode === "write-failure") throw new Error("ENOSPC primary write failure");
					return write(...writeArgs);
				});
				t.mock.method(handle, "sync", async () => {
					if (mode === "late") { syncEntered.resolve(); await finishSync.promise; }
					await sync();
				});
				t.mock.method(handle, "close", async () => { throw new Error("injected actual close failure"); });
			}
			return handle;
		});
		const create = SubsessionWriter.create.bind(SubsessionWriter);
		t.mock.method(SubsessionWriter, "create", async (options: Parameters<typeof create>[0]) => {
			const created = await create(options);
			if (mode === "late-create") { syncEntered.resolve(); await finishSync.promise; }
			return created;
		});
		t.mock.method(childProcess, "spawn", (_command: string, args: string[], options: any) => {
			assert.notEqual(mode, "late-create", "cancelled late creation must not spawn");
			const stdout = new PassThrough(), stderr = new PassThrough();
			const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null, kill() { return true; } });
			setImmediate(() => {
				emitManagedHeader(stdout, args, options.cwd);
				stdout.end(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n");
				stderr.end(); proc.emit("close", 0, null);
			});
			return proc;
		});
		syncBuiltinESMExports();
		try {
			const run = runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false }, [agent], "worker", "test", undefined, undefined, controller.signal, undefined, details, "parent", `close-${mode}`, { sessionRootDir: join(root, "managed"), invocation: args => ({ command: "mock", args }) });
			if (mode.startsWith("late")) { await syncEntered.promise; controller.abort(); }
			const result = await run;
			assert.equal(result.canResume, false);
			if (mode.startsWith("late")) { finishSync.resolve(); await lateReported.promise; }
			else assert.match(result.logError!, /close.*injected actual close failure/i);
			if (mode === "write-failure") assert.match(result.errorMessage!, /ENOSPC primary write failure/);
			await new Promise<void>(resolve => setImmediate(resolve)); // drain rejection reporting, not a timed sleep
			assert.deepEqual(unhandled, [], "unawaited abandonment must attach its rejection handler immediately");
			assert.equal(commits, 0);
			assert.equal(blocks, 0, "no rollback or ready publication while close is unconfirmed");
			assert.equal(releases, 0);
			const directory = join(root, "managed", result.subagentSessionId!);
			await stat(join(directory, "writer.lock"));
			assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).state, "running");
		} finally {
			finishSync.resolve(); await actualClose?.();
			process.off("unhandledRejection", onUnhandled);
			t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true });
		}
	});
}

test("M4 cancelled acquire retains its owner until the actual late acquisition completes", { timeout: 30000 }, async t => {
	installManagedBoundary(t);
	const root = await mkdtemp(join(tmpdir(), "pi-review-late-acquire-"));
	const entered = deferred(), finish = deferred(), released = deferred();
	const controller = new AbortController();
	const acquire = ManagedSession.prototype.acquire, release = ManagedSession.prototype.release;
	let session: ManagedSession | undefined;
	t.mock.method(ManagedSession.prototype, "acquire", async function (this: ManagedSession, taskId: string) {
		session = this;
		await acquire.call(this, taskId);
		entered.resolve(); await finish.promise;
	});
	t.mock.method(ManagedSession.prototype, "release", async function (this: ManagedSession) {
		await release.call(this); released.resolve();
	});
	t.mock.method(childProcess, "spawn", () => { assert.fail("cancelled startup must not spawn"); });
	syncBuiltinESMExports();
	try {
		const run = runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false }, [agent], "worker", "test", undefined, undefined, controller.signal, undefined, details, "parent", "late-acquire", { sessionRootDir: join(root, "managed") });
		await entered.promise; controller.abort();
		assert.equal((await run).status, "aborted");
		const lock = join(session!.directory, "writer.lock");
		await stat(lock);
		const other = await ManagedSession.resolve(session!.root, session!.id, session!.manifest.owner);
		await assert.rejects(other.assertResumable(), /SESSION_BUSY/);
		finish.resolve(); await released.promise;
		await assert.rejects(stat(lock), { code: "ENOENT" });
	} finally {
		finish.resolve(); await released.promise;
		t.mock.restoreAll(); syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});
