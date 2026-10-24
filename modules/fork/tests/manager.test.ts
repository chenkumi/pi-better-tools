import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ForkChildOutcome, ForkChildSpec } from "../src/child.ts";
import { FORK_MARKER_TYPE } from "../src/identity.ts";
import { acceptFork, activeCount, cancelAll, deliver, deps, onSessionShutdown, onSessionStart, onTurnEnd, ownedJobs, requestCancel, state, summarize } from "../src/manager.ts";
import { forkPanelJob } from "../src/live-widget.ts";
import { loadRecords, pruneRecords, saveRecord, transcriptDir } from "../src/store.ts";

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
	const specs: ForkChildSpec[] = []; const handles: Array<{ finish(o: Partial<ForkChildOutcome>): void; cancelled: boolean; steered: Array<[string, string]>; steerMode: "queued" | "handled" | "throw" | "notReady"; onSteer?: (text: string) => void; steer(text: string, mode: string): Promise<string> }> = [];
	const phases: Array<(progress: string) => void> = [];
	deps.startChild = ((spec: ForkChildSpec, onPhase: (progress: string) => void) => {
		specs.push(spec);
		let resolve!: (o: ForkChildOutcome) => void; const done = new Promise<ForkChildOutcome>(r => { resolve = r; });
		const handle = { cancelled: false, steered: [] as Array<[string, string]>, steerMode: "queued" as "queued" | "handled" | "throw" | "notReady", onSteer: undefined as ((text: string) => void) | undefined, finish: (o: Partial<ForkChildOutcome>) => resolve({ status: "completed", output: "RESULT_TEXT", childClosed: true, stderrTail: "", ...o }),
			async steer(text: string, mode: string) {
				if (handle.steerMode === "notReady") throw Object.assign(new Error("CHILD_NOT_READY: the Fork child has not started its task yet"), { code: "CHILD_NOT_READY" });
				if (handle.steerMode === "throw") throw new Error("RPC_DEADLINE: steer response not received");
				handle.steered.push([mode, text]); handle.onSteer?.(text); return handle.steerMode;
			} };
		handles.push(handle);
		phases.push(onPhase);
		return { pid: 1, done, async steer(text: string, mode: string) { return handle.steer(text, mode); }, async cancel() { handle.cancelled = true; handle.finish({ status: "cancelled", output: undefined }); } };
	}) as never;
	return { specs, handles, phases };
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await Promise.all([...state().jobs.values()].flatMap(job => [job.transcript?.whenStarted() ?? Promise.resolve(), job.transcriptDone ?? Promise.resolve()])); await new Promise(resolve => setImmediate(resolve)); };
/** Receipts of the messages sent to one Fork, as fork_status would show them (newest last). */
const interactions = (job: unknown): any[] => (((summarize(job as never) as any).interactions ?? []) as any[]);

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
	assert.ok(spec.prompt.startsWith("You are the background Fork."), "identity is declared first");
	assert.match(spec.prompt, /how YOU were launched/, "names the fork call in the inherited history as its own launch");
	assert.match(spec.prompt, /Do not wait for, poll, or expect a report/);
	assert.match(spec.prompt, /final message is what gets delivered back/);
	assert.ok(spec.prompt.endsWith("\n\nTask:\ndo work"), "the task follows the declaration verbatim");
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
	assert.equal(sent[0][1].deliverAs, "steer", "background results use the steer default");
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

