import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { publishCapability } from "../../shell-tools/src/monitor-capability.ts";
import { startForkChild, type ForkChildSpec } from "../src/child.ts";
import guard, { CHANNEL, POLL_MS } from "../src/child-guard.ts";
import { FORK_GUARD_ENV, FORK_MARKER_TYPE } from "../src/identity.ts";
import { acceptFork, deps, onSessionStart, onTurnEnd, state, summarize } from "../src/manager.ts";
import { isTerminal, parseRecord } from "../src/store.ts";

// A Fork whose own model call failed cannot progress by itself. Regression: it used to stay silently
// `running` for as long as any nested job kept the session from being quiet.
const SLOT = Symbol.for("pi-better-tools.fork.child-guard.v1"), LOADED = Symbol.for("pi-better-tools.fork.child-guard.loaded.v1");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "fork-blocked-")));
const sessions = join(cwd, "sessions");
mkdirSync(sessions, { recursive: true });
const marker = { type: "custom", customType: FORK_MARKER_TYPE };
const failedAssistant = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "The user has reached their usage limit" } };
const okAssistant = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };

/** Minimal guard host: real handlers, stubbed IPC/exit, injectable session entries and quiet state. */
function guardHarness(entries: unknown[]) {
	delete (globalThis as Record<symbol, unknown>)[SLOT];
	delete (globalThis as Record<symbol, unknown>)[LOADED];
	process.env[FORK_GUARD_ENV] = JSON.stringify({ forkId: "F", sessionId: "S1", cwd, model: "p/m", thinkingLevel: "off", childTrusted: false, tools: ["read"], token: "tok" });
	const handlers = new Map<string, Function>(), sent: any[] = [];
	Object.defineProperty(process, "connected", { value: true, configurable: true });
	(process as any).send = (message: unknown, cb?: () => void) => { sent.push(message); cb?.(); return true; };
	const pi: any = { on: (name: string, handler: Function) => handlers.set(name, handler), getActiveTools: () => ["read"], getThinkingLevel: () => "off" };
	guard(pi);
	const live = { idle: true, pending: false };
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, isIdle: () => live.idle, hasPendingMessages: () => live.pending,
		sessionManager: { getSessionId: () => "S1", getSessionFile: () => "/f.jsonl", getEntries: () => entries } };
	return { handlers, sent, ctx, live, restore: () => { delete (process as any).send; } };
}

test("a failed model call with an unfinished nested job is reported as blocked, not hidden", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	let jobs = 1;
	const revoke = publishCapability("shell_job", { sessionId: "S1", cwd }, 1, () => ({}), () => true, () => jobs);
	const h = guardHarness([marker, failedAssistant]);
	try {
		h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
		h.sent.length = 0;
		h.handlers.get("agent_settled")!({}, h.ctx);
		assert.deepEqual(h.sent.map(m => m.type), ["blocked"], "the truth must not wait for the nested job");
		assert.equal(h.sent[0].reason, "MODEL_ERROR");
		assert.deepEqual(h.sent[0].pending, { shell: 1, subagents: 0 });
		assert.match(h.sent[0].error, /usage limit/);
		assert.equal(h.sent.some(m => m.type === "settled"), false, "blocked never settles and never claims success");

		mock.timers.tick(POLL_MS * 3);
		assert.deepEqual(h.sent.map(m => m.type), ["blocked"], "an unchanged signature is not re-sent");

		jobs = 0;
		mock.timers.tick(POLL_MS);
		assert.deepEqual(h.sent.map(m => m.type), ["blocked", "unblocked"], "progress that is possible again is reported too");
		mock.timers.tick(POLL_MS);
		assert.deepEqual(h.sent.map(m => m.type), ["blocked", "unblocked", "settled"], "the ordinary two-consecutive-quiet-tick rule still applies");
		mock.timers.tick(POLL_MS * 3);
		assert.deepEqual(h.sent.map(m => m.type), ["blocked", "unblocked", "settled"], "polling stops once the Fork really settles");
	} finally { revoke(); h.restore(); mock.timers.reset(); }
});

