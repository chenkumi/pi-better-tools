import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandApprovals } from "../src/cwd.ts";
import { ScheduleEngine } from "../src/engine.ts";
import { JobService } from "../src/jobs.ts";
import { MARKER_TYPE } from "../src/markers.ts";
import { isInScheduledExecution } from "../src/scheduled-turn.ts";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, SettingsError } from "../src/settings.ts";
import { describeSchedule, parseScheduleText } from "../src/shorthand.ts";
import { ScheduleStore } from "../src/storage.ts";
import { createPromptTool, createShellTool } from "../src/tool.ts";
import { fakeExecutor, get, makeJob, ManualClock, put, T0 } from "./helpers.ts";

function setup(options: { confirm?: boolean; hasUI?: boolean; active?: string[]; branch?: unknown[]; scope?: "session" | "workdir" } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "sc-tools-"));
	mkdirSync(join(cwd, ".pi"));
	const store = new ScheduleStore(cwd);
	const clock = new ManualClock();
	const exec = fakeExecutor({ autoFinish: true });
	const engine = new ScheduleEngine({ store, clock, sessionId: "S1", execute: exec.execute });
	const jobs = new JobService({ store, clock, sessionId: "S1", scope: () => options.scope ?? "session", changed: () => engine.reload() });
	const approvals = new CommandApprovals();
	const asked: string[] = [];
	const deps = { jobs: () => jobs, engine: () => engine, approvals: () => approvals, clock, activeTools: () => options.active ?? ["bash", "powershell"] };
	const ctx = {
		cwd, mode: "rpc", hasUI: options.hasUI ?? true,
		ui: { confirm: async (_title: string, message: string) => { asked.push(message); return options.confirm ?? true; } },
		sessionManager: { getSessionId: () => "S1", getBranch: () => options.branch ?? [] },
	};
	const run = (tool: ReturnType<typeof createPromptTool>, params: Record<string, unknown>) => tool.execute("id", params as never, undefined, undefined, ctx as never) as Promise<{ isError?: boolean; content: Array<{ text: string }>; details: { jobs: any[] } }>;
	return { cwd, store, clock, exec, engine, jobs, approvals, asked, prompt: createPromptTool(deps), shell: createShellTool(deps), run, ctx, done: () => { engine.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

test("shorthand: relative, ISO, interval and cron forms are turned into structured schedules", () => {
	const now = T0;
	assert.deepEqual(parseScheduleText("+10m", undefined, undefined, now), { type: "once", at: new Date(now + 600_000).toISOString() });
	assert.deepEqual(parseScheduleText("2h", undefined, undefined, now), { type: "interval", everyMs: 7_200_000 });
	assert.deepEqual(parseScheduleText("0 9 * * 1-5", undefined, "Asia/Taipei", now), { type: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Taipei" });
	assert.deepEqual(parseScheduleText("2030-06-01T09:00:00Z", undefined, undefined, now), { type: "once", at: "2030-06-01T09:00:00.000Z" });
	assert.throws(() => parseScheduleText("2020-01-01T00:00:00Z", "once", undefined, now), /already in the past/);
	assert.throws(() => parseScheduleText("500ms", "interval", undefined, now), /number and a unit/);
	assert.throws(() => parseScheduleText("0s", "interval", undefined, now), /at least 1s/);
	assert.throws(() => parseScheduleText("* * *", undefined, undefined, now), /5 fields/);
	assert.equal(describeSchedule({ type: "interval", everyMs: 5_400_000 }), "every 90m");
});

test("settings: layered, strict, and the project layer is ignored for an untrusted project", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "sc-agent-")), cwd = mkdtempSync(join(tmpdir(), "sc-proj-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(agentDir, "schedule-commands-settings.json"), JSON.stringify({ maxCatchUp: 3, defaultJobScope: "workdir" }));
		writeFileSync(join(cwd, ".pi", "schedule-commands-settings.json"), JSON.stringify({ maxCatchUp: 5 }));
		assert.equal(loadSettings({ agentDir, cwd, trusted: true }).maxCatchUp, 5);
		assert.equal(loadSettings({ agentDir, cwd, trusted: false }).maxCatchUp, 3);
		assert.equal(loadSettings({ agentDir, cwd, trusted: true }).defaultJobScope, "workdir");
		assert.deepEqual(loadSettings({ agentDir: join(agentDir, "none"), cwd: join(cwd, "none"), trusted: true }), DEFAULT_SETTINGS);
		assert.throws(() => parseSettings('{"bogus":1}'), /bogus is not a known setting/);
		assert.throws(() => parseSettings('{"maxCatchUp":0}'), /integer from 1 to 100/);
		assert.throws(() => parseSettings("nope"), SettingsError);
	} finally { rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("scheduled-turn: recognises a delivered scheduled prompt and a notifying agent result, not older runs", () => {
	const user = (t: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
	const marker = (details: object) => ({ type: "custom_message", customType: MARKER_TYPE, details });
	const sm = (branch: unknown[]) => ({ getBranch: () => branch });
	assert.equal(isInScheduledExecution(sm([user("hello")])), false);
	assert.equal(isInScheduledExecution(sm([user("hi"), marker({ kind: "prompt", phase: "start", prompt: "check" }), user("check")])), true);
	assert.equal(isInScheduledExecution(sm([user("hi"), marker({ kind: "prompt", phase: "start", prompt: "check" }), user("check"), user("thanks")])), false, "an older scheduled run behind a later user message");
	assert.equal(isInScheduledExecution(sm([user("hi"), marker({ kind: "agent", phase: "done", notify: true })])), true);
	assert.equal(isInScheduledExecution(sm([user("hi"), marker({ kind: "agent", phase: "done" })])), false, "without notify nothing wakes the agent");
});

test("schedule_prompt: add, list, status, update, disable/enable, remove, cleanup", async () => {
	const t = setup();
	try {
		const added = await t.run(t.prompt, { action: "add", name: "daily", schedule: "30m", prompt: "check build" });
		assert.equal(added.isError, undefined, text(added));
		const id = added.details.jobs[0].id;
		assert.equal(get(t.store, id).state.nextDue, new Date(T0 + 1_800_000).toISOString());
		assert.match(text(await t.run(t.prompt, { action: "list" })), new RegExp(`${id} \\| daily \\| prompt \\| enabled \\| every 30m`));
		assert.match(text(await t.run(t.prompt, { action: "status", jobId: id })), /Prompt: check build/);
		const updated = await t.run(t.prompt, { action: "update", jobId: id, schedule: "1h", description: "d" });
		assert.equal(get(t.store, id).state.nextDue, new Date(T0 + 3_600_000).toISOString());
		assert.equal(updated.isError, undefined, text(updated));
		assert.match(text(await t.run(t.prompt, { action: "disable", jobId: id })), /Disabled/);
		assert.match(text(await t.run(t.prompt, { action: "cleanup" })), /Removed 1 disabled/);
		assert.equal(t.store.read().store.jobs.length, 0);
		const again = await t.run(t.prompt, { action: "add", schedule: "5m", prompt: "p" });
		await t.run(t.prompt, { action: "remove", jobId: again.details.jobs[0].id });
		assert.equal(t.store.read().store.jobs.length, 0);
	} finally { t.done(); }
});

test("schedule_prompt: agent jobs need a model for their options, names are unique, errors name arguments only", async () => {
	const t = setup();
	try {
		const agent = await t.run(t.prompt, { action: "add", name: "a", schedule: "1h", prompt: "p", model: "x/y", notify: true });
		assert.equal(agent.details.jobs[0].kind, "agent");
		assert.match(text(await t.run(t.prompt, { action: "add", schedule: "1h", prompt: "p", notify: true })), /only apply together with model/);
		assert.match(text(await t.run(t.prompt, { action: "add", name: "a", schedule: "1h", prompt: "p" })), /name: a job named "a" already exists/);
		assert.match(text(await t.run(t.prompt, { action: "add", schedule: "1h" })), /add needs prompt/);
		assert.match(text(await t.run(t.prompt, { action: "add", schedule: "1h", prompt: "p", command: "ls" })), /not accepted by schedule_prompt; use schedule_shell/);
		assert.match(text(await t.run(t.prompt, { action: "add", schedule: "1h", prompt: "p", endAt: null })), /only allowed on update/);
		const bad = await t.run(t.prompt, { action: "add", schedule: "0 0 0 0 0 0 0", prompt: "p" });
		assert.equal(bad.isError, true);
		assert.ok(!/schedule-commands\.json|\.pi[\\/]/.test(text(bad)), "no storage path in errors");
		assert.match(text(await t.run(t.prompt, { action: "update", jobId: agent.details.jobs[0].id, schedule: "2h", endAt: new Date(T0 + 3_600_000).toISOString() })), /no run would happen before/);
	} finally { t.done(); }
});

test("each tool manages only its own kinds and points to the other tool", async () => {
	const t = setup();
	try {
		const p = await t.run(t.prompt, { action: "add", name: "pj", schedule: "1h", prompt: "p" });
		const s = await t.run(t.shell, { action: "add", name: "sj", schedule: "1h", command: "echo", shell: "bash" });
		assert.equal(s.isError, undefined, text(s));
		assert.ok(!text(await t.run(t.shell, { action: "list" })).includes("pj"));
		assert.ok(!text(await t.run(t.prompt, { action: "list" })).includes("sj"));
		assert.match(text(await t.run(t.shell, { action: "remove", jobId: p.details.jobs[0].id })), /manage it with schedule_prompt/);
		assert.match(text(await t.run(t.prompt, { action: "remove", jobId: s.details.jobs[0].id })), /manage it with schedule_shell/);
	} finally { t.done(); }
});

test("a job of another session is hidden", async () => {
	const t = setup();
	try {
		put(t.store, makeJob({ name: "theirs", session: "OTHER" }));
		assert.match(text(await t.run(t.prompt, { action: "list" })), /No prompt jobs/);
		const missing = await t.run(t.prompt, { action: "status", jobId: "NOPE" });
		assert.match(text(missing), /was not found/);
	} finally { t.done(); }
});

test("schedule_shell: the exact command is confirmed, shown, and nothing is saved without it", async () => {
	const refused = setup({ confirm: false });
	try {
		const result = await refused.run(refused.shell, { action: "add", schedule: "1h", command: "rm -rf build", shell: "bash", timeoutMs: 5000 });
		assert.match(text(result), /did not confirm/);
		assert.equal(refused.store.read().store.jobs.length, 0);
		assert.match(refused.asked[0], /Command: rm -rf build/);
		assert.match(refused.asked[0], /Shell: bash/);
		assert.match(refused.asked[0], /Output stall limit: 5000 ms/);
	} finally { refused.done(); }
	const headless = setup({ hasUI: false });
	try {
		assert.match(text(await headless.run(headless.shell, { action: "add", schedule: "1h", command: "echo", shell: "bash" })), /needs an interactive session/);
		assert.equal(headless.store.read().store.jobs.length, 0);
	} finally { headless.done(); }
});

test("schedule_shell: the matching shell tool must be enabled, with no fallback", async () => {
	const t = setup({ active: ["powershell"] });
	try {
		const result = await t.run(t.shell, { action: "add", schedule: "1h", command: "echo", shell: "bash" });
		assert.match(text(result), /shell: "bash" needs the bash tool to be enabled/);
		assert.equal(t.asked.length, 0, "no confirmation is asked for something that cannot run");
	} finally { t.done(); }
});

test("schedule_shell: enable and a changed command are confirmed again; a job edited meanwhile is refused", async () => {
	const t = setup();
	try {
		const added = await t.run(t.shell, { action: "add", name: "s", schedule: "1h", command: "echo one", shell: "bash" });
		const id = added.details.jobs[0].id;
		await t.run(t.shell, { action: "disable", jobId: id });
		t.asked.length = 0;
		await t.run(t.shell, { action: "enable", jobId: id });
		assert.equal(t.asked.length, 1);
		await t.run(t.shell, { action: "update", jobId: id, timeoutMs: 9000 });
		assert.equal(t.asked.length, 1, "a stall limit change needs no new confirmation");
		await t.run(t.shell, { action: "update", jobId: id, command: "echo two" });
		assert.equal(t.asked.length, 2);
		assert.match(t.asked[1], /Command: echo two/);
		assert.equal((get(t.store, id) as { command: string }).command, "echo two");
		// A peer edits the job while the dialog is open.
		const racy = setup();
		try {
			const made = await racy.run(racy.shell, { action: "add", name: "r", schedule: "1h", command: "echo a", shell: "bash" });
			const rid = made.details.jobs[0].id;
			await racy.run(racy.shell, { action: "disable", jobId: rid });
			(racy.ctx.ui as { confirm: unknown }).confirm = async () => {
				racy.store.update((jobs) => ({ jobs: jobs.map((j) => (j.id === rid ? ({ ...j, command: "echo evil" } as typeof j) : j)), result: undefined }));
				return true;
			};
			assert.match(text(await racy.run(racy.shell, { action: "enable", jobId: rid })), /changed while waiting for confirmation/);
			assert.equal(get(racy.store, rid).enabled, false);
		} finally { racy.done(); }
	} finally { t.done(); }
});

test("a scheduled turn can list, inspect, disable and remove, but not add, update, enable, clean up or run", async () => {
	const user = (t: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
	const branch = [user("hi"), { type: "custom_message", customType: MARKER_TYPE, details: { kind: "prompt", phase: "start", prompt: "tick" } }, user("tick")];
	const t = setup({ branch });
	try {
		const seeded = makeJob({ name: "x" });
		put(t.store, seeded);
		for (const action of ["add", "update", "enable", "cleanup", "run_now"]) {
			const result = await t.run(t.prompt, { action, jobId: seeded.id, schedule: "1h", prompt: "p" });
			assert.equal(result.isError, true, action);
			assert.match(text(result), /not available from within a scheduled run/, action);
		}
		for (const action of ["list", "status", "disable", "remove"]) assert.equal((await t.run(t.prompt, { action, jobId: seeded.id })).isError, undefined, action);
	} finally { t.done(); }
});

test("run_now starts a job once without touching its schedule; a shell run_now is confirmed", async () => {
	const t = setup();
	try {
		const added = await t.run(t.prompt, { action: "add", name: "n", schedule: "1h", prompt: "go" });
		const id = added.details.jobs[0].id;
		const before = get(t.store, id).state.nextDue;
		const started = await t.run(t.prompt, { action: "run_now", jobId: id });
		assert.equal(started.isError, undefined, text(started));
		await t.clock.settle();
		assert.equal(t.exec.calls.length, 1);
		assert.equal(get(t.store, id).state.nextDue, before);
		assert.equal(get(t.store, id).state.runCount, 1);
		const shell = await t.run(t.shell, { action: "add", name: "s", schedule: "1h", command: "echo", shell: "bash" });
		t.asked.length = 0;
		await t.run(t.shell, { action: "run_now", jobId: shell.details.jobs[0].id });
		assert.equal(t.asked.length, 1);
	} finally { t.done(); }
});

test("workdir scope leaves new jobs unbound; session scope binds them", async () => {
	const w = setup({ scope: "workdir" });
	try {
		const added = await w.run(w.prompt, { action: "add", schedule: "1h", prompt: "p" });
		assert.equal(get(w.store, added.details.jobs[0].id).session, undefined);
	} finally { w.done(); }
	const s = setup();
	try {
		const added = await s.run(s.prompt, { action: "add", schedule: "1h", prompt: "p" });
		assert.equal(get(s.store, added.details.jobs[0].id).session, "S1");
	} finally { s.done(); }
});
