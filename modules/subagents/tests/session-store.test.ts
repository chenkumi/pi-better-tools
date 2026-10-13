import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, writeFile, readFile, rm, stat, appendFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import test from "node:test";
import { ManagedSession, ConversationDigest, canonicalCwd, snapshotConfig, validateConfig, MAX_METADATA_BYTES } from "../extensions/subagent/session-store.ts";
import { normalizeDispatch } from "../extensions/subagent/index.ts";
import { buildSubagentPiArgs } from "../extensions/subagent/child-args.ts";
import { SubsessionWriter, userRecords, callAlias, MAX_PENDING_LOG_BYTES } from "../extensions/subagent/subsession-log.ts";
import { compactResult, emptyUsage, withLogPath } from "../extensions/subagent/result.ts";

const active = () => true;
async function setup() {
	const temp = await mkdtemp(join(tmpdir(), "pi-managed-unit-")), root = join(temp, "managed"), cwd = await canonicalCwd(temp);
	const filePath = join(temp, "agent.md"); await writeFile(filePath, "source");
	const agent = { name: "worker", description: "test", source: "bundled" as const, filePath, systemPrompt: "test" };
	const config = { ...await snapshotConfig(agent, "user", cwd, "offline/model", "off", false), childTrusted: false };
	const owner = { parentSessionId: "parent", parentCwd: cwd };
	const session = await ManagedSession.allocate(root, owner, config);
	assert.match(session.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	return { temp, root, cwd, agent, config, owner, session };
}
async function prepare(session: ManagedSession, key: string, existing = false) {
	const taskId = ulid().toUpperCase(); await session.acquire(taskId);
	if (existing) await session.validateCheckpoint();
	await session.begin(taskId, key, "task", active);
	const file = join(session.directory, "pi", "native.jsonl"), start = session.manifest.checkpoint?.leafId ?? "";
	let leaf = start;
	const entry = (type: string, extra: any) => { const id = ulid().toUpperCase(); const e = { type, id, parentId: leaf || null, timestamp: new Date().toISOString(), ...extra }; leaf = id; return e; };
	const user = { role: "user", content: "task", timestamp: 1 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 2 };
	const entries = existing ? [] : [{ type: "session", version: 3, id: session.id, cwd: session.manifest.config.cwd }, entry("model_change", { provider: "offline", modelId: "model" }), entry("thinking_level_change", { thinkingLevel: "off" })];
	entries.push(entry("message", { message: user }), entry("message", { message: assistant }));
	await appendFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const segment = join(session.runDir, "transcript.jsonl"); await writeFile(segment, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), content: "task" }) + "\n");
	const digest = new ConversationDigest(); digest.add(user); digest.add(assistant);
	return { file, segment, digest, taskId };
}

for (const id of ["01m45czjs2j8x53wc4ecpyjge4", "12345678-1234-1234-1234-123456789abc"]) {
	test(`legacy session identity remains unchanged through resolve and commit: ${id}`, async () => {
		const s = await setup();
		try {
			const directory = join(s.root, id);
			await fs.promises.rename(s.session.directory, directory);
			await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...s.session.manifest, id }));
			const legacy = await ManagedSession.resolve(s.root, id, s.owner);
			assert.equal(legacy.id, id);
			const run = await prepare(legacy, "legacy");
			await legacy.commit(run.segment, run.digest, {}, active); await legacy.release();
			const resumed = await ManagedSession.resolve(s.root, id, s.owner);
			await resumed.assertResumable(); await resumed.validateCheckpoint();
			assert.equal(resumed.id, id);
		} finally { await rm(s.temp, { recursive: true, force: true }); }
	});
}

