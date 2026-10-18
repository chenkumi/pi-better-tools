import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ForkChildOutcome, ForkChildSpec } from "../src/child.ts";
import { FORK_MARKER_TYPE } from "../src/identity.ts";
import { acceptFork, activeCount, cancelAll, deliver, deps, onSessionShutdown, onSessionStart, onTurnEnd, ownedJobs, requestCancel, state } from "../src/manager.ts";
import { loadRecords, pruneRecords, saveRecord } from "../src/store.ts";

let root: string, cwd: string, sessions: string;
const asm = (s: SessionManager) => s as any;
const KEY = Symbol.for("pi-better-tools.fork.registry.v1");

beforeEach(() => {
	delete (globalThis as any)[KEY];
	root = mkdtempSync(join(tmpdir(), "fork-unit-"));
	cwd = realpathSync(root); sessions = join(cwd, "sessions");
	deps.argv = () => []; deps.launchCwd = () => cwd;
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); delete (globalThis as any)[KEY]; });

/** A real persisted SessionManager whose branch ends in an assistant tool call, like a Fork tool execution. */
function origin(extraEntries: (sm: SessionManager) => void = () => {}) {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	extraEntries(sm);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fork", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
	return sm;
}
const addResult = (sm: SessionManager) => sm.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "fork", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } as never);
function fakes(sm: SessionManager, extra: { tools?: string[]; inline?: string[] } = {}) {
	const sent: any[] = [], statuses: any[] = [];
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, hasUI: true, ui: { setStatus: (k: string, v: unknown) => statuses.push([k, v]) }, sessionManager: sm };
	const pi: any = { getActiveTools: () => extra.tools ?? ["read", "fork"], getAllTools: () => (extra.tools ?? ["read", "fork"]).map(name => ({ name, sourceInfo: { path: extra.inline?.includes(name) ? "<inline:x>" : `/ext/${name}.ts` } })),
		getThinkingLevel: () => "off", sendMessage: (m: any, o: any) => { sent.push([m, o]); sm.appendCustomMessageEntry?.(m.customType, m.content, m.display, m.details); } };
	return { ctx, pi, sent, statuses };
}
/** Fake child: completes only when the test calls finish(). */
function fakeChild() {
	const specs: ForkChildSpec[] = []; const handles: Array<{ finish(o: Partial<ForkChildOutcome>): void; cancelled: boolean }> = [];
	deps.startChild = ((spec: ForkChildSpec) => {
		specs.push(spec);
		let resolve!: (o: ForkChildOutcome) => void; const done = new Promise<ForkChildOutcome>(r => { resolve = r; });
		const handle = { cancelled: false, finish: (o: Partial<ForkChildOutcome>) => resolve({ status: "completed", output: "RESULT_TEXT", childClosed: true, stderrTail: "", ...o }) };
		handles.push(handle);
		return { pid: 1, done, async cancel() { handle.cancelled = true; handle.finish({ status: "cancelled", output: undefined }); } };
	}) as never;
	return { specs, handles };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("accept refuses Fork/Subagent identities, capacity, shutdown, inline tools and unpersisted sessions", () => {
	const sm = origin(); const { ctx, pi } = fakes(sm);
	sm.appendCustomEntry(FORK_MARKER_TYPE, { role: "fork" });
	assert.throws(() => acceptFork(pi, ctx, { task: "x" }), /FORK_FORBIDDEN/);
	const root1 = fakes(origin());
	assert.throws(() => acceptFork(root1.pi, root1.ctx, { task: "  " }), /FORK_INVALID_ARGUMENTS/);
	assert.throws(() => acceptFork(root1.pi, root1.ctx, { task: "x", title: "y".repeat(121) }), /FORK_INVALID_ARGUMENTS/);
	assert.throws(() => acceptFork(root1.pi, root1.ctx, { task: "x".repeat(100 * 1024 + 1) }), /FORK_TASK_TOO_LARGE/);
	const inline = fakes(origin(), { tools: ["read", "sdk_tool"], inline: ["sdk_tool"] });
	assert.throws(() => acceptFork(inline.pi, inline.ctx, { task: "x" }), /FORK_CAPABILITY_UNAVAILABLE/);
	const mem = fakes(SessionManager.inMemory(cwd));
	assert.throws(() => acceptFork(mem.pi, mem.ctx, { task: "x" }), /FORK_REQUIRES_PERSISTED_SESSION/);
	state().admission = false;
	assert.throws(() => acceptFork(root1.pi, root1.ctx, { task: "x" }), /FORK_NOT_ACCEPTING/);
	state().admission = true;
	for (let i = 0; i < 4; i++) acceptFork(root1.pi, root1.ctx, { task: `t${i}` });
	assert.throws(() => acceptFork(root1.pi, root1.ctx, { task: "fifth" }), /FORK_CAPACITY/);
	assert.equal(activeCount(), 4);
});

test("snapshot is taken at the turn boundary, child gets exact parent selection, result goes only to the origin binding", async () => {
	const sm = origin(); const { ctx, pi, sent } = fakes(sm); const { specs, handles } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work", title: "T" });
	assert.equal(receipt.status, "awaiting_snapshot");
	assert.equal(specs.length, 0, "no process before the boundary");
	assert.match(receipt.forkSessionId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	const sourceBefore = readFileSync(sm.getSessionFile()!, "utf8");
	addResult(sm); // canonical tool result now exists
	onTurnEnd(ctx, { message: { stopReason: "toolUse" } });
	assert.equal(specs.length, 1);
	const spec = specs[0]!;
	assert.equal(spec.sessionId, receipt.forkSessionId);
	assert.deepEqual(spec.tools, ["read"], "Fork tools are removed from the inherited selection");
	assert.equal(spec.model, "p/m");
	assert.ok(!spec.prompt.includes("\u0000") && spec.prompt.includes("do work"));
	const lines = readFileSync(spec.sessionPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.equal(lines[0].id, receipt.forkSessionId);
	assert.equal(lines.at(-1).customType, FORK_MARKER_TYPE);
	assert.equal(lines.at(-1).parentId, sm.getLeafId());
	assert.equal(readFileSync(sm.getSessionFile()!, "utf8").startsWith(sourceBefore), true, "source journal only ever grows by the host");
	// The Fork conversation is a real native session.
	const opened = SessionManager.open(spec.sessionPath, sessions);
	assert.equal(opened.getSessionId(), receipt.forkSessionId);
	assert.equal(opened.getEntries().filter(e => e.type === "message").length, 3);
	handles[0]!.finish({ output: "ALL DONE", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0 } });
	await flush(); await flush();
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0].customType, "fork-result");
	assert.match(sent[0][0].content, /ALL DONE/);
	assert.match(sent[0][0].content, /not instructions/);
	assert.equal(sent[0][1].triggerTurn, true);
	const [job] = ownedJobs(ctx);
	assert.equal(job!.record.delivery, "observed");
	assert.equal(job!.released, true);
	const stored = loadRecords(cwd);
	assert.equal(stored[0]!.status, "completed"); assert.equal(stored[0]!.result?.usage?.total, 3);
});

