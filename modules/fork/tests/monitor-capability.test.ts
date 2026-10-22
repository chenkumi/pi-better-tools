import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ForkChildOutcome, ForkChildSpec } from "../src/child.ts";
import { acceptFork, deps, onSessionStart, state, type Job } from "../src/manager.ts";
import { forkMonitorSnapshot, publishForkMonitor } from "../src/monitor-capability.ts";
import { saveRecord, type ForkRecord } from "../src/store.ts";
import { acquireCapability } from "../../shell-tools/src/monitor-capability.ts";
import forkExtension from "../src/index.ts";

const KEY = Symbol.for("pi-better-tools.fork.registry.v1");
/** Store records must use a real ULID job id; the loader skips any other file name. */
const LOADED = "01M5F9ZE13PVTBF3N91GXAJDMF";
const TASK = "SECRET_TASK_TEXT do the thing";
let root: string, cwd: string, sessions: string;
beforeEach(() => {
	delete (globalThis as any)[KEY];
	root = mkdtempSync(join(tmpdir(), "fork-monitor-")); cwd = realpathSync(root); sessions = join(cwd, "sessions");
	deps.argv = () => []; deps.launchCwd = () => cwd;
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); delete (globalThis as any)[KEY]; });

/** A real persisted session whose branch ends in an assistant tool call, like a live Fork tool execution. */
function origin() {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fork", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
	return sm;
}
function fakes(sm: SessionManager) {
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, hasUI: false, ui: { setStatus() {} }, sessionManager: sm };
	const pi: any = { getActiveTools: () => ["read", "fork"], getAllTools: () => ["read", "fork"].map(name => ({ name, sourceInfo: { path: `/ext/${name}.ts` } })), getThinkingLevel: () => "off", sendMessage() {} };
	return { ctx, pi };
}
/** Fake child that never settles; the Fork stays live for the whole test. */
function fakeChild() {
	deps.startChild = ((spec: ForkChildSpec) => {
		const done = new Promise<ForkChildOutcome>(() => {});
		return { pid: 1, done, async cancel() {} };
	}) as never;
}
/** A genuinely live Fork: real manager state, no file surgery. */
function liveFork() {
	const sm = origin(); const { ctx, pi } = fakes(sm); fakeChild();
	const receipt = acceptFork(pi, ctx, { task: TASK, title: "live" });
	return { sm, ctx, pi, jobId: receipt.jobId, job: state().jobs.get(receipt.jobId)! as Job };
}
const text = (value: unknown) => JSON.stringify(value);

test("a live Fork is observable without its task text, result output, usage or native session path", () => {
	const { sm, ctx, jobId, job } = liveFork();
	const revoke = publishForkMonitor(ctx);
	try {
		const snapshot = acquireCapability("fork_job", { sessionId: sm.getSessionId(), cwd }).snapshot(jobId);
		assert.deepEqual(Object.keys(snapshot).sort(), ["cancelRequested", "createdAt", "delivery", "elapsedMs", "jobId", "status", "transcript"]);
		assert.equal(snapshot.jobId, jobId);
		assert.equal(snapshot.status, "awaiting_snapshot");
		assert.equal(snapshot.cancelRequested, false);
		assert.ok((snapshot.elapsedMs as number) >= 0);
		assert.equal(text(snapshot).includes("SECRET_TASK_TEXT"), false);
		assert.equal(text(snapshot).includes("taskPreview"), false);
		assert.equal(text(snapshot).includes(job.record.sessionPath ?? "no-session-path"), false);
	} finally { revoke(); }
});

test("a blocked Fork reports only a bounded reason and nested-job counts, never the child's error text", () => {
	const { ctx, jobId, job } = liveFork();
	const revoke = publishForkMonitor(ctx);
	try {
		job.record.status = "blocked";
		job.record.blocked = { reason: `\u001b[31mMODEL_CALL_FAILED ${"r".repeat(500)}`, error: "SECRET_PROVIDER_ERROR", pending: { shell: 2, subagents: 1 }, since: "2026-01-01T00:00:02.000Z" };
		const blocked = forkMonitorSnapshot(ctx, jobId).blocked as any;
		assert.equal(blocked.reason.length, 200);
		assert.equal(blocked.reason.includes("\u001b"), false);
		assert.deepEqual(blocked.pending, { shell: 2, subagents: 1 });
		assert.equal(blocked.since, "2026-01-01T00:00:02.000Z");
		assert.equal(text(blocked).includes("SECRET_PROVIDER_ERROR"), false);
	} finally { revoke(); }
});