test("API-01 normalizes exactly three create modes and rejects conflicts before I/O", () => {
	for (const [params, mode] of [[{ agent: "worker", task: "work" }, "single"], [{ tasks: [{ agent: "worker", task: "work" }] }, "parallel"], [{ chain: [{ agent: "worker", task: "work" }] }, "chain"]] as const) assert.equal(normalizeDispatch(params), mode);
	assert.throws(() => normalizeDispatch({ resume: ulid().toUpperCase(), task: "decision" }), /resume was removed.*subagent_message/);
	for (const key of ["agent", "tasks", "chain", "resumable", "provider", "model", "thinkingLevel", "cwd", "agentScope", "confirmProjectAgents"]) assert.throws(() => normalizeDispatch({ resume: ulid().toUpperCase(), task: "x", [key]: false }), /INVALID_DISPATCH/);
	for (const params of [{}, { tasks: [] }, { agent: "worker", task: " " }, { agent: "worker", task: "x", chain: [] }, { tasks: [{ resume: ulid().toUpperCase(), task: "x" }] }, { chain: [{ agent: "worker", task: "x", resumable: true }] }]) assert.throws(() => normalizeDispatch(params), /INVALID_DISPATCH/);
});
test("ARG-01 preserves exclude/@file for managed creation and continuation only", () => {
	for (const persistence of [{ kind: "new", sessionDir: "/managed/pi", sessionId: ulid().toUpperCase() }, { kind: "resume", sessionDir: "/managed/pi", sessionFile: "/managed/pi/exact.jsonl" }] as const) {
		const args = buildSubagentPiArgs({ persistence, taskPath: "/task", model: "provider/model", thinkingLevel: "high" });
		assert.equal(args.at(-1), "@/task"); assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent,subagent_status,subagent_cancel,subagent_message,fork,fork_status,fork_cancel");
		assert.equal(args.includes("--no-session"), false);
		assert.equal(args.includes("--session-id"), persistence.kind === "new"); assert.equal(args.includes("--session"), persistence.kind === "resume");
		for (const arg of ["--continue", "--resume", "--fork", "--approve"]) assert.equal(args.includes(arg), false);
	}
});
test("API-03 compact result and visible parent text retain continuation identity", () => {
	const id = ulid().toUpperCase(), result = compactResult({ taskId: ulid().toUpperCase(), agent: "worker", agentSource: "bundled", task: "x", status: "completed", exitCode: 0, output: "done", usage: emptyUsage(), subagentSessionId: id, canResume: true });
	assert.equal(result.subagentSessionId, id); assert.match(withLogPath(result), new RegExp(id));
});
test("VIEW-05 user chunks are bounded, lossless, explicit and surrogate-safe", async () => {
	const s = await setup();
	try {
		for (const content of ["a".repeat(1024 * 1024), "\u0001".repeat(1024 * 1024), "x".repeat(128 * 1024 - 1) + "🙂".repeat(300000) + "\n\u2028\u2029"]) {
			const writer = await SubsessionWriter.create({ formatVersion: 2, rootDir: s.temp, parentSessionId: "../parent", parentToolCallId: "c", agent: "worker", agentSource: "bundled", task: content, cwd: s.cwd });
			let count = 0;
			for (const record of userRecords(content, writer.taskId, 0, 1)) {
				assert.ok(Buffer.byteLength(JSON.stringify(record) + "\n") <= MAX_PENDING_LOG_BYTES);
				const a = writer.tryAppend(record); assert.equal(a.status, "accepted"); if (a.status === "accepted") assert.deepEqual(await a.completion, {}); count++;
			}
			const result = await writer.finalize({ status: "completed", exitCode: 0, usage: emptyUsage() });
			const records = (await readFile(result.logPath!, "utf8")).trim().split("\n").map(JSON.parse);
			assert.equal(records.map((r) => r.content).join(""), content); assert.ok(count > 1);
			assert.ok(records.every((r, i) => r.type === "user" && r.part === i && r.messageId === `${writer.taskId}:user:0` && r.last === (i === records.length - 1)));
			assert.ok(writer.getPendingStats().peakBytes <= MAX_PENDING_LOG_BYTES);
		}
		assert.notEqual(callAlias("one", "same"), callAlias("two", "same"));
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});
test("STORE/COMMIT durable resolve, append only, duplicate preserves ready", async () => {
	const s = await setup();
	try {
		const first = await prepare(s.session, "call-one"); await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
		const before = await readFile(s.session.logPath);
		const resumed = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		const second = await prepare(resumed, "call-two", true); await resumed.commit(second.segment, second.digest, {}, active); await resumed.release();
		const after = await readFile(resumed.logPath); assert.ok(after.length > before.length); assert.deepEqual(after.subarray(0, before.length), before);
		const duplicate = await ManagedSession.resolve(s.root, resumed.id, s.owner), taskId = ulid().toUpperCase(); await duplicate.acquire(taskId); await duplicate.validateCheckpoint();
		await assert.rejects(duplicate.begin(taskId, "call-two", "intentional duplicate", active), /DUPLICATE_DISPATCH/);
		await duplicate.blocked("DUPLICATE_DISPATCH", {}, active); await duplicate.release();
		assert.equal(JSON.parse(await readFile(join(resumed.directory, "manifest.json"), "utf8")).state, "ready");
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});
test("foreign lock owner rejects commit and blocked publication before writes", async () => {
	const s = await setup();
	try {
		const run = await prepare(s.session, "one");
		const manifest = await readFile(join(s.session.directory, "manifest.json"));
		const file = join(s.session.directory, "writer.lock", "owner.json"), owner = JSON.parse(await readFile(file, "utf8"));
		await writeFile(file, JSON.stringify({ ...owner, nonce: "foreign" }));
		await assert.rejects(s.session.commit(run.segment, run.digest, {}, active), /ownership changed/);
		await assert.rejects(s.session.blocked("COMMIT_FAILED", {}, active), /ownership changed/);
		assert.deepEqual(await readFile(join(s.session.directory, "manifest.json")), manifest);
		await assert.rejects(stat(s.session.logPath), { code: "ENOENT" });
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

test("R7 failed owner publish releases its settled initialization ownership", async (t) => {
	const s = await setup();
	const rename = fs.promises.rename.bind(fs.promises);
	let injected = false;
	t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
		if (!injected && String(to) === join(s.session.directory, "writer.lock", "owner.json")) {
			injected = true; throw Object.assign(new Error("owner publish EIO"), { code: "EIO" });
		}
		return rename(from, to);
	});
	try {
		await assert.rejects(s.session.acquire(ulid().toUpperCase()), /owner publish EIO/);
		assert.equal(injected, true);
		await assert.rejects(stat(join(s.session.directory, "writer.lock")), { code: "ENOENT" });
		const next = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await next.acquire(ulid().toUpperCase()); await next.release();
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

for (const fault of ["cleanup", "foreign-owner", "close"] as const) {
	test(`R7 initialization fails closed with honest retained ownership: ${fault}`, async (t) => {
		const s = await setup(), lockDir = join(s.session.directory, "writer.lock");
		const rename = fs.promises.rename.bind(fs.promises), remove = fs.promises.rm.bind(fs.promises), open = fs.promises.open.bind(fs.promises);
		let retainedHandle: fs.promises.FileHandle | undefined;
		const registry = (globalThis as any)[Symbol.for("pi-better-tools.subagents.live-writer-locks")] as Set<string>;
		const before = new Set(registry);
		try {
			if (fault === "close") t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
				const h = await open(...args);
				if (String(args[0]).includes("writer.lock") && String(args[0]).endsWith(".partial")) {
					retainedHandle = h; t.mock.method(h, "close", async () => { throw new Error("owned metadata close EIO"); });
				}
				return h;
			});
			else t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
				if (String(to) === join(lockDir, "owner.json")) {
					if (fault === "foreign-owner") await writeFile(to, JSON.stringify({ nonce: "foreign" }));
					throw new Error("owner publish EIO");
				}
				return rename(from, to);
			});
			if (fault === "cleanup") t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof remove>) => {
				if (String(args[0]) === lockDir) throw new Error("owned cleanup EACCES");
				return remove(...args);
			});
			await assert.rejects(s.session.acquire(ulid().toUpperCase()), fault === "close" ? /Metadata writer close failed/ : /cleanup unconfirmed/);
			await stat(lockDir);
			assert.equal(registry.size, before.size + 1, "unknown cleanup must retain its live owner");
			if (fault === "foreign-owner") assert.equal(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")).nonce, "foreign");
		} finally {
			t.mock.restoreAll(); if (retainedHandle) await retainedHandle.close();
			await rm(s.temp, { recursive: true, force: true });
			for (const nonce of registry) if (!before.has(nonce)) registry.delete(nonce); // Test owns these fixtures; not production cleanup.
		}
	});
}

test("C2 recovered manifest close failure preserves diagnostic and actual writer ownership", async (t) => {
	const s = await setup();
	const registry = (globalThis as any)[Symbol.for("pi-better-tools.subagents.live-writer-locks")] as Set<string>;
	const before = new Set(registry);
	let retainedHandle: fs.promises.FileHandle | undefined;
	let closeAttempts = 0;
	try {
		const first = await prepare(s.session, "verified-checkpoint");
		await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
		const lockDir = join(s.session.directory, "writer.lock");
		await mkdir(lockDir); await writeFile(join(lockDir, "owner.json"), JSON.stringify({ nonce: "orphan", pid: process.pid }));
		const recovered = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		const open = fs.promises.open.bind(fs.promises);
		t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
			const h = await open(...args);
			if (String(args[0]).startsWith(join(s.session.directory, "manifest.json.")) && String(args[0]).endsWith(".partial")) {
				retainedHandle = h;
				t.mock.method(h, "close", async () => { closeAttempts++; throw Object.assign(new Error("recovered manifest close EIO"), { code: "EIO" }); });
			}
			return h;
		});
		const error = await recovered.acquire(ulid().toUpperCase()).then(() => undefined, error => error);
		assert.equal(closeAttempts, 1, "fault must target actual recovery manifest handle, not owner publish");
		assert.ok(retainedHandle); await retainedHandle.stat(); // Still genuinely open, not a fake close acknowledgement.
		const ownerText = await readFile(join(lockDir, "owner.json"), "utf8").catch(error => {
			if (error.code === "ENOENT") return undefined; throw error;
		});
		t.diagnostic(JSON.stringify({ handleStillOpen: true, closeAttempts, writerOwnerPresent: ownerText !== undefined,
			retainedNonces: [...registry].filter(nonce => !before.has(nonce)).length, error: String(error) }));
		assert.match(String(error), /Metadata writer close failed.*recovered manifest close EIO/);
		assert.equal(error.cleanupUnsafe, true);
		const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"));
		assert.notEqual(owner.nonce, "orphan"); assert.equal(registry.has(owner.nonce), true);
		const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
		await assert.rejects(other.acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
		assert.equal(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")).nonce, owner.nonce);
	} finally {
		t.mock.restoreAll(); if (retainedHandle) await retainedHandle.close(); // First real close is owned teardown.
		await rm(s.temp, { recursive: true, force: true });
		for (const nonce of registry) if (!before.has(nonce)) registry.delete(nonce);
	}
});

for (const fault of ["writeFile", "sync"] as const) {
	for (const closeFails of [false, true]) {
		test(`metadata ${fault} failure preserves close priority and prevents publish: closeFails=${closeFails}`, async (t) => {
			const s = await setup(), lockDir = join(s.session.directory, "writer.lock");
			const registry = (globalThis as any)[Symbol.for("pi-better-tools.subagents.live-writer-locks")] as Set<string>;
			const before = new Set(registry), open = fs.promises.open.bind(fs.promises), rename = fs.promises.rename.bind(fs.promises);
			const primary = new Error(`metadata ${fault} failed`), closing = new Error("metadata close failed");
			let retainedHandle: fs.promises.FileHandle | undefined, closes = 0, published = 0;
			t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
				const handle = await open(...args);
				if (String(args[0]).startsWith(join(lockDir, "owner.json.")) && String(args[0]).endsWith(".partial")) {
					retainedHandle = handle;
					t.mock.method(handle, fault, async () => { throw primary; });
					const close = handle.close.bind(handle);
					t.mock.method(handle, "close", async () => { closes++; if (closeFails) throw closing; await close(); });
				}
				return handle;
			});
			t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
				if (String(to) === join(lockDir, "owner.json")) published++;
				return rename(from, to);
			});
			try {
				const error = await s.session.acquire(ulid().toUpperCase()).then(() => assert.fail("failed metadata must reject acquisition"), error => error);
				assert.equal(closes, 1); assert.equal(published, 0);
				if (closeFails) {
					assert.equal(error.cleanupUnsafe, true); assert.equal(error.cause, closing);
					assert.match(error.message, /Metadata writer close failed/);
					await retainedHandle!.stat(); await stat(lockDir);
					assert.equal(registry.size, before.size + 1);
				} else {
					assert.equal(error, primary);
					await assert.rejects(stat(lockDir), { code: "ENOENT" });
					assert.equal(registry.size, before.size);
				}
				await assert.rejects(stat(join(s.session.directory, "writer.acquire")), { code: "ENOENT" });
			} finally {
				t.mock.restoreAll(); if (closeFails) await retainedHandle?.close();
				await rm(s.temp, { recursive: true, force: true });
				for (const nonce of registry) if (!before.has(nonce)) registry.delete(nonce);
			}
		});
	}
}