test("a close observed after the cleanup deadline releases the permit once", async () => {
	const a = origin(); const A = fakes(a); fakeChild();
	let closeNow!: (exitCode: number | null) => void;
	deps.startChild = (() => {
		let resolve!: (o: ForkChildOutcome) => void; const done = new Promise<ForkChildOutcome>(r => { resolve = r; });
		const closed = new Promise<number | null>(r => { closeNow = r; });
		return { pid: 3, done, closed, async cancel() { resolve({ status: "cancelled", childClosed: false, stderrTail: "" }); } };
	}) as never;
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" }); addResult(a); onTurnEnd(A.ctx, {});
	const [job] = ownedJobs(A.ctx);
	await requestCancel(job!); await flush();
	assert.equal(activeCount(), 1, "permit is held while close is unconfirmed");
	closeNow(0); await flush();
	assert.equal(job!.released, true);
	assert.equal(activeCount(), 0);
	assert.deepEqual(job!.record.cleanup, { childClosed: true, exitCode: 0 });
	assert.equal(loadRecords(cwd).find(r => r.jobId === job!.record.jobId)?.cleanup?.childClosed, true);
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

test("live conversation copy: built from child events for the panel, released as soon as the Fork ends", async () => {
	const sm = origin(); const { ctx, pi } = fakes(sm); const { specs, handles } = fakeChild();
	onSessionStart(pi, ctx);
	acceptFork(pi, ctx, { task: "do work" });
	addResult(sm); onTurnEnd(ctx, {});
	const job = ownedJobs(ctx)[0]!;
	specs[0]!.onEvent!({ type: "message_start", message: { role: "assistant", content: [] } });
	specs[0]!.onEvent!({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "typing" }] } });
	const panel = forkPanelJob(job);
	assert.equal(panel.transcripts?.length, 1);
	const copySource = panel.transcripts![0]!.transcript;
	if (copySource.mode !== "conversation") throw new Error("a Fork copy is a conversation, not an output tail");
	assert.equal(copySource.snapshot().items.length, 1);
	const copy = job.live!;
	handles[0]!.finish({ output: "ALL DONE" });
	await flush();
	assert.equal(copy.isReleased, true); assert.equal(job.live, undefined);
	assert.equal(forkPanelJob(job).transcripts, undefined);
});

test("transcript: path is disclosed at accept, only post-start messages are logged, final path is announced on completion", async () => {
	const sm = origin(); const { ctx, pi, sent } = fakes(sm); const { specs, handles } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" });
	const expected = join(transcriptDir(cwd, receipt.jobId), "transcript.jsonl");
	assert.equal(receipt.transcriptPath, expected);
	assert.equal(loadRecords(cwd)[0]!.transcript?.state, "pending", "persisted from the start, before any process exists");
	assert.equal(existsSync(transcriptDir(cwd, receipt.jobId)), false, "no file or directory before the Fork starts");
	addResult(sm); onTurnEnd(ctx, {});
	const spec = specs[0]!;
	spec.onMessage!({ role: "user", content: spec.prompt });
	spec.onMessage!({ role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] });
	spec.onMessage!({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file body" }], isError: false });
	await flush();
	const live = ownedJobs(ctx)[0]!.record.transcript!;
	assert.equal(live.state, "live"); assert.equal(live.livePath, `${expected}.partial`); assert.ok(existsSync(live.livePath!));
	handles[0]!.finish({ output: "ALL DONE" });
	await flush();
	const lines = readFileSync(expected, "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.deepEqual(lines.map(l => l.type), ["user", "assistant", "tool_call", "tool_result"]);
	assert.ok(!JSON.stringify(lines).includes("hello"), "inherited conversation is not copied");
	assert.equal(existsSync(`${expected}.partial`), false);
	assert.equal(sent.length, 1);
	assert.ok(sent[0][0].content.includes(expected), "completion notice reveals the transcript path");
	assert.equal(sent[0][0].details.transcriptPath, expected);
	assert.deepEqual(loadRecords(cwd)[0]!.transcript, { path: expected, state: "final" });
});

for (const action of ["resume", "quit", "reload"] as const) test(`transcript finalization gates terminal delivery and ${action}`, async () => {
	const sm = origin(); const A = fakes(sm); const { handles } = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" }); addResult(sm); onTurnEnd(A.ctx, {});
	const job = ownedJobs(A.ctx)[0]!;
	const transcript = job.transcript!;
	const finalize = transcript.finalize.bind(transcript);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	transcript.finalize = async status => { await gate; await finalize(status); };
	await onSessionShutdown("new");
	handles[0]!.finish({ output: "DONE" });
	await Promise.resolve();
	assert.equal(job.record.status, "finalizing");
	assert.equal(job.record.endedAt, undefined);
	onSessionStart(A.pi, A.ctx);
	assert.equal(A.sent.length, 0, "session re-entry cannot submit a result before rename");
	assert.equal(job.record.delivery, "pending");
	let stopped = false;
	const shutdown = action === "resume" ? Promise.resolve() : onSessionShutdown(action).then(() => { stopped = true; });
	await new Promise(resolve => setImmediate(resolve));
	if (action !== "resume") assert.equal(stopped, false, "shutdown waits for transcript finalization");
	assert.equal(handles[0]!.cancelled, false, "a settled child is not cancelled again");
	release();
	await shutdown; await flush();
	assert.equal(job.record.status, "completed");
	assert.equal(job.record.transcript?.state, "final");
	assert.equal(existsSync(transcript.livePath), false);
	if (action !== "resume") onSessionStart(A.pi, A.ctx);
	assert.equal(A.sent.length, 1);
	assert.equal(A.sent[0][0].details.transcriptPath, transcript.path);
	onSessionStart(A.pi, A.ctx);
	assert.equal(A.sent.length, 1, "the final result is delivered once");
});

test("transcript failure never fails the Fork: result is delivered and the transcript is reported unavailable", async () => {
	const sm = origin(); const { ctx, pi, sent } = fakes(sm); const { handles } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "x" });
	writeFileSync(transcriptDir(cwd, receipt.jobId), "a file where the transcript directory must go");
	addResult(sm); onTurnEnd(ctx, {});
	handles[0]!.finish({ output: "STILL FINE" });
	await flush();
	const [job] = ownedJobs(ctx);
	assert.equal(job!.record.status, "completed");
	assert.equal(job!.record.transcript?.state, "unavailable");
	assert.equal(sent.length, 1); assert.match(sent[0][0].content, /STILL FINE/); assert.match(sent[0][0].content, /Transcript unavailable/);
	assert.equal(sent[0][0].details.transcriptPath, undefined);
});

