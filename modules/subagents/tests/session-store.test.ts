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
	return { temp, root, cwd, agent, config, owner, session };
}
async function prepare(session: ManagedSession, key: string, existing = false) {
	const taskId = ulid().toLowerCase(); await session.acquire(taskId);
	if (existing) await session.validateCheckpoint();
	await session.begin(taskId, key, "task", active);
	const file = join(session.directory, "pi", "native.jsonl"), start = session.manifest.checkpoint?.leafId ?? "";
	let leaf = start;
	const entry = (type: string, extra: any) => { const id = ulid().toLowerCase(); const e = { type, id, parentId: leaf || null, timestamp: new Date().toISOString(), ...extra }; leaf = id; return e; };
	const user = { role: "user", content: "task", timestamp: 1 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 2 };
	const entries = existing ? [] : [{ type: "session", version: 3, id: session.id, cwd: session.manifest.config.cwd }, entry("model_change", { provider: "offline", modelId: "model" }), entry("thinking_level_change", { thinkingLevel: "off" })];
	entries.push(entry("message", { message: user }), entry("message", { message: assistant }));
	await appendFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const segment = join(session.runDir, "transcript.jsonl"); await writeFile(segment, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), content: "task" }) + "\n");
	const digest = new ConversationDigest(); digest.add(user); digest.add(assistant);
	return { file, segment, digest, taskId };
}

test("API-01 normalizes exactly four modes and rejects conflicts before I/O", () => {
	for (const [params, mode] of [[{ agent: "worker", task: "work" }, "single"], [{ tasks: [{ agent: "worker", task: "work" }] }, "parallel"], [{ chain: [{ agent: "worker", task: "work" }] }, "chain"], [{ resume: ulid().toLowerCase(), task: "decision" }, "resume"]] as const) assert.equal(normalizeDispatch(params), mode);
	for (const key of ["agent", "tasks", "chain", "resumable", "provider", "model", "thinkingLevel", "cwd", "agentScope", "confirmProjectAgents"]) assert.throws(() => normalizeDispatch({ resume: ulid().toLowerCase(), task: "x", [key]: false }), /INVALID_DISPATCH/);
	for (const params of [{}, { tasks: [] }, { agent: "worker", task: " " }, { agent: "worker", task: "x", chain: [] }, { tasks: [{ resume: ulid().toLowerCase(), task: "x" }] }, { chain: [{ agent: "worker", task: "x", resumable: true }] }]) assert.throws(() => normalizeDispatch(params), /INVALID_DISPATCH/);
});
test("ARG-01 preserves exclude/@file for managed creation and continuation only", () => {
	for (const persistence of [{ kind: "new", sessionDir: "/managed/pi", sessionId: ulid().toLowerCase() }, { kind: "resume", sessionDir: "/managed/pi", sessionFile: "/managed/pi/exact.jsonl" }] as const) {
		const args = buildSubagentPiArgs({ persistence, taskPath: "/task", model: "provider/model", thinkingLevel: "high" });
		assert.equal(args.at(-1), "@/task"); assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent,subagent_status,subagent_cancel,subagent_message");
		assert.equal(args.includes("--no-session"), false);
		assert.equal(args.includes("--session-id"), persistence.kind === "new"); assert.equal(args.includes("--session"), persistence.kind === "resume");
		for (const arg of ["--continue", "--resume", "--fork", "--approve"]) assert.equal(args.includes(arg), false);
	}
});
test("API-03 compact result and visible parent text retain continuation identity", () => {
	const id = ulid().toLowerCase(), result = compactResult({ taskId: ulid().toLowerCase(), agent: "worker", agentSource: "bundled", task: "x", status: "completed", exitCode: 0, output: "done", usage: emptyUsage(), subagentSessionId: id, canResume: true });
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
		const duplicate = await ManagedSession.resolve(s.root, resumed.id, s.owner), taskId = ulid().toLowerCase(); await duplicate.acquire(taskId); await duplicate.validateCheckpoint();
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

test("LOCK-01/02 exclusive filesystem lock and nonce owner", async () => {
	const s = await setup();
	try {
		await s.session.acquire(ulid().toLowerCase());
		const other = await ManagedSession.resolve(s.root, s.session.id, s.owner);
		await assert.rejects(other.acquire(ulid().toLowerCase()), /SESSION_BUSY/);
		await assert.rejects(other.assertResumable(), /SESSION_BUSY/);
		await other.release(); await stat(join(s.session.directory, "writer.lock"));
		const lock = join(s.session.directory, "writer.lock", "owner.json"); const owner = JSON.parse(await readFile(lock, "utf8"));
		await writeFile(lock, JSON.stringify({ ...owner, nonce: "foreign" })); await assert.rejects(s.session.release(), /ownership changed/);
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
				if (kind === "wrong-id") { const text = await readFile(first.file, "utf8"); await writeFile(first.file, text.replace(s.session.id, ulid().toLowerCase())); await assert.rejects(s.session.commit(first.segment, first.digest, {}, active), /header identity/); return; }
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
		const id = ulid().toLowerCase(); await s.session.acquire(id);
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