for (const foreignOwner of [false, true]) {
	test(`W1 fence cleanup failure preserves owner publish EIO and EACCES: foreign=${foreignOwner}`, async (t) => {
		const s = await setup(), lockDir = join(s.session.directory, "writer.lock"), fence = join(s.session.directory, "writer.acquire");
		const registry = (globalThis as any)[Symbol.for("pi-better-tools.subagents.live-writer-locks")] as Set<string>;
		const before = new Set(registry);
		const primary = Object.assign(new Error("owner publish EIO"), { code: "EIO" });
		const cleanup = Object.assign(new Error("fence rmdir EACCES"), { code: "EACCES" });
		const rename = fs.promises.rename.bind(fs.promises), rmdir = fs.promises.rmdir.bind(fs.promises);
		let injected = false;
		t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
			if (String(to) === join(lockDir, "owner.json")) {
				injected = true;
				if (foreignOwner) await writeFile(to, JSON.stringify({ nonce: "foreign-owner" }));
				throw primary;
			}
			return rename(from, to);
		});
		t.mock.method(fs.promises, "rmdir", async (...args: Parameters<typeof rmdir>) => {
			if (String(args[0]) === fence) throw cleanup;
			return rmdir(...args);
		});
		try {
			const error = await s.session.acquire(ulid().toUpperCase()).then(() => undefined, error => error);
			assert.equal(injected, true);
			assert.match(String(error), /owner publish EIO/, "fence failure must not hide the primary initialization diagnostic");
			assert.match(String(error), /fence rmdir EACCES/);
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors[1], cleanup);
			if (!foreignOwner) assert.equal(error.errors[0], primary);
			else {
				assert.ok(error.errors[0] instanceof AggregateError);
				assert.equal(error.errors[0].errors[0], primary);
				assert.equal(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")).nonce, "foreign-owner");
			}
			await stat(fence);
			const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
			await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
			await assert.rejects(other.acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
		} finally {
			t.mock.restoreAll(); await rm(s.temp, { recursive: true, force: true });
			for (const nonce of registry) if (!before.has(nonce)) registry.delete(nonce);
		}
	});
}

