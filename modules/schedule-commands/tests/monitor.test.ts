import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScheduledMonitorStarter } from "../../../shared/src/background/index.ts";
import { CommandApprovals } from "../src/cwd.ts";
import { ScheduleEngine } from "../src/engine.ts";
import { JobService } from "../src/jobs.ts";
import { monitorProblem, runMonitorJob } from "../src/monitor-link.ts";
import { ScheduleStore } from "../src/storage.ts";
import { createMonitorTool, createPromptTool } from "../src/tool.ts";
import { fakeExecutor, makeJob, ManualClock } from "./helpers.ts";

interface Fake extends ScheduledMonitorStarter { started: unknown[]; active: Set<string>; failWith?: string }
function fakeStarter(): Fake {
	const f: Fake = {
		started: [], active: new Set(),
		validate: (params) => ((params as { source?: { path?: string } }).source?.path === "bad" ? "path is outside the workspace" : undefined),
		start(params) {
			if (f.failWith) return { error: f.failWith };
			f.started.push(params);
			const id = `mon-${f.started.length}`;
			f.active.add(id);
			return { monitorId: id };
		},
		isActive: (id) => f.active.has(id),
	};
	return f;
}

function setup(options: { active?: string[]; confirm?: boolean; starter?: Fake } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "sc-mon-"));
	mkdirSync(join(cwd, ".pi"));
	const store = new ScheduleStore(cwd), clock = new ManualClock();
	const engine = new ScheduleEngine({ store, clock, sessionId: "S1", execute: fakeExecutor({ autoFinish: true }).execute });
	const jobs = new JobService({ store, clock, sessionId: "S1", scope: () => "session", changed: () => engine.reload() });
	const asked: string[] = [];
	const starter = options.starter ?? fakeStarter();
	const deps = { jobs: () => jobs, engine: () => engine, approvals: () => new CommandApprovals(), clock, activeTools: () => options.active ?? ["bash", "powershell", "schedule_shell", "schedule_monitor"], monitor: () => starter };
	const ctx = {
		cwd, mode: "rpc", hasUI: true,
		ui: { confirm: async (_t: string, message: string) => { asked.push(message); return options.confirm ?? true; } },
		sessionManager: { getSessionId: () => "S1", getBranch: () => [] },
	};
	const tool = createMonitorTool(deps);
	const run = (params: Record<string, unknown>, t: { execute: unknown } = tool) => (t.execute as (...a: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }>; details: { jobs: Array<{ id: string }> } }>)("id", params, undefined, undefined, ctx);
	return { asked, starter, run, jobs, prompt: createPromptTool(deps), done: () => { engine.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const FILE = { source: { kind: "file", path: "a.txt" } };

test("monitorProblem: only command, file and system sources; command needs schedule_shell and its shell tool", () => {
	const all = ["bash", "powershell", "schedule_shell"];
	assert.equal(monitorProblem({ source: { kind: "file", path: "a" } }, []), undefined);
	assert.match(monitorProblem({ source: { kind: "websocket" } }, all) ?? "", /not available to schedules/);
	assert.match(monitorProblem({ source: { kind: "shell_job" } }, all) ?? "", /not available to schedules/);
	assert.match(monitorProblem({ source: { kind: "command", tool: "bash", command: "x" } }, ["bash", "powershell"]) ?? "", /schedule_shell/);
	assert.match(monitorProblem({ source: { kind: "command", tool: "bash", command: "x" } }, ["schedule_shell", "powershell"]) ?? "", /needs the bash tool/);
	assert.equal(monitorProblem({ source: { kind: "command", tool: "bash", command: "x" } }, all), undefined);
});

test("schedule_monitor add: confirms interactively, shows the source, and stores a monitor job", async () => {
	const t = setup();
	try {
		const added = await t.run({ action: "add", name: "watch", schedule: "1h", start: { ...FILE, label: "l" } });
		assert.equal(added.isError, undefined, text(added));
		assert.equal(added.details.jobs[0] && (added.details.jobs[0] as unknown as { kind: string }).kind, "monitor");
		assert.match(t.asked[0], /file metadata of a\.txt/);
		assert.match(t.asked[0], /Does not wake the agent/);
		assert.match(text(await t.run({ action: "list" })), /watch \| monitor/);
	} finally { t.done(); }
});

test("schedule_monitor add: refusals leave nothing stored", async () => {
	const t = setup({ active: ["bash", "schedule_monitor"] });
	try {
		assert.match(text(await t.run({ action: "add", schedule: "1h" })), /add needs start/);
		assert.match(text(await t.run({ action: "add", schedule: "1h", start: { source: { kind: "websocket" } } })), /not available to schedules/);
		assert.match(text(await t.run({ action: "add", schedule: "1h", start: { source: { kind: "command", tool: "bash", command: "x" } } })), /needs the schedule_shell tool/);
		assert.match(text(await t.run({ action: "add", schedule: "1h", start: { source: { kind: "file", path: "bad" } } })), /start: path is outside the workspace/);
		assert.match(text(await t.run({ action: "add", schedule: "1h", start: FILE, missed: "run-all" })), /run-all/);
		assert.match(text(await t.run({ action: "list" })), /No monitor jobs/);
	} finally { t.done(); }
	const declined = setup({ confirm: false });
	try {
		assert.match(text(await declined.run({ action: "add", schedule: "1h", start: FILE })), /did not confirm/);
		assert.match(text(await declined.run({ action: "list" })), /No monitor jobs/);
	} finally { declined.done(); }
});

test("a command source shows the exact command and wakeAgent warning in the confirmation", async () => {
	const t = setup();
	try {
		const added = await t.run({ action: "add", name: "cmd", schedule: "1h", start: { source: { kind: "command", tool: "bash", command: "tail -f log" }, wakeAgent: true } });
		assert.equal(added.isError, undefined, text(added));
		assert.match(t.asked[0], /Command: tail -f log/);
		assert.match(t.asked[0], /WAKES THE AGENT/);
		assert.match(t.asked[0], /not a sandbox/);
	} finally { t.done(); }
});

test("update and enable: a changed start or a re-enable asks again; tools manage only their own kinds", async () => {
	const t = setup();
	try {
		const id = (await t.run({ action: "add", name: "w", schedule: "1h", start: FILE })).details.jobs[0].id;
		t.asked.length = 0;
		assert.equal((await t.run({ action: "update", jobId: id, schedule: "2h" })).isError, undefined);
		assert.equal(t.asked.length, 0, "a schedule-only change needs no confirmation");
		assert.equal((await t.run({ action: "update", jobId: id, start: { source: { kind: "file", path: "b.txt" } } })).isError, undefined);
		assert.match(t.asked[0], /Change "w"/);
		await t.run({ action: "disable", jobId: id });
		t.asked.length = 0;
		assert.equal((await t.run({ action: "enable", jobId: id })).isError, undefined);
		assert.match(t.asked[0], /Enable "w"/);
		assert.match(text(await t.run({ action: "remove", jobId: id }, t.prompt)), /manage it with schedule_monitor/);
	} finally { t.done(); }
});

test("run: starts a monitor once, skips while it still runs, reports refusals as errors", async () => {
	const starter = fakeStarter();
	const sent: unknown[] = [];
	const last = new Map<string, string>();
	const deps = (tools: string[]) => ({ pi: { sendMessage: (m: unknown) => sent.push(m) } as never, context: () => ({}) as never, activeTools: () => tools, starter: () => starter, last });
	const job = makeJob({ kind: "monitor", id: "J1", start: { ...FILE } }) as never;
	const info = { scheduledFor: "2030-01-01T00:00:00.000Z" };
	const first = runMonitorJob(deps(["x"]), job, info);
	assert.equal(await first.started, true);
	assert.equal((await first.done).status, "success");
	assert.deepEqual(starter.started, [{ source: { kind: "file", path: "a.txt" } }]);
	const again = runMonitorJob(deps(["x"]), job, info);
	assert.equal((await again.done).status, "skipped");
	assert.equal(starter.started.length, 1, "no second watch while the first runs");
	starter.active.clear();
	assert.equal((await runMonitorJob(deps(["x"]), job, info).done).status, "success");
	starter.failWith = "Monitor active capacity is 4";
	starter.active.clear();
	const refused = await runMonitorJob(deps(["x"]), job, info).done;
	assert.deepEqual([refused.status, refused.error], ["error", "Monitor active capacity is 4"]);
	const noShell = await runMonitorJob(deps(["x"]), makeJob({ kind: "monitor", start: { source: { kind: "command", tool: "bash", command: "x" } } }) as never, info).done;
	assert.match(noShell.error!, /schedule_shell/);
	const missing = await runMonitorJob({ ...deps(["x"]), starter: () => undefined }, job, info).done;
	assert.match(missing.error!, /Monitor is not available/);
});