test("a cancelled Fork whose child never closed does not announce a final transcript", async () => {
	const sm = origin(); const { ctx, pi, sent } = fakes(sm); const { handles } = fakeChild();
	onSessionStart(pi, ctx);
	acceptFork(pi, ctx, { task: "x" }); addResult(sm); onTurnEnd(ctx, {});
	await flush();
	handles[0]!.finish({ status: "cancelled", output: undefined, childClosed: false });
	await flush();
	const [job] = ownedJobs(ctx);
	assert.equal(job!.record.status, "cancelled");
	assert.equal(job!.record.transcript?.state, "unavailable"); assert.match(job!.record.transcript!.error!, /not confirmed closed/);
	assert.equal(existsSync(job!.transcript!.path), false);
	assert.equal(sent[0][0].details.transcriptPath, undefined);
});

test("a cancel that arrives while the transcript is finalizing is recorded and does not change the outcome", async () => {
	const sm = origin(); const A = fakes(sm); const { handles } = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x" }); addResult(sm); onTurnEnd(A.ctx, {});
	const job = ownedJobs(A.ctx)[0]!;
	const finalize = job.transcript!.finalize.bind(job.transcript!);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	job.transcript!.finalize = async (status, outcome) => { await gate; await finalize(status, outcome); };
	handles[0]!.finish({ output: "DONE" });
	await Promise.resolve();
	assert.equal(job.record.status, "finalizing");
	const cancel = requestCancel(job);
	assert.equal(job.record.cancelRequested, true);
	release(); await cancel; await flush();
	assert.equal(job.record.status, "completed");
	assert.equal(handles[0]!.cancelled, false);
});

test("a Fork that never started reports its transcript as unavailable; an orphaned live transcript is not claimed final", async () => {
	const a = origin(); const A = fakes(a); fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "never starts" });
	onTurnEnd(A.ctx, {}); // unpaired tool call -> snapshot failure
	const [failed] = ownedJobs(A.ctx);
	assert.equal(failed!.record.transcript?.state, "unavailable"); assert.match(failed!.record.transcript!.error!, /never started/);
	const id = "01HZZZZZZZZZZZZZZZZZZZZZZ9";
	saveRecord(cwd, { schemaVersion: 1, jobId: id, forkSessionId: id, title: id, taskPreview: "", status: "running", cancelRequested: false, origin: { sessionId: a.getSessionId(), file: a.getSessionFile(), cwd },
		config: { model: "p/m", thinkingLevel: "off", trusted: false, toolsFingerprint: "x", toolCount: 1 }, createdAt: new Date().toISOString(), ownerPid: 99999999, delivery: "pending",
		transcript: { path: join(transcriptDir(cwd, id), "transcript.jsonl"), livePath: join(transcriptDir(cwd, id), "transcript.jsonl.partial"), state: "live" } });
	onSessionStart(A.pi, A.ctx);
	const orphan = state().jobs.get(id)!;
	assert.equal(orphan.record.status, "interrupted"); assert.equal(orphan.record.transcript?.state, "unavailable"); assert.match(orphan.record.transcript!.error!, /partial log may remain/);
});