test("W1 successful initialization with failed fence removal retains writer and refuses new leases", async (t) => {
	const s = await setup(), fence = join(s.session.directory, "writer.acquire");
	const registry = (globalThis as any)[Symbol.for("pi-better-tools.subagents.live-writer-locks")] as Set<string>;
	const before = new Set(registry), rmdir = fs.promises.rmdir.bind(fs.promises);
	const cleanup = Object.assign(new Error("fence cleanup EACCES after initialization"), { code: "EACCES" });
	t.mock.method(fs.promises, "rmdir", async (...args: Parameters<typeof rmdir>) => {
		if (String(args[0]) === fence) throw cleanup; return rmdir(...args);
	});
	try {
		const error = await s.session.acquire(ulid().toUpperCase()).then(() => undefined, error => error);
		assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [cleanup]);
		assert.equal(error.cleanupUnsafe, true); assert.match(error.message, /cleanup unconfirmed.*ownership may remain held/);
		const owner = JSON.parse(await readFile(join(s.session.directory, "writer.lock", "owner.json"), "utf8"));
		assert.equal(registry.has(owner.nonce), true); await stat(fence);
		const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
		await assert.rejects(other.acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
	} finally {
		t.mock.restoreAll(); await s.session.release(); await rm(s.temp, { recursive: true, force: true });
		for (const nonce of registry) if (!before.has(nonce)) registry.delete(nonce);
	}
});

