import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { BACKGROUND_WIDGET_KEY } from "../../shell-tools/src/background-panel.ts";
import { activeJobBriefs, canonicalMonitorCwd } from "../../shell-tools/src/monitor-capability.ts";
import { PtySessionsWidget, ptyPanelJob, publishPtyBriefs } from "../src/live-widget.ts";
import { PtySessionManager, type PtySessionSummary } from "../src/pty-manager.ts";

const KEEP_ALIVE = "process.stdout.write('READY');setInterval(()=>{},1000)";
const summary = (patch: Partial<PtySessionSummary> = {}): PtySessionSummary => ({
	sessionId: "pty-1-1", pid: 4242, target: "local", transport: "local", state: "running", bufferedBytes: 99, droppedChars: 0, cursor: 5, startedAt: 1_700_000_000_000, ...patch,
});
const theme: any = { fg: (_: string, s: string) => s, getBgAnsi: () => "", bg: (_: string, s: string) => s };
function fakeCtx(cwd: string, sessionId = "owner") {
	const widgets = new Map<string, any>();
	const ctx: any = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sessionId }, ui: {
		setStatus() {}, notify() {}, getEditorText: () => "", setEditorText() {},
		setWidget(key: string, value: any) { if (value) widgets.set(key, value); else widgets.delete(key); },
	} };
	return { ctx, render: () => { const factory = widgets.get(BACKGROUND_WIDGET_KEY); return factory ? plain(factory({ terminal: { rows: 40 }, requestRender() {} }, theme).render(100).join("\n")) : ""; } };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("a running session is an active PT row with identity and lifecycle only", () => {
	const job = ptyPanelJob(summary({ target: "build-host", transport: "ssh" }));
	assert.equal(job.kind, "pty"); assert.equal(job.active, true); assert.equal(job.state, "running");
	assert.equal(job.jobId, "pty-1-1"); assert.equal(job.title, "build-host (ssh)"); assert.equal(job.usageState, "na");
	const text = JSON.stringify(job);
	assert.ok(!/99|bufferedBytes|cursor/.test(job.details.join("\n")), "no per-byte counters, which would go stale");
	assert.match(text, /not a remote process ID/); assert.match(text, /does not prove a remote\/WSL process tree stopped/);
	assert.equal(job.transcripts, undefined, "output is never exposed");
});
test("an exited session is inactive and reports its exit code; recovered sessions say the exit is unconfirmed", () => {
	const exited = ptyPanelJob(summary({ state: "exited", exitCode: 3 }));
	assert.equal(exited.active, false); assert.match(exited.activity, /exit code 3/); assert.equal(exited.summary, "exited | 3");
	assert.match(ptyPanelJob(summary({ state: "exited" })).activity, /exit code not observed/);
	assert.match(ptyPanelJob(summary({ recovered: true })).details.join("\n"), /exit is unconfirmed/);
	assert.doesNotMatch(ptyPanelJob(summary()).details.join("\n"), /unconfirmed/);
	const hostile = ptyPanelJob(summary({ target: "x\u001b[31m\ny‮" }));
	assert.ok(!/[\u001b\n‮]/.test(hostile.title));
});
test("the manager reports spawn, exit and release, and snapshot never reclaims", async t => {
	let now = 0;
	const manager = new PtySessionManager({ now: () => now, exitedRetentionMs: 1000 }); t.after(() => manager.shutdown());
	let changes = 0; manager.onChange = () => { changes++; };
	const { sessionId } = manager.spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(5),50)"], {}, process.cwd());
	assert.equal(changes, 1); assert.equal(manager.snapshot()[0].state, "running"); assert.equal(typeof manager.snapshot()[0].startedAt, "number");
	await manager.waitForExit(sessionId, 5000);
	assert.ok(changes >= 2, "exit is reported"); assert.equal(manager.snapshot()[0].exitCode, 5);
	now = 5000; // past retention: only list() may release it
	assert.equal(manager.snapshot().length, 1, "snapshot is readonly");
	const before = changes;
	assert.deepEqual(manager.list(), []); assert.ok(changes > before, "release is reported");
	manager.onChange = () => { throw new Error("observer failure"); };
	const second = manager.spawn(process.execPath, ["-e", KEEP_ALIVE], {}, process.cwd());
	assert.equal((await manager.kill(second.sessionId)).released, true, "an observer failure never affects sessions");
});
test("snapshot can be limited to one workspace", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	manager.spawn(process.execPath, ["-e", KEEP_ALIVE], {}, process.cwd());
	assert.equal(manager.snapshot(process.cwd()).length, 1); assert.equal(manager.snapshot(process.cwd() + "/..").length, 0);
});
test("the bottom panel shows running sessions, follows lifecycle changes and clears with the binding", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const widget = new PtySessionsWidget(); manager.onChange = () => widget.refresh();
	const { ctx, render } = fakeCtx(process.cwd());
	widget.bind(ctx, () => manager.snapshot(ctx.cwd));
	assert.equal(render(), "", "nothing to show without a session");
	const { sessionId } = manager.spawn(process.execPath, ["-e", KEEP_ALIVE], {}, process.cwd());
	assert.match(render(), /Jobs · 1 active/); assert.match(render(), /PTY 1/); assert.match(render(), /PT pty · local/);
	await manager.kill(sessionId);
	assert.equal(render(), "", "a released session leaves the panel");
	manager.spawn(process.execPath, ["-e", KEEP_ALIVE], {}, process.cwd());
	assert.match(render(), /PT pty/);
	widget.clear(); assert.equal(render(), "");
});
test("compaction briefs list running sessions by id and status, and are revocable and owner-scoped", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const { ctx } = fakeCtx(process.cwd());
	const scope = { sessionId: "owner", cwd: canonicalMonitorCwd(process.cwd()) };
	assert.deepEqual(activeJobBriefs(scope).briefs.filter(b => b.kind === "pty_session"), []);
	const revoke = publishPtyBriefs(manager, ctx);
	const live = manager.spawn(process.execPath, ["-e", KEEP_ALIVE], {}, process.cwd());
	const gone = manager.spawn(process.execPath, ["-e", "process.exit(0)"], {}, process.cwd());
	await manager.waitForExit(gone.sessionId, 5000); await settled();
	assert.deepEqual(activeJobBriefs(scope), { briefs: [{ kind: "pty_session", jobId: live.sessionId, status: "running" }], partial: false });
	assert.deepEqual(activeJobBriefs({ ...scope, sessionId: "other" }).briefs, [], "another Pi session sees nothing");
	revoke(); assert.deepEqual(activeJobBriefs(scope).briefs, []);
});

