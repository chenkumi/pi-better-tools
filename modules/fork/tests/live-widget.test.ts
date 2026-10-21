import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_WIDGET_KEY } from "../../shell-tools/src/background-panel.ts";
import type { ForkChildOutcome } from "../src/child.ts";
import { forkPanelJob } from "../src/live-widget.ts";
import { acceptFork, deps, onSessionShutdown, onSessionStart, onTurnEnd, requestCancel, state } from "../src/manager.ts";

let root: string, cwd: string, sessions: string;
const KEY = Symbol.for("pi-better-tools.fork.registry.v1");
const theme: any = { fg: (_: string, s: string) => s, getBgAnsi: () => "", bg: (_: string, s: string) => s };
beforeEach(() => { delete (globalThis as any)[KEY]; root = mkdtempSync(join(tmpdir(), "fork-widget-")); cwd = realpathSync(root); sessions = join(cwd, "sessions"); deps.argv = () => []; deps.launchCwd = () => cwd; });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); delete (globalThis as any)[KEY]; });

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function origin() {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fork", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(), usage } as never);
	return sm;
}
const addResult = (sm: SessionManager) => sm.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "fork", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } as never);
/** One shared event hub so every binding reaches the same panel, like the real host. */
const hub = (() => { const handlers: Function[] = []; return { emit: (_c: string, d: unknown) => handlers.forEach(h => h(d)), on: (_c: string, h: Function) => { handlers.push(h); return () => undefined; } }; })();
function fakes(sm: SessionManager, mode = "tui") {
	const widgets = new Map<string, any>(), statuses: Array<[string, unknown]> = [], sent: any[] = [];
	const ctx: any = { cwd, mode, hasUI: true, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, sessionManager: sm,
		ui: { setStatus: (k: string, v: unknown) => statuses.push([k, v]), setWidget(k: string, v: any, o: any) { if (v) { assert.equal(o.placement, "aboveEditor"); widgets.set(k, v); } else widgets.delete(k); } } };
	const pi: any = { events: hub, registerCommand() {}, getActiveTools: () => ["read", "fork"], getAllTools: () => ["read", "fork"].map(name => ({ name, sourceInfo: { path: `/ext/${name}.ts` } })), getThinkingLevel: () => "off",
		sendMessage: (m: any) => { sent.push(m); sm.appendCustomMessageEntry?.(m.customType, m.content, m.display, m.details); } };
	const text = () => plain(widgets.get(BACKGROUND_WIDGET_KEY)?.({ terminal: { rows: 40 }, requestRender() {} }, theme).render(120).join("\n") ?? "");
	return { ctx, pi, widgets, statuses, sent, text };
}
function fakeChild() {
	const handles: Array<{ finish(o: Partial<ForkChildOutcome>): void; phase(p: "starting" | "running" | "finalizing"): void; cancels: number }> = [];
	deps.startChild = ((_spec: unknown, onPhase: any) => {
		let resolve!: (o: ForkChildOutcome) => void; const done = new Promise<ForkChildOutcome>(r => { resolve = r; });
		const handle = { cancels: 0, phase: (p: any) => onPhase(p), finish: (o: Partial<ForkChildOutcome>) => resolve({ status: "completed", output: "SECRET_RESULT_BODY", childClosed: true, stderrTail: "", ...o }) };
		handles.push(handle); return { pid: 1, done, async cancel() { handle.cancels++; } };
	}) as never;
	return handles;
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await Promise.all([...state().jobs.values()].map(job => job.transcriptDone)); await new Promise(resolve => setImmediate(resolve)); };

test("lifecycle shows title and real states, never the task/result body, and no footer summary", async () => {
	const sm = origin(), A = fakes(sm), handles = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "PRIVATE_TASK_BODY", title: "Audit modules" });
	assert.match(A.text(), /FK fork · Audit modules/); assert.match(A.text(), /awaiting_snapshot/); assert.match(A.text(), /usage pending/);
	addResult(sm); onTurnEnd(A.ctx, {}); handles[0]!.phase("running"); assert.match(A.text(), /running/);
	handles[0]!.finish({ usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0 } }); await flush();
	assert.equal(A.widgets.has(BACKGROUND_WIDGET_KEY), false, "confirmed cleanup leaves the resident panel");
	assert.ok(A.statuses.every(([k, v]) => k !== "pi-fork" || v === undefined), "legacy footer summary is gone");
	assert.doesNotMatch(A.text(), /PRIVATE_TASK_BODY|SECRET_RESULT_BODY/);
});