test("acquisition fence preserves successful values and falsy operation/cleanup failures", async (t) => {
	const s = await setup(), fence = join(s.session.directory, "writer.acquire");
	const rmdir = fs.promises.rmdir.bind(fs.promises);
	let cleanupFails = false;
	t.mock.method(fs.promises, "rmdir", async (...args: Parameters<typeof rmdir>) => {
		if (cleanupFails && String(args[0]) === fence) throw undefined;
		return rmdir(...args);
	});
	// Exercise generic arbitration without publishing a writer or changing the public API.
	const run = (operation: () => Promise<unknown>) => (s.session as any).acquisitionFence(operation);
	try {
		for (const value of [undefined, { literal: "same object" }]) assert.equal(await run(async () => value), value);
		for (const primary of [undefined, null, false, 0]) {
			for (cleanupFails of [false, true]) {
				const result = await run(async () => { throw primary; }).then(
					() => ({ failed: false, error: undefined }), (error: any) => ({ failed: true, error }));
				assert.equal(result.failed, true);
				if (cleanupFails) {
					assert.ok(result.error instanceof AggregateError);
					assert.deepEqual(result.error.errors, [primary, undefined]); assert.equal(result.error.cleanupUnsafe, true);
					await stat(fence); await rm(fence, { recursive: true });
				} else {
					assert.equal(result.error, primary); await assert.rejects(stat(fence), { code: "ENOENT" });
				}
			}
		}
	} finally { t.mock.restoreAll(); await rm(s.temp, { recursive: true, force: true }); }
});