test("a session re-adopted after a failed shutdown reports its later exit to the new manager", async t => {
	const nativeSpawn = createRequire(import.meta.url)("node-pty").spawn as typeof import("node-pty").spawn;
	const handles: Array<{ kill: () => void }> = [];
	// The kill request is accepted but has no effect, so the first manager cannot confirm the exit and parks the session.
	const spawnPty = ((...args: Parameters<typeof nativeSpawn>) => {
		const pty = nativeSpawn(...args); const kill = pty.kill.bind(pty); handles.push({ kill });
		pty.kill = () => {};
		return pty;
	}) as typeof nativeSpawn;
	t.after(() => { for (const handle of handles) { try { handle.kill(); } catch { /* already gone */ } } });
	const orphans = new Map();
	const first = new PtySessionManager({ orphans, spawnPty, killWaitMs: 20 });
	first.spawn(process.execPath, ["-e", KEEP_ALIVE], {}, process.cwd());
	assert.equal((await first.shutdown()).retained.length, 1);
	const second = new PtySessionManager({ orphans });
	let changes = 0; second.onChange = () => { changes++; };
	assert.equal(second.recover(process.cwd()).length, 1);
	assert.equal(changes, 1, "adoption is reported");
	assert.equal(second.snapshot()[0].state, "running");
	for (const handle of handles) handle.kill(); // the transport now really exits
	for (let i = 0; i < 100 && second.snapshot()[0].state === "running"; i++) await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(second.snapshot()[0].state, "exited");
	assert.ok(changes >= 2, "the exit reaches the manager that now owns the session, so its panel can refresh");
});
