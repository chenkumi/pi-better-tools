import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ulid } from "ulid";
import { Semaphore, killProcessTree } from "../extensions/subagent/concurrency.ts";
import guard from "../extensions/subagent/child-guard.ts";
import { getPiInvocation, runSingleAgent } from "../extensions/subagent/index.ts";
import { ConversationDigest, ManagedSession, canonicalCwd, renameWithRetry, snapshotConfig } from "../extensions/subagent/session-store.ts";
import { emitManagedHeader, fixtureAgentPath, installManagedBoundary } from "./fixtures/managed-boundary.ts";

const active = () => true;

test("Semaphore grants FIFO permits, releases once, and drops aborted waiters", async () => {
	const semaphore = new Semaphore(2);
	const a = await semaphore.acquire(), b = await semaphore.acquire();
	assert.ok(a && b);
	const controller = new AbortController();
	const queued = semaphore.acquire(), aborted = semaphore.acquire(controller.signal);
	assert.equal(semaphore.waiting, 2);
	controller.abort();
	assert.equal(await aborted, undefined);
	assert.equal(semaphore.waiting, 1);
	a!(); a!(); // double release must not mint a permit
	const third = await queued;
	assert.ok(third);
	assert.equal(semaphore.free, 0);
	b!(); third!();
	assert.equal(semaphore.free, 2);
	assert.equal(await semaphore.acquire(AbortSignal.abort()), undefined);
});

test("separate dispatches share one process-wide limit of 8 active children", { timeout: 30000 }, async (t) => {
	installManagedBoundary(t);
	let live = 0, peak = 0;
	t.mock.method(childProcess, "spawn", (_command: string, args: readonly string[], options: any) => {
		live++; peak = Math.max(peak, live);
		const stdout = new PassThrough(), stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), { stdout, stderr, pid: undefined, exitCode: null, signalCode: null, kill() { return true; } });
		setImmediate(() => {
			emitManagedHeader(stdout, args, options.cwd);
			stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }) + "\n");
			setTimeout(() => { live--; stdout.end(); stderr.end(); proc.emit("close", 0, null); }, 10);
		});
		return proc;
	});
	syncBuiltinESMExports();
	const roots: string[] = [];
	try {
		const runs = Array.from({ length: 20 }, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-global-limit-"));
			roots.push(root);
			return runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false },
				[{ name: "worker", description: "t", source: "bundled", filePath: fixtureAgentPath, systemPrompt: "t" }],
				"worker", "t", undefined, undefined, undefined, undefined,
				(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }), "s", "c",
				{ sessionRootDir: join(root, "managed"), invocation: (args) => ({ command: "mock", args }) });
		});
		const results = await Promise.all(runs);
		assert.ok(peak >= 1 && peak <= 8, `peak ${peak}`);
		assert.ok(results.every((r) => r.status === "completed"), JSON.stringify(results.map((r) => r.errorMessage)));
	} finally {
		t.mock.restoreAll(); syncBuiltinESMExports();
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	}
});

test("killProcessTree adds taskkill /T /F only on win32 and keeps the direct kill", () => {
	const calls: string[][] = [];
	const signals: string[] = [];
	const proc = { pid: 4242, kill(signal?: string) { signals.push(String(signal)); return true; } };
	const spawnFn = (command: string, args: string[]) => { calls.push([command, ...args]); return { on() {}, unref() {} }; };
	killProcessTree(proc, "SIGTERM", { platform: "win32", spawn: spawnFn });
	assert.deepEqual(calls, [["taskkill", "/pid", "4242", "/T", "/F"]]);
	assert.deepEqual(signals, ["SIGTERM"]);
	calls.length = 0;
	killProcessTree(proc, "SIGTERM", { platform: "linux", killGroup() {}, spawn: spawnFn });
	killProcessTree({ kill: proc.kill }, "SIGKILL", { platform: "win32", spawn: spawnFn });
	assert.deepEqual(calls, []);
});