test("R6 orphan election fence blocks both fresh writer and query creation", async () => {
	const s = await setup();
	try {
		await mkdir(join(s.session.directory, "writer.acquire"));
		await assert.rejects(s.session.acquire(ulid().toUpperCase()), /SESSION_BUSY.*manual inspection/);
		await assert.rejects(s.session.acquireQueryLease(ulid().toUpperCase()), /SESSION_BUSY/);
		await assert.rejects(stat(join(s.session.directory, "writer.lock")), { code: "ENOENT" });
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});

test("R6 stale contender cannot replace an acquired live writer", async (t) => {
	const s = await setup();
	let unblock!: () => void, reached!: () => void;
	const barrier = new Promise<void>(r => { unblock = r; });
	const entered = new Promise<void>(r => { reached = r; });
	let b: ManagedSession | undefined;
	try {
		const first = await prepare(s.session, "checkpoint");
		await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
		const lockDir = join(s.session.directory, "writer.lock");
		await mkdir(lockDir); await writeFile(join(lockDir, "owner.json"), JSON.stringify({ nonce: "orphan", pid: process.pid }));
		b = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		const a = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		const rename = fs.promises.rename.bind(fs.promises); let paused = false;
		t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
			if (!paused && String(from) === lockDir) { paused = true; reached(); await barrier; }
			return rename(from, to);
		});
		const acquiringB = b.acquire(ulid().toUpperCase());
		await entered;
		let aOwned = false;
		try { await a.acquire(ulid().toUpperCase()); aOwned = true; }
		catch (error) { assert.match(String(error), /SESSION_BUSY/); }
		const ownerBefore = aOwned ? await readFile(join(lockDir, "owner.json")) : undefined;
		if (aOwned) await appendFile(first.file, "live writer bytes\n");
		unblock(); await acquiringB;
		if (aOwned) {
			assert.deepEqual(await readFile(join(lockDir, "owner.json")), ownerBefore, "B replaced A's live nonce");
			assert.match(await readFile(first.file, "utf8"), /live writer bytes/);
			await a.release();
		} else { await b.release(); await a.acquire(ulid().toUpperCase()); await a.release(); }
	} finally { unblock(); await rm(s.temp, { recursive: true, force: true }); }
});

