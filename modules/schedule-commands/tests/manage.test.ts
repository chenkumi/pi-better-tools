import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveSettings } from "../../../shared/src/settings-panel/index.ts";
import { CommandApprovals } from "../src/cwd.ts";
import { ScheduleEngine } from "../src/engine.ts";
import { JobService } from "../src/jobs.ts";
import { ManageBody, performAction, type ManageAction } from "../src/manage.ts";
import { orderRows, type ScheduleRow } from "../src/panel.ts";
import { scheduleSettingsSchema } from "../src/settings-ui.ts";
import { ScheduleStore } from "../src/storage.ts";
import { fakeExecutor, makeJob, ManualClock, T0 } from "./helpers.ts";

const style = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const row = (over: Record<string, unknown> = {}): ScheduleRow => ({ job: makeJob(over), running: false });
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
/** Minimal stand-in for the UI: records the widget and lets a test type into the captured terminal-input listener. */
function fakeUi() {
	const widgets = new Map<string, { render(width: number): string[] }>();
	const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	const tui = { requestRender() {}, terminal: { rows: 30 } };
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const ui = {
		setWidget(key: string, content: unknown) {
			widgets.delete(key);
			if (typeof content === "function") widgets.set(key, (content as (t: unknown, th: unknown) => { render(w: number): string[] })(tui, theme));
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) { listeners.add(handler); return () => { listeners.delete(handler); }; },
	};
	return { ui, type(data: string) { for (const listener of [...listeners]) if (listener(data)?.consume) return true; return false; } };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("list: arrows move, letters pick actions for the selected job, Enter opens details, Esc closes", () => {
	const rows = [row({ id: "J1", name: "one" }), row({ id: "J2", name: "two" })];
	let result: ManageAction | null | undefined;
	const body = new ManageBody(() => rows, () => T0, style, () => 30, (a) => { result = a; });
	assert.match(body.render(80).join("\n"), /▸ .*one/);
	body.handleInput(KEY.down);
	assert.match(body.render(80).join("\n"), /▸ .*two/);
	body.handleInput(KEY.enter);
	assert.match(body.render(80).join("\n"), /Job ID: J2/);
	body.handleInput(KEY.esc);
	assert.equal(result, undefined, "Esc in the details only goes back");
	body.handleInput("t");
	const picked = result as unknown as { type: string; job: { id: string } };
	assert.deepEqual([picked.type, picked.job.id], ["toggle", "J2"]);
	body.handleInput("a");
	assert.deepEqual(result, { type: "add-prompt" });
	body.handleInput("m");
	assert.deepEqual(result, { type: "add-shell" });
	body.handleInput(KEY.esc);
	assert.equal(result, null);
});

test("list: empty list offers the add keys, focus starts on the remembered job, delete needs a selection", () => {
	const empty = new ManageBody(() => [], () => T0, style, () => 30, () => {});
	assert.match(empty.render(80).join("\n"), /No schedules yet/);
	const rows = [row({ id: "J1", name: "one" }), row({ id: "J2", name: "two" })];
	assert.match(new ManageBody(() => rows, () => T0, style, () => 30, () => {}, "J2").render(80).join("\n"), /▸ .*two/);
	let result: ManageAction | null | undefined;
	const none = new ManageBody(() => [], () => T0, style, () => 30, (a) => { result = a; });
	none.handleInput("x");
	assert.equal(result, undefined);
	assert.equal(orderRows(rows).length, 2);
});

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "sc-manage-"));
	mkdirSync(join(cwd, ".pi"));
	const store = new ScheduleStore(cwd), clock = new ManualClock();
	const engine = new ScheduleEngine({ store, clock, sessionId: "S1", execute: fakeExecutor({ autoFinish: true }).execute });
	const jobs = new JobService({ store, clock, sessionId: "S1", scope: () => "session", changed: () => engine.reload() });
	const ui = fakeUi();
	const ctx = {
		cwd, mode: "tui", hasUI: true,
		ui: Object.assign(ui.ui, { confirm: async () => true, select: async () => undefined, notify: () => {} }),
		sessionManager: { getSessionId: () => "S1", getBranch: () => [] },
	};
	const deps = { jobs: () => jobs, engine: () => engine, approvals: () => new CommandApprovals(), clock, activeTools: () => ["bash", "powershell"], rows: () => [] };
	return { cwd, jobs, ui, ctx, deps, done: () => { engine.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}

test("actions go through the tools: add prompt via three inputs, toggle, then delete after a confirmation", async () => {
	const s = setup();
	try {
		const adding = performAction({ type: "add-prompt" }, s.deps as never, s.ctx as never);
		for (const answer of ["nightly", "1h", "hello there"]) {
			await settle();
			for (const ch of answer) s.ui.type(ch);
			s.ui.type(KEY.enter);
		}
		assert.match((await adding) ?? "", /Created prompt job "nightly"/);
		const job = s.jobs.list(() => true)[0]!;
		assert.equal(job.kind, "prompt");
		assert.match((await performAction({ type: "toggle", job }, s.deps as never, s.ctx as never)) ?? "", /Disabled "nightly"/);
		const removing = performAction({ type: "remove", job }, s.deps as never, s.ctx as never);
		await settle();
		s.ui.type("y");
		assert.match((await removing) ?? "", /Removed prompt job "nightly"/);
		assert.equal(s.jobs.list(() => true).length, 0);
	} finally { s.done(); }
});

test("a cancelled input adds nothing", async () => {
	const s = setup();
	try {
		const adding = performAction({ type: "add-shell" }, s.deps as never, s.ctx as never);
		await settle();
		s.ui.type(KEY.esc);
		assert.equal(await adding, undefined);
		assert.equal(s.jobs.list(() => true).length, 0);
	} finally { s.done(); }
});

test("settings schema: effective values in panel units, only changed keys written in stored units, unknown keys rejected", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "sc-set-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		const schema = scheduleSettingsSchema(cwd);
		const values = schema.toValues(schema.parse({}));
		assert.equal(values.defaultJobScope, "session");
		const edited = { ...values, defaultMaxLateMs: 15, maxCatchUp: 7, panelVisible: false };
		assert.equal(await saveSettings(schema, edited, new Set(["defaultMaxLateMs", "maxCatchUp"])), undefined);
		assert.deepEqual(JSON.parse(readFileSync(schema.path, "utf8")), { defaultMaxLateMs: 900_000, maxCatchUp: 7 });
		assert.throws(() => schema.parse({ bogus: 1 }), /not a known setting/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
