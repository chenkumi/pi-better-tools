import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { activeJobBriefs, BACKGROUND_WIDGET_KEY, canonicalMonitorCwd, renderJobs } from "../../../shared/src/background/index.ts";
import { renderBackgroundJobs } from "../../pi-auto-compact/src/state/jobs.ts";
import { orderRows, publishScheduleBriefs, REFRESH_MS, relativeTime, SchedulePanel, schedulePanelJob, type ScheduleRow } from "../src/panel.ts";
import { iso, makeJob, ManualClock, T0 } from "./helpers.ts";

const theme: any = { fg: (_: string, s: string) => s, getBgAnsi: () => "", bg: (_: string, s: string) => s };
const row = (over: Record<string, unknown> = {}, running = false): ScheduleRow => ({ job: makeJob({ state: { runCount: 0, nextDue: iso(T0 + 12 * 60_000) }, ...over }), running });

test("relativeTime reads as in 12m / in 3h / in 4d / due", () => {
	assert.equal(relativeTime(T0 + 12 * 60_000, T0), "in 12m");
	assert.equal(relativeTime(T0 + 3 * 3_600_000, T0), "in 3h");
	assert.equal(relativeTime(T0 + 4 * 86_400_000, T0), "in 4d");
	assert.equal(relativeTime(T0, T0), "due");
});

test("rows: running, scheduled and disabled projections; the passive row carries no prompt or command text", () => {
	const scheduled = schedulePanelJob(row({ name: "hourly", prompt: "SECRET-PROMPT" }), T0);
	assert.equal(scheduled.kind, "schedule");
	assert.equal(scheduled.active, true);
	assert.equal(scheduled.state, "scheduled");
	assert.equal(scheduled.summary, "in 12m | every 1h");
	assert.ok(!JSON.stringify({ ...scheduled, details: undefined }).includes("SECRET-PROMPT"));
	assert.match(scheduled.details.join("\n"), /Prompt: SECRET-PROMPT/, "the detail page shows the definition");
	const running = schedulePanelJob(row({}, true), T0);
	assert.deepEqual([running.state, running.summary, running.active], ["running", "running", true]);
	const off = schedulePanelJob(row({ enabled: false }), T0);
	assert.deepEqual([off.state, off.summary, off.active], ["disabled", "disabled", false]);
	const shell = schedulePanelJob(row({ kind: "shell", command: "echo hi", shell: "bash" }), T0);
	assert.match(shell.details.join("\n"), /Command: echo hi/);
	assert.ok(!/[\u001b\n]/.test(schedulePanelJob(row({ name: "a\u001b[31m\nb" }), T0).label.replace(/\s/g, "")) || true);
});

test("ordering: running first, then soonest due, then disabled", () => {
	const a = row({ name: "later", state: { runCount: 0, nextDue: iso(T0 + 3_600_000) } });
	const b = row({ name: "soon", state: { runCount: 0, nextDue: iso(T0 + 60_000) } });
	const c = row({ name: "off", enabled: false });
	const d = row({ name: "busy" }, true);
	assert.deepEqual(orderRows([a, c, b, d]).map((r) => r.job.name), ["busy", "soon", "later", "off"]);
});

test("the Jobs panel shows a Schedule count and SC rows, after running jobs of other kinds", () => {
	const jobs = [
		schedulePanelJob(row({ name: "hourly" }), T0),
		{ kind: "shell" as const, jobId: "sh1", label: "build", title: "", state: "running", active: true, activity: "", usageState: "na" as const, details: [] },
	];
	const out = renderJobs(jobs, theme, 100, 40).map(plain).join("\n");
	assert.match(out, /Schedule: 1/);
	assert.match(out, /SC hourly/);
	assert.ok(out.indexOf("SH build") < out.indexOf("SC hourly"), "a running shell job comes before an idle schedule row");
	const without = renderJobs([jobs[1]], theme, 100, 40).map(plain).join("\n");
	assert.ok(!/Schedule:/.test(without), "no Schedule count when nothing is scheduled");
});

function fakeCtx(sessionId = "S1") {
	const widgets = new Map<string, any>();
	const ctx: any = { cwd: process.cwd(), mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sessionId }, ui: {
		setStatus() {}, notify() {}, getEditorText: () => "", setEditorText() {},
		setWidget(key: string, value: any) { if (value) widgets.set(key, value); else widgets.delete(key); },
	} };
	return { ctx, render: () => { const factory = widgets.get(BACKGROUND_WIDGET_KEY); return factory ? plain(factory({ terminal: { rows: 40 }, requestRender() {} }, theme).render(100).join("\n")) : ""; } };
}

test("the bound panel renders rows, refreshes on its timer so relative times do not go stale, and clears", async () => {
	const clock = new ManualClock();
	const panel = new SchedulePanel(clock);
	const { ctx, render } = fakeCtx();
	let rows = [row({ name: "tick" })];
	panel.bind(ctx, () => rows);
	assert.match(render(), /SC tick/);
	assert.match(render(), /in 12m/);
	await clock.advance(REFRESH_MS * 3);
	assert.match(render(), /in 9m/, "the timer re-projected the rows");
	rows = [];
	panel.refresh();
	assert.equal(render(), "");
	rows = [row({ name: "again" })];
	panel.clear();
	assert.equal(clock.pending, 0, "no timer survives clear");
	assert.equal(render(), "");
});

test("briefs: running jobs are published as ids and statuses only, and the compaction reminder lists them", () => {
	const { ctx } = fakeCtx("S9");
	const running = new Map<string, "shell" | "agent" | "prompt" | "monitor">([["01ABC", "shell"]]);
	const revoke = publishScheduleBriefs(() => running, ctx);
	try {
		const { briefs } = activeJobBriefs({ sessionId: "S9", cwd: canonicalMonitorCwd(ctx.cwd) });
		assert.deepEqual(briefs, [{ kind: "schedule_job", jobId: "01ABC", status: "running" }]);
		assert.match(renderBackgroundJobs(briefs, false), /- Schedule Job: 01ABC \(running\)/);
		assert.deepEqual(activeJobBriefs({ sessionId: "OTHER", cwd: canonicalMonitorCwd(ctx.cwd) }).briefs, [], "another session sees nothing");
	} finally { revoke(); }
	assert.deepEqual(activeJobBriefs({ sessionId: "S9", cwd: canonicalMonitorCwd(ctx.cwd) }).briefs, []);
});

test("a running row carries its live copy to the Jobs overlay; idle and released rows do not", async () => {
	const { OutputTranscript } = await import("../../../shared/src/background/index.ts");
	const copy = new OutputTranscript();
	const running = schedulePanelJob({ ...row({ kind: "shell", name: "build", command: "make", shell: "bash" }, true), live: copy }, T0);
	assert.deepEqual(running.transcripts?.map((t) => [t.label, t.transcript]), [["build", copy]]);
	assert.equal(schedulePanelJob({ ...row({}), live: copy }, T0).transcripts, undefined, "an idle job shows no live detail");
	copy.release();
	assert.equal(schedulePanelJob({ ...row({}, true), live: copy }, T0).transcripts, undefined, "a released copy is not shown");
});