test("fork_message accepts only a live Fork, prefixes the control and never changes the status", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work", title: "M" }); addResult(sm); onTurnEnd(ctx, {});
	phases[0]!("running");
	const sent = await messageFork(ctx, receipt.jobId, "also check X", "follow_up");
	assert.equal(sent.jobId, receipt.jobId);
	assert.match(sent.messageId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.equal(sent.status, "queued"); assert.equal(sent.mode, "follow_up");
	assert.deepEqual(handles[0]!.steered, [["follow_up", `[Delegated user control ${sent.messageId}]\nalso check X`]]);
	const job = state().jobs.get(receipt.jobId)!;
	assert.equal(job.record.status, "running", "acceptance is not progress");
	assert.equal(job.record.cancelRequested, false, "a message is not a cancellation");
	assert.equal(interactions(job).at(-1).status, "queued");
	await flush();
});

test("fork_message refuses every non-live state, foreign owners, invalid text and its own capacity", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {});
	const job = state().jobs.get(receipt.jobId)!;
	for (const status of ["starting", "awaiting_snapshot", "finalizing", "cancelling", "cancelled", "completed", "failed", "interrupted"] as const) {
		job.record.status = status;
		await assert.rejects(() => messageFork(ctx, receipt.jobId, "x"), /FORK_(BUSY|NOT_RUNNING)/, status);
	}
	job.record.status = "running";
	await assert.rejects(() => messageFork({ cwd: ctx.cwd, sessionManager: { getSessionId: () => "other-session" } }, receipt.jobId, "x"), /FORK_NOT_FOUND/);
	await assert.rejects(() => messageFork({ ...ctx, cwd: join(cwd, "elsewhere") }, receipt.jobId, "x"), /FORK_NOT_FOUND/);
	await assert.rejects(() => messageFork(ctx, "01M5F9ZE13PVTBF3N91GXAJDMG", "x"), /FORK_NOT_FOUND/);
	await assert.rejects(() => messageFork(ctx, receipt.jobId, "   "), /FORK_INVALID_ARGUMENTS/);
	await assert.rejects(() => messageFork(ctx, receipt.jobId, "x".repeat(70 * 1024)), /FORK_INVALID_ARGUMENTS/);
	assert.equal(handles[0]!.steered.length, 0, "no rejected message reaches the child");
	for (let i = 0; i < 32; i++) await messageFork(ctx, receipt.jobId, `m${i}`);
	await assert.rejects(() => messageFork(ctx, receipt.jobId, "overflow"), /FORK_MESSAGE_CAPACITY/);
	assert.equal(handles[0]!.steered.length, 32);
	await flush();
});

test("a message becomes applied only when the child's own user message arrives, and fork_status shows the last 3", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { specs, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	const sent = await messageFork(ctx, receipt.jobId, "check X");
	const control = `[Delegated user control ${sent.messageId}]\ncheck X`;
	specs[0]!.onMessage!({ role: "assistant", content: [{ type: "text", text: "working" }] });
	assert.equal(interactions(job).at(-1).status, "queued", "an assistant message is not the control");
	specs[0]!.onMessage!({ role: "user", content: [{ type: "text", text: control }], timestamp: 1234567890 });
	const applied = interactions(job).at(-1);
	assert.equal(applied.status, "applied"); assert.equal(applied.appliedAt, 1234567890);
	for (const text of ["a", "b", "c", "d"]) await messageFork(ctx, receipt.jobId, text);
	const shown = interactions(job);
	assert.equal(shown.length, 3, "fork_status shows only the last 3");
	assert.deepEqual(shown.map(item => item.status), ["queued", "queued", "queued"]);
	await flush();
});

test("a message whose transport failed is delivery_unknown, never applied or queued", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	handles[0]!.steerMode = "throw";
	const sent = await messageFork(ctx, receipt.jobId, "lost");
	assert.equal(sent.status, "delivery_unknown");
	assert.match(sent.error, /RPC_DEADLINE/);
	assert.equal(interactions(job).at(-1).status, "delivery_unknown");
	handles[0]!.steerMode = "handled";
	assert.equal((await messageFork(ctx, receipt.jobId, "consumed")).status, "not_applied");
	await flush();
});