test("A->B: completion while another session is foreground stays pending and is delivered once on return", async () => {
	const a = origin(); const A = fakes(a); const { handles } = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" }); addResult(a); onTurnEnd(A.ctx, {});
	await onSessionShutdown("new"); // session replacement: work continues
	const b = SessionManager.create(cwd, sessions); const B = fakes(b);
	onSessionStart(B.pi, B.ctx);
	assert.equal(state().jobs.size, 1, "job survives replacement");
	handles[0]!.finish({});
	await flush();
	assert.equal(B.sent.length, 0, "never injected into another session");
	assert.equal(A.sent.length, 0);
	const job = [...state().jobs.values()][0]!;
	assert.equal(job.record.delivery, "pending");
	assert.equal(ownedJobs(B.ctx).length, 0, "B cannot see or cancel A's job");
	await onSessionShutdown("resume");
	onSessionStart(A.pi, A.ctx); // back in A
	await flush();
	assert.equal(A.sent.length, 1);
	assert.equal(job.record.delivery, "observed");
	onSessionStart(A.pi, A.ctx); // re-entry must not replay
	assert.equal(A.sent.length, 1);
});

test("a result already in the origin journal is observed, not replayed", async () => {
	const a = origin(); const A = fakes(a); fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" }); addResult(a);
	const job = [...state().jobs.values()][0]!;
	job.record.status = "completed"; job.record.result = { resultId: "R1", output: "o" };
	a.appendCustomMessageEntry("fork-result", "earlier", true, { resultId: "R1" });
	deliver(job, state().binding);
	assert.equal(A.sent.length, 0);
	assert.equal(job.record.delivery, "observed");
});