test("killProcessTree signals the POSIX process group and falls back to the direct child", () => {
	const groups: Array<[number, string]> = [];
	const signals: string[] = [];
	const spawnFn = () => { throw new Error("taskkill must not run on POSIX"); };
	const proc = { pid: 4242, kill(signal?: string) { signals.push(String(signal)); return true; } };
	killProcessTree(proc, "SIGTERM", { platform: "linux", killGroup: (pid, signal) => { groups.push([pid, signal]); }, spawn: spawnFn });
	assert.deepEqual(groups, [[4242, "SIGTERM"]]);
	assert.deepEqual(signals, [], "a delivered group signal already covers the direct child");
	killProcessTree(proc, "SIGKILL", { platform: "linux", killGroup() { throw Object.assign(new Error("no group"), { code: "ESRCH" }); }, spawn: spawnFn });
	assert.deepEqual(signals, ["SIGKILL"]);
	killProcessTree({ kill: proc.kill }, "SIGTERM", { platform: "linux", killGroup() { throw new Error("must not be called without a pid"); }, spawn: spawnFn });
	assert.deepEqual(signals, ["SIGKILL", "SIGTERM"]);
});

test("getPiInvocation honours the explicit PI_SUBAGENTS_PI_CLI override", () => {
	assert.deepEqual(getPiInvocation(["-x"], { PI_SUBAGENTS_PI_CLI: "/opt/pi/cli.js" }), { command: process.execPath, args: ["/opt/pi/cli.js", "-x"] });
	assert.deepEqual(getPiInvocation(["-x"], { PI_SUBAGENTS_PI_CLI: "/usr/local/bin/pi" }), { command: "/usr/local/bin/pi", args: ["-x"] });
	const resolved = getPiInvocation(["-x"], {});
	assert.equal(resolved.args.at(-1), "-x");
});

test("child guard consumes PI_SUBAGENTS_GUARD so grandchildren cannot inherit it", () => {
	const previous = process.env.PI_SUBAGENTS_GUARD;
	const slot = globalThis as { __piSubagentsGuardExpected?: unknown };
	const registered: string[] = [];
	try {
		process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "x", cwd: "/", startupPath: "/nowhere" });
		guard({ on: (event: string) => registered.push(event) } as any);
		assert.deepEqual(registered, ["session_start"]);
		assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined);
		// A reload in the same child still sees the parsed handshake.
		guard({ on: (event: string) => registered.push(event) } as any);
		assert.equal(registered.length, 2);
	} finally {
		delete slot.__piSubagentsGuardExpected;
		if (previous === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = previous;
	}
});