test("the child's user message arriving before the steer response is not overwritten by the disposition", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { specs, handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	handles[0]!.onSteer = text => specs[0]!.onMessage!({ role: "user", content: text, timestamp: 42 });
	const sent = await messageFork(ctx, receipt.jobId, "early");
	assert.equal(interactions(job).at(-1).status, "applied", "applied evidence is never downgraded");
	assert.equal(sent.status, "applied");
	await flush();
});

test("a later user message upgrades not_applied and delivery_unknown receipts", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { specs, handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	handles[0]!.steerMode = "handled";
	const handled = await messageFork(ctx, receipt.jobId, "consumed");
	handles[0]!.steerMode = "throw";
	const lost = await messageFork(ctx, receipt.jobId, "lost");
	assert.deepEqual([handled.status, lost.status], ["not_applied", "delivery_unknown"]);
	for (const [id, text] of [[handled.messageId, "consumed"], [lost.messageId, "lost"]]) specs[0]!.onMessage!({ role: "user", content: `[Delegated user control ${id}]\n${text}` });
	assert.deepEqual(job.interactions!.map(item => item.status), ["applied", "applied"]);
	await flush();
});

test("applied matches the control message id even when the child's text differs in whitespace", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { specs, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	const sent = await messageFork(ctx, receipt.jobId, "check X\n\nplease");
	specs[0]!.onMessage!({ role: "user", content: [{ type: "text", text: `[Delegated user control ${sent.messageId}]\ncheck X\n\nplease\n` }] });
	assert.equal(interactions(job).at(-1).status, "applied");
	const other = await messageFork(ctx, receipt.jobId, "second");
	specs[0]!.onMessage!({ role: "user", content: `[Delegated user control ${sent.messageId}]\nsecond` });
	assert.equal(job.interactions!.find(item => item.messageId === other.messageId)!.status, "queued", "another message's id must not apply it");
	await flush();
});

test("unconfirmed control text is released once the Fork is terminal", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	handles[0]!.steerMode = "handled";
	await messageFork(ctx, receipt.jobId, "x".repeat(1000));
	assert.ok(job.interactions![0]!.text.length > 1000);
	handles[0]!.finish({});
	await flush();
	assert.equal(job.record.status, "completed");
	assert.deepEqual(job.interactions!.map(item => item.text), [""]);
});

test("a definite CHILD_NOT_READY refusal is thrown and consumes no message slot", async () => {
	const { messageFork } = await import("../src/manager.ts") as any;
	const sm = origin(); const { ctx, pi } = fakes(sm); const { handles, phases } = fakeChild();
	onSessionStart(pi, ctx);
	const receipt = acceptFork(pi, ctx, { task: "do work" }); addResult(sm); onTurnEnd(ctx, {}); phases[0]!("running");
	const job = state().jobs.get(receipt.jobId)!;
	handles[0]!.steerMode = "notReady";
	for (let i = 0; i < 40; i++) await assert.rejects(() => messageFork(ctx, receipt.jobId, `n${i}`), /CHILD_NOT_READY/);
	assert.equal(job.interactions?.length ?? 0, 0);
	await flush();
});

test("pruning a record also removes its transcript directory", () => {
	const record = (jobId: string) => ({ schemaVersion: 1 as const, jobId, forkSessionId: jobId, title: jobId, taskPreview: "", status: "completed" as const, cancelRequested: false,
		origin: { sessionId: "S", file: "s.jsonl", cwd }, config: { model: "p/m", thinkingLevel: "off", trusted: false, toolsFingerprint: "x", toolCount: 1 },
		createdAt: new Date().toISOString(), ownerPid: 1, delivery: "observed" as const });
	const id = (n: number) => `01H${String(n).padStart(23, "0")}`;
	saveRecord(cwd, record(id(0)));
	mkdirSync(transcriptDir(cwd, id(0)), { recursive: true }); writeFileSync(join(transcriptDir(cwd, id(0)), "transcript.jsonl"), "{}\n");
	for (let n = 10; n < 10 + 64; n++) saveRecord(cwd, record(id(n)));
	assert.equal(pruneRecords(cwd), 1);
	assert.equal(existsSync(transcriptDir(cwd, id(0))), false);
});
