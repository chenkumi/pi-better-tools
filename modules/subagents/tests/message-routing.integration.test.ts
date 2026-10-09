import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import { Check } from "typebox/value";
import registerSubagent from "../extensions/subagent/index.ts";
import { BackgroundJobs } from "../extensions/subagent/background.ts";
import { ManagedSession } from "../extensions/subagent/session-store.ts";
import { reserveContinuation } from "../extensions/subagent/message-reservation.ts";
import { messageHarness } from "./fixtures/message-harness.ts";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-message-route-"))), tools = new Map<string, any>(), handlers = new Map<string, Function>();
	const messages = messageHarness(); let children = 0;
	registerSubagent({ sendMessage: messages.sendMessage, registerMessageRenderer() {}, registerTool(t: any) { tools.set(t.name, t); }, on(name: string, handler: Function) { handlers.set(name, handler); } } as any, {
		debugLog: false, sessionRootDir: join(root, "managed"), invocation(args) { children++; return { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/managed-native.mjs", import.meta.url)), "normal", ...args] }; },
	});
	const model = { provider: "offline-fixture", id: "model", reasoning: false };
	const ctx: any = { cwd: root, hasUI: false, isProjectTrusted: () => false, model, thinkingLevel: "off", sessionManager: { getSessionId: () => "owner" }, modelRegistry: { find: () => model, getAll: () => [model] } };
	let call = 0;
	const execute = (tool: string, args: any, signal?: AbortSignal, context = ctx) => tools.get(tool).execute(`route-${++call}`, args, signal, undefined, context);
	const manifest = async (id: string) => JSON.parse(await readFile(join(root, "managed", id, "manifest.json"), "utf8"));
	return { root, tools, ctx, execute, manifest, messages, get children() { return children; }, async close() { await handlers.get("session_shutdown")?.({}, ctx); await rm(root, { recursive: true, force: true }); } };
}

test("managed create acceptance has actual distinct identities for single/parallel/chain, no fabricated logs", async () => {
	const f = await fixture();
	try {
		for (const mode of ["single", "parallel", "chain"]) {
			const item = { agent: "worker", task: "literal work" };
			const outcome = await f.execute("subagent", { background: true, ...(mode === "single" ? item : { [mode === "parallel" ? "tasks" : "chain"]: [item, item] }) });
			assert.equal(outcome.isError, undefined); const receipt = outcome.details.background;
			assert.equal(receipt.status, "queued"); assert.equal(receipt.cancelRequested, false);
			assert.equal(new Set(receipt.tasks.map((t: any) => t.subagentSessionId)).size, receipt.tasks.length);
			for (const task of receipt.tasks) {
				assert.match(task.subagentSessionId, /^[0-9A-HJKMNP-TV-Z]{26}$/); await stat(join(f.root, "managed", task.subagentSessionId, "manifest.json"));
				assert.equal(task.logPending, true); assert.equal(task.liveLogPath, undefined); assert.equal(task.finalLogPath, undefined);
			}
			const done = await f.messages.completion(receipt.jobId);
			assert.deepEqual(done.tasks.map((t: any) => t.subagentSessionId), receipt.tasks.map((t: any) => t.subagentSessionId));
			assert.equal(done.status, "completed", JSON.stringify(done));
		}
	} finally { await f.close(); }
});

test("ready messages default to asynchronous resume, preserve literal input and stale parent knowledge across three invocations", async () => {
	const f = await fixture();
	try {
		const initial = await f.execute("subagent", { agent: "worker", task: "first" }); const first = initial.details.results[0], session = first.subagentSessionId;
		const literal = "/skill:do-not-expand\n@not-a-file\n{previous}\u2028literal";
		for (const [index, message] of [literal, "third"].entries()) {
			const accepted = await f.execute("subagent_message", { subagentSessionId: session, message });
			assert.equal(Check(f.tools.get("subagent_message").outputSchema, accepted.structuredContent), true);
			assert.equal(accepted.details.mode, "control"); assert.equal(accepted.details.action, "resume"); assert.equal(accepted.details.status, "accepted");
			assert.equal(accepted.usage, undefined); assert.notEqual(accepted.details.taskId, first.taskId); assert.equal(accepted.details.subagentSessionId, session);
			const done = await f.messages.completion(accepted.details.jobId), result = done.tasks[0].result;
			assert.equal(result.canResume, true); assert.equal(result.subagentSessionId, session);
			assert.equal(JSON.parse(result.output).previousUsers, index + 1);
			const manifest = await f.manifest(session), native = await readFile(join(f.root, "managed", session, manifest.nativeFile), "utf8");
			assert.ok(native.includes(JSON.stringify(`Task: ${message}`)));
		}
		assert.equal(f.children, 3);
	} finally { await f.close(); }
});

test("concurrent ready messages reserve before preflight awaits and only dispatch one child", async t => {
	const f = await fixture(), entered = deferred(), release = deferred();
	try {
		const initial = await f.execute("subagent", { agent: "worker", task: "first" }), session = initial.details.results[0].subagentSessionId;
		const validate = ManagedSession.prototype.validateCheckpoint; let validations = 0;
		t.mock.method(ManagedSession.prototype, "validateCheckpoint", async function(this: ManagedSession) { if (++validations === 1) { entered.resolve(); await release.promise; } return validate.call(this); });
		const first = f.execute("subagent_message", { subagentSessionId: session, message: "second" });
		await entered.promise;
		const second = await f.execute("subagent_message", { subagentSessionId: session, message: "must not dispatch" });
		assert.equal(second.isError, true, "expected refusal preserves the model-side error flag"); assert.equal(second.details.status, "rejected"); assert.equal(second.details.errorCode, "SESSION_BUSY"); assert.equal(second.details.observedState, "busy"); assert.equal(f.children, 1);
		release.resolve(); const accepted = await first;
		assert.equal(accepted.details.action, "resume"); const done = await f.messages.completion(accepted.details.jobId); assert.equal(done.status, "completed"); assert.equal(f.children, 2);
	} finally { release.resolve(); await f.close(); }
});

for (const mode of ["control", "query"]) test(`${mode} rejects foreign ownership before consulting an old-runtime session reservation`, async () => {
	const f = await fixture(); let release: (() => void) | undefined;
	try {
		const initial = await f.execute("subagent", { agent: "worker", task: "first" });
		const session = initial.details.results[0].subagentSessionId;
		release = reserveContinuation(await realpath(join(f.root, "managed")), session);
		const foreign = { ...f.ctx, sessionManager: { getSessionId: () => "foreign" } };
		const outcome = await f.execute("subagent_message", { subagentSessionId: session, mode, message: "must not be reported as ordinary busy" }, undefined, foreign);
		assert.equal(outcome.isError, true); assert.equal(outcome.details.errorCode, "OWNER_MISMATCH");
		assert.equal(outcome.details.status, "rejected"); assert.equal(f.children, 1);
	} finally { release?.(); await f.close(); }
});

for (const mode of ["control", "query"]) for (const failure of ["state", "live-writer", "checkpoint", "trust", "configuration", "model", "owner", "aborted"]) test(`${mode} message safety refusal: ${failure}, no extra child or silent create`, async () => {
	const f = await fixture(); let locked: ManagedSession | undefined;
	try {
		const initial = await f.execute("subagent", { agent: "worker", task: "first" }), first = initial.details.results[0], session = first.subagentSessionId;
		const file = join(f.root, "managed", session, "manifest.json"), manifest = JSON.parse((await readFile(file)).toString());
		let context = f.ctx, signal: AbortSignal | undefined;
		if (failure === "state") { manifest.state = "blocked"; await writeFile(file, JSON.stringify(manifest)); }
		const before = await readFile(file);
		if (failure === "live-writer") { locked = await ManagedSession.resolve(join(f.root, "managed"), session, { parentSessionId: "owner", parentCwd: f.root }); await locked.acquire(ulid().toUpperCase()); }
		if (failure === "checkpoint") await writeFile(join(f.root, "managed", session, manifest.nativeFile), "corrupted native history");
		if (failure === "trust") context = { ...f.ctx, isProjectTrusted: () => true };
		if (failure === "configuration") { manifest.config.sourceSha256 = "0".repeat(64); await writeFile(file, JSON.stringify(manifest)); }
		if (failure === "model") context = { ...f.ctx, modelRegistry: { ...f.ctx.modelRegistry, find: () => undefined } };
		if (failure === "owner") context = { ...f.ctx, sessionManager: { getSessionId: () => "foreign" } };
		if (failure === "aborted") { const controller = new AbortController(); controller.abort(); signal = controller.signal; }
		const outcome = await f.execute("subagent_message", { subagentSessionId: session, message: "refused", ...(mode ? { mode } : {}) }, signal, context);
		assert.equal(outcome.isError, true, "every rejected message preserves the model-side error flag"); assert.equal(outcome.details.status, "rejected"); assert.equal(f.children, 1);
		const expected: Record<string, string> = { state: "SESSION_BLOCKED", "live-writer": "SESSION_BUSY", checkpoint: "CHECKPOINT_MISMATCH", trust: "TRUST_REQUIRED", configuration: "CONFIG_CHANGED", model: "MODEL_UNAVAILABLE", owner: "OWNER_MISMATCH", aborted: "MESSAGE_ABORTED" };
		assert.equal(outcome.details.errorCode, expected[failure]); assert.ok(outcome.details.nextAction); assert.equal(Check(f.tools.get("subagent_message").outputSchema, outcome.structuredContent), true);
		if (!["configuration"].includes(failure)) assert.deepEqual(await readFile(file), before, "preflight rejection is read-only");
	} finally { await locked?.release(); await f.close(); }
});

test("abort at the final acceptance fence rejects resume without a child, releases reservation, and allows a later instruction", async t => {
	const f = await fixture(), controller = new AbortController();
	try {
		const initial = await f.execute("subagent", { agent: "worker", task: "first" }), session = initial.details.results[0].subagentSessionId;
		const submit = BackgroundJobs.prototype.submitManaged;
		t.mock.method(BackgroundJobs.prototype, "submitManaged", function(this: BackgroundJobs, owner: string, cwd: string, epoch: number, agents: string[], prepare: () => Promise<string[]>, run: any, titles: any, beforeAccept: any) {
			return submit.call(this, owner, cwd, epoch, agents, async () => { const ids = await prepare(); controller.abort(); return ids; }, run, titles, beforeAccept);
		});
		const rejected = await f.execute("subagent_message", { subagentSessionId: session, message: "not accepted" }, controller.signal);
		assert.equal(rejected.details.errorCode, "MESSAGE_ABORTED"); assert.equal(rejected.details.status, "rejected"); assert.equal(f.children, 1);
		t.mock.restoreAll();
		const accepted = await f.execute("subagent_message", { subagentSessionId: session, message: "later instruction" });
		assert.equal(accepted.details.status, "accepted"); controller.abort(); // old tool abort cannot own this job
		assert.equal((await f.messages.completion(accepted.details.jobId)).status, "completed"); assert.equal(f.children, 2);
	} finally { t.mock.restoreAll(); await f.close(); }
});

test("removed public APIs reject with migration hints without invoking a child; message titles retain Unicode validation", async () => {
	const f = await fixture();
	try {
		assert.equal(f.tools.get("subagent").parameters.properties.resume, undefined);
		assert.deepEqual(f.tools.get("subagent_message").parameters.required, ["subagentSessionId", "message"]);
		const legacy = await f.execute("subagent", { resume: "id", task: "old" }); assert.equal(legacy.isError, true); assert.match(legacy.content[0].text, /subagent_message/);
		const oldMessage = await f.execute("subagent_message", { jobId: "j", taskId: "t", mode: "control", message: "old" }); assert.equal(oldMessage.isError, true); assert.match(oldMessage.content[0].text, /addressing was removed/);
		for (const title of ["", " ", "e\u0301".repeat(26), "\x1b[2J", 7, null]) assert.equal((await f.execute("subagent_message", { subagentSessionId: "id", message: "work", title })).details.errorCode, "INVALID_MESSAGE");
		assert.equal(f.children, 0);
	} finally { await f.close(); }
});