test("a finished Fork loaded from the store keeps its cleanup evidence and transcript state; unknown ids are refused", () => {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	const transcriptPath = join(cwd, ".pi", "forks", LOADED, "transcript.jsonl");
	const record: ForkRecord = { schemaVersion: 1, jobId: LOADED, forkSessionId: "S1", title: "t", taskPreview: "SECRET_TASK_TEXT", status: "completed", cancelRequested: false,
		origin: { sessionId: sm.getSessionId(), cwd, file: sm.getSessionFile() }, config: { model: "m", thinkingLevel: "off", trusted: false, toolsFingerprint: "x", toolCount: 1 },
		createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:09.000Z", ownerPid: process.pid, delivery: "submitted",
		cleanup: { childClosed: true, exitCode: 0 }, transcript: { path: transcriptPath, state: "final" }, result: { resultId: "R1", output: "SECRET_RESULT_OUTPUT" } };
	saveRecord(cwd, record);
	const { ctx, pi } = fakes(sm);
	onSessionStart(pi, ctx);
	const revoke = publishForkMonitor(ctx);
	try {
		const snapshot = forkMonitorSnapshot(ctx, LOADED);
		assert.equal(snapshot.status, "completed");
		assert.equal(snapshot.elapsedMs, 8000);
		assert.deepEqual(snapshot.cleanup, { childClosed: true, exitCode: 0 });
		assert.deepEqual(snapshot.transcript, { state: "final", path: transcriptPath });
		assert.equal(text(snapshot).includes("SECRET_RESULT_OUTPUT"), false);
		assert.equal(text(snapshot).includes("usage"), false);
		assert.throws(() => forkMonitorSnapshot(ctx, "01M5F9ZE13PVTBF3N91GXAJDMG"), /not retained by this session/);
	} finally { revoke(); }
});

test("the capability is bound to one session, canonical cwd and generation, and revoke ends it", () => {
	const { sm, ctx, jobId } = liveFork();
	const scope = { sessionId: sm.getSessionId(), cwd };
	const revoke = publishForkMonitor(ctx);
	const lease = acquireCapability("fork_job", scope);
	try {
		assert.throws(() => acquireCapability("fork_job", { sessionId: scope.sessionId, cwd: join(cwd, "elsewhere") }), /unavailable or owner\/cwd\/generation mismatch/);
		assert.throws(() => acquireCapability("fork_job", { sessionId: "another-session", cwd }), /unavailable or owner\/cwd\/generation mismatch/);
		state().epoch++;
		assert.throws(() => lease.snapshot(jobId), /unavailable or owner\/cwd\/generation mismatch/);
	} finally { state().epoch = 1; revoke(); }
	assert.throws(() => acquireCapability("fork_job", scope), /unavailable or owner\/cwd\/generation mismatch/);
});

test("the extension publishes the Fork capability on session_start and revokes it on session_shutdown", async () => {
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const registered: string[] = [];
	const pi: any = { registerMessageRenderer() {}, registerTool: (tool: any) => registered.push(tool.name), on: (event: string, fn: any) => { (handlers[event] ??= []).push(fn); } };
	forkExtension(pi);
	assert.deepEqual(registered, ["fork", "fork_status", "fork_cancel", "fork_message"]);
	const sm = origin(); const { ctx } = fakes(sm);
	const scope = { sessionId: sm.getSessionId(), cwd };
	assert.throws(() => acquireCapability("fork_job", scope), /unavailable or owner\/cwd\/generation mismatch/);
	for (const handler of handlers.session_start) await handler({}, ctx);
	assert.equal(acquireCapability("fork_job", scope).generation, 1);
	for (const handler of handlers.session_shutdown) await handler({ reason: "new" }, ctx);
	assert.throws(() => acquireCapability("fork_job", scope), /unavailable or owner\/cwd\/generation mismatch/);
});

test("observing a Fork cannot cancel, resume or query it", () => {
	const { sm, ctx, jobId, job } = liveFork();
	const revoke = publishForkMonitor(ctx);
	try {
		const lease = acquireCapability("fork_job", { sessionId: sm.getSessionId(), cwd });
		assert.deepEqual(Object.keys(lease).sort(), ["generation", "snapshot"]);
		assert.equal(Object.isFrozen(lease), true);
		lease.snapshot(jobId); lease.snapshot(jobId);
		assert.equal(job.record.cancelRequested, false);
		assert.equal(job.record.status, "awaiting_snapshot");
		assert.equal(text(forkMonitorSnapshot(ctx, jobId)).includes("cancel"), true, "the snapshot only carries the cancelRequested flag, never a cancel verb");
	} finally { revoke(); }
});

test("active Fork briefs carry only the job id and status, and drop finished Forks", async () => {
	const { activeJobBriefs } = await import("../../shell-tools/src/monitor-capability.ts");
	const { sm, ctx, jobId, job } = liveFork();
	const revoke = publishForkMonitor(ctx);
	try {
		const scope = { sessionId: sm.getSessionId(), cwd };
		assert.deepEqual(activeJobBriefs(scope), { briefs: [{ kind: "fork_job", jobId, status: "awaiting_snapshot" }], partial: false });
		assert.equal(text(activeJobBriefs(scope)).includes("SECRET_TASK_TEXT"), false);
		job.record.status = "completed";
		assert.deepEqual(activeJobBriefs(scope).briefs, []);
	} finally { revoke(); }
});