test("only the Fork's own error counts, and only while work is actually outstanding", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	let jobs = 1;
	const revoke = publishCapability("shell_job", { sessionId: "S1", cwd }, 1, () => ({}), () => true, () => jobs);
	try {
		// An assistant error inherited with the snapshot belongs to the parent, not to this Fork.
		const inherited = guardHarness([failedAssistant, marker]);
		inherited.handlers.get("session_start")!({ reason: "startup" }, inherited.ctx); inherited.sent.length = 0;
		inherited.handlers.get("agent_settled")!({}, inherited.ctx);
		assert.deepEqual(inherited.sent, [], "inherited history must not be reported as this Fork's failure");
		inherited.restore();

		// A successful turn is not blocked even with a job still running.
		const ok = guardHarness([marker, okAssistant]);
		ok.handlers.get("session_start")!({ reason: "startup" }, ok.ctx); ok.sent.length = 0;
		ok.handlers.get("agent_settled")!({}, ok.ctx);
		assert.deepEqual(ok.sent, []);
		ok.restore();
	} finally { revoke(); mock.timers.reset(); }
});

test("blocked is an active status and survives record round-trips", () => {
	assert.equal(isTerminal("blocked"), false, "a blocked Fork still holds its permit");
	const record = { schemaVersion: 1, jobId: "01M52M47XTKFXET5YE7EMEAJ81", forkSessionId: "01M52M47XT00BR9JH8FCE4EAK9", title: "t", taskPreview: "p", status: "blocked", cancelRequested: false,
		origin: { sessionId: "s", cwd }, config: { model: "p/m", thinkingLevel: "off", trusted: false, toolsFingerprint: "f", toolCount: 1 }, createdAt: new Date().toISOString(), ownerPid: 1, delivery: "pending",
		blocked: { reason: "MODEL_ERROR", error: "quota", pending: { shell: 1, subagents: 0 }, since: new Date().toISOString() } };
	const parsed = parseRecord(JSON.stringify(record));
	assert.equal(parsed?.status, "blocked");
	assert.deepEqual(parsed?.blocked?.pending, { shell: 1, subagents: 0 });
	assert.equal(parseRecord(JSON.stringify({ ...record, status: "stalled" })), undefined, "unknown statuses stay rejected");
});

test("the parent records blocked, exposes it in fork_status and clears it on recovery", async () => {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fork", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, hasUI: false, sessionManager: sm };
	const pi: any = { getActiveTools: () => ["read", "fork"], getAllTools: () => [{ name: "read", sourceInfo: { path: "/ext/read.ts" } }], getThinkingLevel: () => "off", sendMessage: () => {} };
	const progress: Array<(p: string, d?: unknown) => void> = [];
	state().jobs.clear(); state().admission = true;
	// The guard handshake is process-wide: earlier guard tests in this file must not make this root look like a Fork.
	delete (globalThis as Record<symbol, unknown>)[SLOT];
	delete process.env[FORK_GUARD_ENV];
	deps.startChild = ((_spec: ForkChildSpec, onProgress: (p: string, d?: unknown) => void) => { progress.push(onProgress); return { pid: 1, done: new Promise(() => {}), async cancel() {} }; }) as never;
	try {
		onSessionStart(pi, ctx);
		const receipt = acceptFork(pi, ctx, { task: "do work", title: "T" });
		sm.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "fork", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } as never);
		onTurnEnd(ctx, { message: { stopReason: "toolUse" } });
		assert.equal(progress.length, 1);
		progress[0]!("blocked", { reason: "MODEL_ERROR", error: "quota", pending: { shell: 1, subagents: 0 } });
		const job = state().jobs.get(receipt.jobId)!;
		assert.equal(job.record.status, "blocked");
		assert.equal(job.record.endedAt, undefined, "blocked is not terminal");
		assert.equal(job.released, false, "the permit stays held");
		assert.equal(job.record.blocked?.error, "quota");
		assert.equal(summarize(job).status, "blocked");
		assert.deepEqual((summarize(job).blocked as any).pending, { shell: 1, subagents: 0 }, "fork_status must show why it is blocked");
		assert.equal(Object.keys(summarize(job, true)).length > 0, true);

		progress[0]!("running");
		assert.equal(job.record.status, "running");
		assert.equal(job.record.blocked, undefined, "recovery clears the blocked truth");
	} finally { state().jobs.clear(); deps.startChild = ((spec: ForkChildSpec, onProgress: Parameters<typeof startForkChild>[1]) => startForkChild(spec, onProgress)) as never; rmSync(cwd, { recursive: true, force: true }); }
});