test("quit and reload cancel every unfinished Fork and wait for close; replacement does not", async () => {
	const a = origin(); const A = fakes(a); const { handles } = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "one" }); acceptFork(A.pi, A.ctx, { task: "two" });
	addResult(a); onTurnEnd(A.ctx, {});
	assert.equal(handles.length, 2);
	await onSessionShutdown("fork");
	assert.equal(handles.some(h => h.cancelled), false);
	onSessionStart(A.pi, A.ctx);
	await onSessionShutdown("reload");
	assert.equal(handles.every(h => h.cancelled), true);
	assert.equal(state().admission, false, "no new admission after shutdown");
	assert.ok([...state().jobs.values()].every(j => j.record.status === "cancelled" && j.record.cancelRequested));
	onSessionStart(A.pi, A.ctx);
	assert.equal(state().admission, true, "new epoch after reload start");
});

test("cancel is a request: unconfirmed close keeps the permit and is reported", async () => {
	const a = origin(); const A = fakes(a); fakeChild();
	deps.startChild = (() => { let resolve!: (o: ForkChildOutcome) => void; const done = new Promise<ForkChildOutcome>(r => { resolve = r; }); return { pid: 2, done, async cancel() { resolve({ status: "cancelled", childClosed: false, stderrTail: "" }); } }; }) as never;
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" }); addResult(a); onTurnEnd(A.ctx, {});
	const [job] = ownedJobs(A.ctx);
	await requestCancel(job!); await flush();
	assert.equal(job!.record.status, "cancelled");
	assert.equal(job!.record.cleanup?.childClosed, false);
	assert.equal(job!.released, false, "permit is retained until a real close");
	assert.equal(activeCount(), 1);
	await cancelAll();
});

test("snapshot failures never invent data: unpaired calls, changed branch, aborted origin turn, lost origin", async () => {
	const a = origin(); const A = fakes(a); const { specs } = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" });
	onTurnEnd(A.ctx, {}); // no tool result yet
	let [job] = ownedJobs(A.ctx);
	assert.equal(job!.record.status, "failed"); assert.match(job!.record.result!.errorCode!, /SNAPSHOT_UNPAIRED_TOOL_CALLS/);
	assert.equal(specs.length, 0);
	assert.equal(readdirSync(sessions).filter(n => n.includes(job!.record.forkSessionId)).length, 0, "no native file for a failed snapshot");
	const a2 = origin(); const A2 = fakes(a2); addResult(a2); acceptFork(A2.pi, A2.ctx, { task: "y" });
	onTurnEnd(A2.ctx, { message: { stopReason: "aborted" } });
	[job] = ownedJobs(A2.ctx).filter(j => j.record.title === "y");
	assert.equal(job!.record.result!.errorCode, "ORIGIN_TURN_ABORTED");
	const a3 = origin(); const A3 = fakes(a3); onSessionStart(A3.pi, A3.ctx); acceptFork(A3.pi, A3.ctx, { task: "z" });
	await onSessionShutdown("new");
	assert.equal([...state().jobs.values()].find(j => j.record.title === "z")!.record.result!.errorCode, "SNAPSHOT_ORIGIN_LOST");
	assert.equal(specs.length, 0);
});