test("cancelling and terminal-but-unconfirmed cleanup stay visible with honest text", async () => {
	const sm = origin(), A = fakes(sm), handles = fakeChild();
	onSessionStart(A.pi, A.ctx);
	const receipt = acceptFork(A.pi, A.ctx, { task: "x", title: "Slow close" }); addResult(sm); onTurnEnd(A.ctx, {}); handles[0]!.phase("running");
	await requestCancel(state().jobs.get(receipt.jobId)!); assert.match(A.text(), /cancelling · cancel requested, awaiting child close/);
	handles[0]!.finish({ status: "cancelled", output: undefined, childClosed: false }); await flush();
	assert.equal(state().jobs.get(receipt.jobId)!.released, false);
	assert.match(A.text(), /cancelled · cleanup unconfirmed/); assert.match(A.text(), /Fork 1/); assert.doesNotMatch(A.text(), /running/);
});

test("session A to B to A: B never shows A's Fork, returning to A rebuilds latest state, old lease cannot update", async () => {
	const a = origin(), A = fakes(a), handles = fakeChild();
	onSessionStart(A.pi, A.ctx);
	acceptFork(A.pi, A.ctx, { task: "x", title: "A work" }); addResult(a); onTurnEnd(A.ctx, {}); handles[0]!.phase("running");
	await onSessionShutdown("new"); assert.equal(A.widgets.has(BACKGROUND_WIDGET_KEY), false, "shutdown detaches the display lease");
	const B = fakes(SessionManager.create(cwd, sessions)); onSessionStart(B.pi, B.ctx);
	assert.equal(B.widgets.has(BACKGROUND_WIDGET_KEY), false); handles[0]!.phase("finalizing"); assert.equal(B.widgets.has(BACKGROUND_WIDGET_KEY), false);
	await onSessionShutdown("resume"); onSessionStart(A.pi, A.ctx);
	assert.match(A.text(), /A work/); assert.match(A.text(), /finalizing/);
	assert.equal(B.widgets.has(BACKGROUND_WIDGET_KEY), false);
});

test("non-TUI contexts never create a widget; Forks still run", async () => {
	const sm = origin(), R = fakes(sm, "rpc"), handles = fakeChild();
	onSessionStart(R.pi, R.ctx); acceptFork(R.pi, R.ctx, { task: "x" }); addResult(sm); onTurnEnd(R.ctx, {});
	assert.equal(R.widgets.size, 0); handles[0]!.finish({}); await flush(); assert.equal(R.sent.length, 1);
});

test("a throwing UI never changes the result, delivery or permit", async () => {
	const sm = origin(), A = fakes(sm), handles = fakeChild();
	onSessionStart(A.pi, A.ctx);
	const receipt = acceptFork(A.pi, A.ctx, { task: "x" });
	A.ctx.ui.setWidget = () => { throw new Error("UI fault"); }; A.ctx.ui.setStatus = () => { throw new Error("UI fault"); };
	addResult(sm); onTurnEnd(A.ctx, {}); handles[0]!.finish({}); await flush();
	const job = state().jobs.get(receipt.jobId)!;
	assert.equal(job.record.status, "completed"); assert.equal(job.released, true); assert.equal(A.sent.length, 1);
});

for (const status of ["completed", "cancelled"] as const) test(`retained ${status} Fork with confirmed child close and released permit never claims unconfirmed cleanup`, async () => {
	const sm = origin(), A = fakes(sm), handles = fakeChild();
	onSessionStart(A.pi, A.ctx);
	const receipt = acceptFork(A.pi, A.ctx, { task: "x", title: "Closed cleanly" }); addResult(sm); onTurnEnd(A.ctx, {}); handles[0]!.phase("running");
	handles[0]!.finish({ status, output: status === "completed" ? "done" : undefined, childClosed: true, exitCode: 0 }); await flush();
	const job = state().jobs.get(receipt.jobId)!;
	assert.equal(job.record.status, status); assert.equal(job.released, true); assert.equal(job.record.cleanup?.childClosed, true);
	const view = forkPanelJob(job);
	assert.equal(view.active, false);
	assert.doesNotMatch(view.activity, /unconfirmed|not observed/); assert.match(view.activity, new RegExp(`^${status} · child closed`));
	assert.ok(view.details.some(line => /Cleanup: child closed · exit 0/.test(line))); assert.ok(view.details.some(line => /Permit: released/.test(line)));
	assert.ok(!view.details.some(line => /unconfirmed|NOT confirmed/.test(line)), "list State and details must agree");
});

test("terminal Fork whose child close is unconfirmed (permit held) still warns in activity and details", async () => {
	const sm = origin(), A = fakes(sm), handles = fakeChild();
	onSessionStart(A.pi, A.ctx);
	const receipt = acceptFork(A.pi, A.ctx, { task: "x" }); addResult(sm); onTurnEnd(A.ctx, {});
	handles[0]!.finish({ childClosed: false }); await flush();
	const view = forkPanelJob(state().jobs.get(receipt.jobId)!);
	assert.equal(view.active, true); assert.match(view.activity, /completed · cleanup unconfirmed · child close not observed/);
	assert.ok(view.details.some(line => /close NOT confirmed/.test(line))); assert.ok(view.details.some(line => /Permit: held/.test(line)));
});