test("child maps blocked/unblocked IPC to progress, bounded and sanitized, and ignores it before verification", async () => {
	const proc: any = new EventEmitter();
	const lines: any[] = []; let buffered = "";
	proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.connected = true; proc.pid = 1;
	// Scripted RPC stand-in: the startup handshake must complete and the prompt must be accepted before
	// any progress report is meaningful.
	proc.stdin = new Writable({ write(chunk: string, _enc: unknown, cb: () => void) {
		buffered += chunk;
		for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
			const command = JSON.parse(buffered.slice(0, at)); buffered = buffered.slice(at + 1); lines.push(command);
			const reply = (data: unknown) => proc.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }) + "\n");
			if (command.type === "get_state") reply({ sessionId: "S1" });
			else if (command.type === "get_session_stats") reply({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 });
			else if (command.type === "prompt") reply({ disposition: "started" });
			else reply({});
		}
		cb();
	} });
	proc.send = (message: unknown, cb?: () => void) => { cb?.(); return true; };
	proc.kill = () => true;
	proc.ipc = (message: Record<string, unknown>) => proc.emit("message", { channel: CHANNEL, ...message });
	let token = "";
	const spec: ForkChildSpec = { jobId: "J", sessionId: "S1", sessionPath: join(cwd, "s.jsonl"), sessionDir: sessions, cwd, model: "p/m", thinkingLevel: "off", tools: ["read"], trusted: false,
		guardPath: "/g.ts", forwarded: [], prompt: "PROMPT", closeGraceMs: 5, killGraceMs: 5,
		invocation: () => ({ command: "pi", args: [] }) as never, spawnImpl: ((_c: string, _a: string[], options: any) => { token = JSON.parse(options.env[FORK_GUARD_ENV]).token; return proc; }) as never };
	const seen: Array<[string, unknown]> = [];
	const handle = startForkChild(spec, (progress, detail) => seen.push([progress, detail]));
	const send = (message: Record<string, unknown>) => proc.ipc({ token, ...message });
	const settle = () => new Promise(resolve => setImmediate(resolve));
	send({ type: "blocked", reason: "MODEL_ERROR", error: "quota", pending: { shell: 1, subagents: 0 } });
	send({ type: "unblocked" });
	await settle();
	assert.deepEqual(seen, [], "progress before startup verification is ignored");
	send({ type: "verified", tools: ["read"] });
	for (let i = 0; i < 20 && !lines.some(line => line.type === "prompt"); i++) await settle();
	assert.ok(lines.some(line => line.type === "prompt"), "the child accepted the prompt");
	send({ type: "blocked", reason: "MODEL_ERROR", error: "q".repeat(500), pending: { shell: 2.7, subagents: -1 } });
	send({ type: "unblocked" });
	await settle();
	assert.deepEqual(seen.map(entry => entry[0]), ["running", "blocked", "running"]);
	const detail: any = seen[1]![1];
	assert.deepEqual(detail.pending, { shell: 2, subagents: 0 }, "job counts are integral and never negative");
	assert.equal(detail.reason, "MODEL_ERROR");
	assert.equal(detail.error.length, 300, "the stored error text stays bounded");
	proc.emit("close", 0);
	await handle.done;
	rmSync(cwd, { recursive: true, force: true });
});