test("stored records: orphaned running work is marked interrupted (never re-run); pending results re-attach to the exact origin", () => {
	const a = origin(); const A = fakes(a); const { specs } = fakeChild();
	const base = (jobId: string, status: any, delivery: any, pid: number) => ({ schemaVersion: 1 as const, jobId, forkSessionId: jobId, title: jobId, taskPreview: "", status, cancelRequested: false,
		origin: { sessionId: a.getSessionId(), file: a.getSessionFile(), cwd }, config: { model: "p/m", thinkingLevel: "off", trusted: false, toolsFingerprint: "x", toolCount: 1 },
		createdAt: new Date().toISOString(), ownerPid: pid, delivery, ...(status === "completed" ? { result: { resultId: `R-${jobId}`, output: "kept" } } : {}) });
	const ids = ["01HZZZZZZZZZZZZZZZZZZZZZZ1", "01HZZZZZZZZZZZZZZZZZZZZZZ2", "01HZZZZZZZZZZZZZZZZZZZZZZ3"];
	saveRecord(cwd, base(ids[0]!, "running", "pending", 99999999));
	saveRecord(cwd, base(ids[1]!, "completed", "pending", 99999999));
	saveRecord(cwd, { ...base(ids[2]!, "completed", "pending", 99999999), origin: { sessionId: "OTHER", file: "other.jsonl", cwd } });
	onSessionStart(A.pi, A.ctx);
	const jobs = new Map([...state().jobs].map(([id, job]) => [id, job]));
	assert.equal(jobs.get(ids[0]!)!.record.status, "interrupted");
	assert.equal(jobs.get(ids[0]!)!.record.result!.errorCode, "OWNER_GONE");
	assert.equal(specs.length, 0, "nothing is re-run");
	assert.equal(jobs.has(ids[2]!), false, "another origin's record is not adopted");
	assert.equal(A.sent.length, 1);
	assert.match(A.sent[0][0].content, /kept/);
});

test("no secrets or task body in metadata; files are owner-only temp-free", () => {
	const a = origin(); const A = fakes(a); fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "TASK_BODY ".repeat(100) });
	const dir = join(cwd, ".pi", "forks");
	const files = readdirSync(dir);
	assert.equal(files.length, 1); assert.ok(files[0]!.endsWith(".json"));
	const record = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
	assert.ok(record.taskPreview.length <= 500);
	assert.equal(existsSync(join(dir, `${record.jobId}.json.${process.pid}.tmp`)), false);
	writeFileSync(join(dir, "ignored.txt"), "x");
	assert.equal(loadRecords(cwd).length, 1);
});

test("records beyond the bounded scan are pruned only when finished and needing no delivery", () => {
	const record = (jobId: string, status: any, delivery: any) => ({ schemaVersion: 1 as const, jobId, forkSessionId: jobId, title: jobId, taskPreview: "", status, cancelRequested: false,
		origin: { sessionId: "S", file: "s.jsonl", cwd }, config: { model: "p/m", thinkingLevel: "off", trusted: false, toolsFingerprint: "x", toolCount: 1 },
		createdAt: new Date().toISOString(), ownerPid: 1, delivery });
	const id = (n: number) => `01H${String(n).padStart(23, "0")}`;
	// Oldest four: one prunable, one pending delivery, one unfinished, one unreadable.
	saveRecord(cwd, record(id(0), "completed", "observed"));
	saveRecord(cwd, record(id(1), "completed", "pending"));
	saveRecord(cwd, record(id(2), "running", "pending"));
	writeFileSync(join(cwd, ".pi", "forks", `${id(3)}.json`), "{broken");
	for (let n = 10; n < 10 + 64; n++) saveRecord(cwd, record(id(n), "completed", "observed"));
	assert.equal(pruneRecords(cwd), 1);
	const names = readdirSync(join(cwd, ".pi", "forks"));
	assert.equal(names.includes(`${id(0)}.json`), false);
	for (const kept of [1, 2, 3]) assert.ok(names.includes(`${id(kept)}.json`), `record ${kept} is kept`);
	assert.equal(loadRecords(cwd).length, 64);
	assert.equal(pruneRecords(cwd), 0);
});