test("LOCK-01/02 exclusive filesystem lock and nonce owner", async () => {
	const s = await setup();
	try {
		await s.session.acquire(ulid().toUpperCase());
		const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await assert.rejects(other.acquire(ulid().toUpperCase()), /SESSION_BUSY/);
		await assert.rejects(other.assertResumable(), /SESSION_BUSY/);
		await other.release(); await stat(join(s.session.directory, "writer.lock"));
		const lock = join(s.session.directory, "writer.lock", "owner.json"); const owner = JSON.parse(await readFile(lock, "utf8"));
		await writeFile(lock, JSON.stringify({ ...owner, nonce: "foreign" })); await assert.rejects(s.session.release(), /ownership changed/);
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});
test("LOCK-03 same-pid lock without a registered in-process owner is stale; a live owner stays busy", async () => {
	const s = await setup();
	try {
		await s.session.acquire(ulid().toUpperCase());
		const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await assert.rejects(other.assertResumable(), /SESSION_BUSY/);
		await s.session.release();
		// An orphaned lock file written by this pid whose nonce this process never registered (abandoned owner).
		const lockDir = join(s.session.directory, "writer.lock");
		await mkdir(lockDir);
		await writeFile(join(lockDir, "owner.json"), JSON.stringify({ nonce: "orphan", taskId: ulid().toUpperCase(), pid: process.pid, createdAt: new Date().toISOString() }));
		await assert.rejects(other.assertResumable(), /SESSION_BLOCKED/, "stale lock is recognised (no checkpoint, so blocked rather than busy)");
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});
for (const kind of ["model-change", "owner", "partial", "traversal", "foreign-segment", "native-edit", "prefix-edit", "wrong-id", "truncated", "unsupported", "symlink", "metadata-size", "source-change", "trust-change", "cwd-missing"] as const) {
	test(`STORE rejection: ${kind}`, async () => {
		const s = await setup();
		try {
			if (kind === "owner") await assert.rejects(ManagedSession.resolve(s.root, s.session.id, { ...s.owner, parentSessionId: "foreign" }), /OWNER_MISMATCH/);
			else if (["partial", "traversal"].includes(kind)) await assert.rejects(ManagedSession.resolve(s.root, kind === "partial" ? s.session.id.slice(0, 8) : "../x", s.owner), /INVALID_DISPATCH/);
			else if (kind === "source-change") { await writeFile(s.agent.filePath, "changed"); await assert.rejects(validateConfig(s.config, s.agent, false), /CONFIG_CHANGED/); }
			else if (kind === "trust-change") await assert.rejects(validateConfig(s.config, s.agent, true), /TRUST_REQUIRED/);
			else if (kind === "cwd-missing") await assert.rejects(canonicalCwd(join(s.temp, "missing")), /CWD_UNAVAILABLE/);
			else if (kind === "metadata-size") { await writeFile(join(s.session.directory, "manifest.json"), "x".repeat(MAX_METADATA_BYTES + 1)); await assert.rejects(ManagedSession.resolve(s.root, s.session.id, s.owner), /METADATA_UNSUPPORTED/); }
			else {
				const first = await prepare(s.session, "one");
				if (kind === "model-change") {
					const text = await readFile(first.file, "utf8"); await writeFile(first.file, text.replace('"modelId":"model"', '"modelId":"alternate"'));
					await assert.rejects(s.session.commit(first.segment, first.digest, {}, active), /CONFIG_CHANGED/); return;
				}
				if (kind === "foreign-segment") { await assert.rejects(s.session.commit(join(s.temp, "other"), first.digest, {}, active), /current run/); return; }
				if (kind === "wrong-id") { const text = await readFile(first.file, "utf8"); await writeFile(first.file, text.replace(s.session.id, ulid().toUpperCase())); await assert.rejects(s.session.commit(first.segment, first.digest, {}, active), /header identity/); return; }
				if (kind === "truncated") { await appendFile(first.file, "{"); await assert.rejects(s.session.commit(first.segment, first.digest, {}, active), /incomplete/); return; }
				await s.session.commit(first.segment, first.digest, {}, active); await s.session.release();
				const resume = await ManagedSession.resolve(s.root, s.session.id, s.owner);
				if (kind === "unsupported") { const file = join(resume.directory, "manifest.json"), m = JSON.parse(await readFile(file, "utf8")); m.version = 99; await writeFile(file, JSON.stringify(m)); await assert.rejects(ManagedSession.resolve(s.root, resume.id, s.owner), /METADATA_UNSUPPORTED/); }
				if (kind === "symlink") { const pi = join(resume.directory, "pi"), outside = join(s.temp, "outside"); await mkdir(outside); await rm(pi, { recursive: true }); await symlink(outside, pi, process.platform === "win32" ? "junction" : "dir"); await assert.rejects(resume.validateCheckpoint(), /symlink/); }
				if (kind === "native-edit") { await appendFile(first.file, "\n"); await assert.rejects(resume.validateCheckpoint(), /CHECKPOINT_MISMATCH/); }
				if (kind === "prefix-edit") {
					const second = await prepare(resume, "two", true); const text = await readFile(first.file, "utf8"); await writeFile(first.file, text.replace('"task"', '"edit"'));
					await assert.rejects(resume.commit(second.segment, second.digest, {}, active), /prefix\/leaf changed/);
				}
			}
		} finally { await rm(s.temp, { recursive: true, force: true }); }
	});
}
test("COMMIT-01 initial intent failure retains lock and does not spawn or publish ready", async (t) => {
	const s = await setup();
	try {
		const id = ulid().toUpperCase(); await s.session.acquire(id);
		const rename = fs.promises.rename.bind(fs.promises);
		t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
			if (String(to).endsWith("run.json")) throw new Error("injected initial intent");
			return rename(from, to);
		});
		await assert.rejects(s.session.begin(id, "one", "task", active), /initial intent/);
		assert.equal(JSON.parse(await readFile(join(s.session.directory, "manifest.json"), "utf8")).state, "new");
		await stat(join(s.session.directory, "writer.lock"));
		assert.equal((await fs.promises.readdir(join(s.session.directory, "pi"))).length, 0);
		assert.ok((await fs.promises.readdir(s.session.runDir)).some(n => n.endsWith(".partial")));
	} finally { await rm(s.temp, { recursive: true, force: true }); }
});
for (const phase of ["run-metadata", "committing", "append", "ready"]) {
	test(`COMMIT-01 injected failure retains evidence and never publishes ready: ${phase}`, async (t) => {
		const s = await setup();
		try {
			const prepared = await prepare(s.session, "one");
			const rename = fs.promises.rename.bind(fs.promises), open = fs.promises.open.bind(fs.promises);
			t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
				const text = String(from).includes("manifest.json") ? await readFile(from, "utf8") : "";
				if ((phase === "committing" && text.includes('"committing"')) || (phase === "ready" && text.includes('"ready"')) || (phase === "run-metadata" && String(to).endsWith("run.json"))) throw new Error(`injected ${phase}`);
				return rename(from, to);
			});
			if (phase === "append") t.mock.method(fs.promises, "open", async (...args: any[]) => {
				const h = await open(...args as Parameters<typeof open>); if (String(args[0]) === s.session.logPath) t.mock.method(h, "writeFile", async () => { throw new Error("injected append"); }); return h;
			});
			await assert.rejects(s.session.commit(prepared.segment, prepared.digest, {}, active), /injected/);
			assert.notEqual(JSON.parse(await readFile(join(s.session.directory, "manifest.json"), "utf8")).state, "ready");
			await stat(prepared.segment); await stat(prepared.file); await stat(join(s.session.directory, "writer.lock"));
		} finally { await rm(s.temp, { recursive: true, force: true }); }
	});
}