test("renameWithRetry retries transient win32 EPERM/EBUSY and surfaces persistent failures", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rename-"));
	try {
		const from = join(dir, "a"), to = join(dir, "b");
		await writeFile(from, "x");
		let failures = 2;
		await renameWithRetry(from, to, 6, "win32", async (source, target) => {
			if (failures-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
			await import("node:fs/promises").then((fs) => fs.rename(source, target));
		});
		assert.equal(await readFile(to, "utf8"), "x");
		let calls = 0;
		await writeFile(from, "y");
		await assert.rejects(renameWithRetry(from, to, 3, "win32", async () => { calls++; throw Object.assign(new Error("denied"), { code: "EPERM" }); }), /denied/);
		assert.equal(calls, 3);
		await writeFile(from, "z");
		calls = 0;
		await assert.rejects(renameWithRetry(from, to, 3, "linux", async () => { calls++; throw Object.assign(new Error("denied"), { code: "EPERM" }); }), /denied/);
		assert.equal(calls, 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

async function setup() {
	const temp = await mkdtemp(join(tmpdir(), "pi-review-unit-")), root = join(temp, "managed"), cwd = await canonicalCwd(temp);
	const filePath = join(temp, "agent.md"); await writeFile(filePath, "source");
	const agent = { name: "worker", description: "test", source: "bundled" as const, filePath, systemPrompt: "test" };
	const config = { ...await snapshotConfig(agent, "user", cwd, "offline/model", "off", false), childTrusted: false };
	const owner = { parentSessionId: "parent", parentCwd: cwd };
	return { temp, root, owner, session: await ManagedSession.allocate(root, owner, config) };
}
async function prepare(session: ManagedSession, key: string, existing = false) {
	const taskId = ulid().toUpperCase(); await session.acquire(taskId);
	if (existing) await session.validateCheckpoint();
	await session.begin(taskId, key, "task", active);
	const file = join(session.directory, "pi", "native.jsonl");
	let leaf = session.manifest.checkpoint?.leafId ?? "";
	const entry = (type: string, extra: any) => { const id = ulid().toUpperCase(); const e = { type, id, parentId: leaf || null, timestamp: new Date().toISOString(), ...extra }; leaf = id; return e; };
	const user = { role: "user", content: "task", timestamp: 1 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 2 };
	const entries = existing ? [] : [{ type: "session", version: 3, id: session.id, cwd: session.manifest.config.cwd }, entry("model_change", { provider: "offline", modelId: "model" }), entry("thinking_level_change", { thinkingLevel: "off" })];
	entries.push(entry("message", { message: user }), entry("message", { message: assistant }));
	await appendFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const segment = join(session.runDir, "transcript.jsonl"); await writeFile(segment, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), content: "task" }) + "\n");
	const digest = new ConversationDigest(); digest.add(user); digest.add(assistant);
	return { file, segment, digest };
}

test("failed or cancelled continuation rolls a previously ready session back to its checkpoint", async () => {
	const s = await setup();
	try {
		const first = await prepare(s.session, "one"); await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
		const checkpoint = (await ManagedSession.resolve(s.root, s.session.id, s.owner)).manifest.checkpoint!;
		const resumed = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await prepare(resumed, "two", true); // child "ran" and appended native + readable bytes, then the run failed
		await appendFile(resumed.logPath, "partial garbage\n");
		assert.equal(await resumed.blocked("COMMIT_FAILED", {}, active, true), true);
		await resumed.release();
		const manifest = JSON.parse(await readFile(join(resumed.directory, "manifest.json"), "utf8"));
		assert.equal(manifest.state, "ready");
		assert.equal(manifest.errorCode, undefined);
		assert.equal((await stat(first.file)).size, checkpoint.nativeBytes);
		assert.equal((await stat(resumed.logPath)).size, checkpoint.readableCommittedBytes);
		const again = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await again.assertResumable(); await again.acquire(ulid().toUpperCase()); await again.validateCheckpoint(); await again.release();
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

test("rollback refuses to restore when the checkpointed native prefix was modified", async () => {
	const s = await setup();
	try {
		const first = await prepare(s.session, "one"); await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
		const resumed = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await prepare(resumed, "two", true);
		const bytes = await readFile(first.file); bytes[10] = bytes[10] ^ 1; await writeFile(first.file, bytes);
		assert.equal(await resumed.blocked("COMMIT_FAILED", {}, active, true), false);
		await resumed.release();
		assert.equal(JSON.parse(await readFile(join(resumed.directory, "manifest.json"), "utf8")).state, "blocked");
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

test("a first-run failure without a checkpoint stays blocked even when restore is requested", async () => {
	const s = await setup();
	try {
		await prepare(s.session, "one");
		assert.equal(await s.session.blocked("COMMIT_FAILED", {}, active, true), false);
		assert.equal(JSON.parse(await readFile(join(s.session.directory, "manifest.json"), "utf8")).state, "blocked");
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

test("a writer lock owned by a dead pid is taken over and rolled back; a live foreign pid is not", async () => {
	const s = await setup();
	try {
		const first = await prepare(s.session, "one"); await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
		const crashed = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await prepare(crashed, "two", true); // parent "crashes" here: lock + state=running remain
		const ownerFile = join(crashed.directory, "writer.lock", "owner.json"), owner = JSON.parse(await readFile(ownerFile, "utf8"));
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
		const live = ManagedSession.resolve(s.root, s.session.id, s.owner);
		await writeFile(ownerFile, JSON.stringify({ ...owner, pid: process.ppid || 1 }));
		if (process.ppid) { // a live foreign process still blocks takeover
			const other = await live;
			await assert.rejects(other.assertResumable(), /SESSION_BUSY/);
			await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
		}
		await writeFile(ownerFile, JSON.stringify({ ...owner, pid: dead }));
		const recovering = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await recovering.assertResumable();
		await recovering.acquire(ulid().toUpperCase());
		await recovering.validateCheckpoint();
		assert.equal(recovering.manifest.state, "ready");
		await recovering.release();
		assert.equal((await stat(first.file)).size, recovering.manifest.checkpoint!.nativeBytes);
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

test("a stale lock without a verified checkpoint is not taken over", async () => {
	const s = await setup();
	try {
		await prepare(s.session, "one");
		const ownerFile = join(s.session.directory, "writer.lock", "owner.json"), owner = JSON.parse(await readFile(ownerFile, "utf8"));
		await writeFile(ownerFile, JSON.stringify({ ...owner, pid: spawnSync(process.execPath, ["-e", "0"]).pid! }));
		const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await assert.rejects(other.assertResumable(), /SESSION_BLOCKED/);
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});
