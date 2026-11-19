// The extension: plan_submit (checks, trust, confirmation), the background run and its message to the agent, and the goal tools.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import extension, { confirmText, resultText } from "../src/index.ts";
import { claim, release } from "../src/lock.ts";
import { loadGoal } from "../src/store.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "goal-ext-")));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* a locked file on Windows */ } });
let n = 0;
const project = () => { const dir = join(root, `p${n++}`); mkdirSync(dir); return dir; };

const plan = (command = "check", maxAttempts = 1) => ({
	title: "t", goal: "g", references: [], rules: ["r1"], decisions: [],
	checkpoints: [{ title: "one", todos: ["do one"], dependsOn: [], verify: { tier: 1, command, expected: "passes", maxAttempts } }],
});

/** The extension in a fake Pi: tools and handlers by name, messages sent to the agent. A host double answers what the runs do. */
function load(cwd, { trusted = true, hasUI = true, confirm = true, host = {} } = {}) {
	const tools = new Map(), handlers = new Map(), commands = new Map(), sent = [], asked = [];
	const fakeHost = { trusted: async () => true, implement: async () => ({ ok: true, summary: "did it" }), review: async () => ({ ok: true, summary: "VERDICT: PASS" }), check: async () => ({ exitCode: 0, output: "ok" }), ...host };
	extension({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, definition) => commands.set(name, definition),
		on: (event, handler) => handlers.set(event, handler),
		sendMessage: (message, options) => sent.push({ message, options }),
		getThinkingLevel: () => "off",
	}, { host: () => fakeHost });
	const ctx = { cwd, hasUI, mode: "rpc", isProjectTrusted: () => trusted, ui: { confirm: async (title, text) => (asked.push({ title, text }), confirm) } };
	const call = (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	const start = () => handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const stop = () => handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
	return { tools, commands, sent, asked, call, start, stop, ctx };
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20)); assert.ok(check(), "timed out"); };

describe("plan_submit", () => {
	it("registers the goal tools as deferred tools of one namespace", () => {
		const { tools } = load(project());
		assert.deepEqual([...tools.keys()].sort(), ["goal_cancel", "goal_pause", "goal_resolve", "goal_resume", "goal_retry", "goal_status", "plan_submit"]);
		for (const tool of tools.values()) assert.deepEqual([tool.exposure, tool.namespace.name], ["deferred", "goal"]);
	});

	it("registers /goals, whose actions run the same goal_* tools", async () => {
		const ext = load(project());
		assert.ok(ext.commands.get("goals"), "the /goals command is registered");
		let started = false;
		const running = load(project(), { host: { implement: (_task, signal) => new Promise((resolve) => { started = true; signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped" })); }) } });
		const { details } = await running.call("plan_submit", plan());
		await until(() => started);
		assert.equal((await running.call("goal_pause", { goalId: details.goalId })).details.status, "paused");
	});

	it("saves a confirmed plan, runs it in the background and tells the agent how it ended", async () => {
		const cwd = project();
		const ext = load(cwd);
		const result = await ext.call("plan_submit", plan());
		assert.equal(result.details.ok, true);
		assert.match(ext.asked[0].text, /\[runs: check\]/);
		await until(() => ext.sent.length > 0);
		const { message, options } = ext.sent[0];
		assert.equal(message.customType, "goal-result");
		assert.match(message.content, /is done/);
		assert.deepEqual([options.triggerTurn, options.deliverAs], [true, "steer"]);
		assert.equal((await loadGoal(result.details.dir)).record.status, "done");
		await until(() => !existsSync(join(result.details.dir, "owner.json")));
	});

	it("saves nothing when the plan is wrong, the project is not trusted, there is no UI or the user declines", async () => {
		const cases = [
			[{ trusted: true }, { ...plan(), checkpoints: [] }, /GOAL_PLAN_INVALID/],
			[{ trusted: false }, plan(), /GOAL_PROJECT_NOT_TRUSTED/],
			[{ hasUI: false }, plan(), /GOAL_NEEDS_UI/],
			[{ confirm: false }, plan(), /GOAL_NOT_CONFIRMED/],
		];
		for (const [options, input, error] of cases) {
			const cwd = project();
			const ext = load(cwd, options);
			await assert.rejects(ext.call("plan_submit", input), error);
			assert.ok(!existsSync(join(cwd, ".pi", "goals")), `${error} saved a goal`);
		}
	});

	it("reports a blocked goal with what failed and how to go on", async () => {
		const ext = load(project(), { host: { check: async () => ({ exitCode: 1, output: "boom" }) } });
		await ext.call("plan_submit", plan());
		await until(() => ext.sent.length > 0);
		assert.match(ext.sent[0].message.content, /stopped: blocked[\s\S]*boom[\s\S]*goal_retry/);
	});
});

describe("goal tools", () => {
	it("lists goals and shows one, retries a failed checkpoint and refuses to change one that ended", async () => {
		let healthy = false;
		const ext = load(project(), { host: { check: async () => ({ exitCode: healthy ? 0 : 1, output: "x" }) } });
		const { details } = await ext.call("plan_submit", plan());
		await until(() => ext.sent.length === 1);
		await until(() => !existsSync(join(details.dir, "owner.json")));
		assert.deepEqual((await ext.call("goal_status", {})).details.goals.map((goal) => [goal.status, goal.done]), [["blocked", 0]]);
		assert.equal((await ext.call("goal_status", { goalId: details.goalId })).details.checkpoints[0].status, "failed");
		healthy = true;
		assert.equal((await ext.call("goal_retry", { goalId: details.goalId, index: 1 })).details.status, "queued");
		await until(() => ext.sent.length === 2);
		assert.match(ext.sent[1].message.content, /is done/);
		await assert.rejects(ext.call("goal_status", { goalId: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ" }), /GOAL_UNKNOWN/);
		await assert.rejects(ext.call("goal_status", { goalId: "../../../../etc/passwd-xxxxxx" }), /GOAL_UNKNOWN/);
		await until(() => !existsSync(join(details.dir, "owner.json")));
		assert.equal((await ext.call("goal_cancel", { goalId: details.goalId })).details.status, "done", "a goal that ended is not changed");
	});

	it("cancels a goal that is running and stops its run", async () => {
		let started = false;
		const ext = load(project(), { host: { implement: (_task, signal) => new Promise((resolve) => { started = true; signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped" })); }) } });
		const { details } = await ext.call("plan_submit", plan());
		await until(() => started);
		assert.equal((await ext.call("goal_cancel", { goalId: details.goalId })).details.status, "cancelled");
	});

	it("pauses a running goal, reports nothing, and resumes it on request", async () => {
		let started = false, round = 0;
		const ext = load(project(), { host: { implement: (_task, signal) => { if (round++ > 0) return { ok: true, summary: "done" }; return new Promise((resolve) => { started = true; signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped" })); }); } } });
		const { details } = await ext.call("plan_submit", plan());
		await until(() => started);
		const pausedResult = await ext.call("goal_pause", { goalId: details.goalId });
		assert.equal(pausedResult.details.status, "paused");
		assert.match(pausedResult.details.note, /already changed stays in the project folder/);
		await assert.rejects(ext.call("goal_resume", { goalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }), /GOAL_UNKNOWN/);
		assert.equal(ext.sent.length, 0, "a pause is not an ending, so nothing is reported");
		assert.equal((await ext.call("goal_resume", { goalId: details.goalId })).details.status, "queued");
		await until(() => ext.sent.length > 0);
		assert.match(ext.sent[0].message.content, /done/);
		await assert.rejects(ext.call("goal_pause", { goalId: details.goalId }), /GOAL_REJECTED/);
	});

	it("leaves a goal that another live process runs alone", async () => {
		const ext = load(project());
		const { details } = await ext.call("plan_submit", plan("check"));
		await until(() => ext.sent.length === 1);
		await until(() => !existsSync(join(details.dir, "owner.json")));
		writeFileSync(join(details.dir, "owner.json"), JSON.stringify({ pid: process.ppid }));
		await assert.rejects(ext.call("goal_retry", { goalId: details.goalId, index: 1 }), /GOAL_RUNNING_ELSEWHERE/);
		assert.equal(await claim(details.dir), false);
		rmSync(join(details.dir, "owner.json"));
		assert.equal(await claim(details.dir), true);
		await release(details.dir);
	});
});

describe("after a restart", () => {
	it("continues a goal that was stopped with its session, only in a trusted project", async () => {
		const cwd = project();
		let started = false;
		const first = load(cwd, { host: { implement: (_task, signal) => new Promise((resolve) => { started = true; signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped" })); }) } });
		const { details } = await first.call("plan_submit", plan("check", 2));
		await until(() => started);
		await first.stop();
		assert.equal(first.sent.length, 0, "a run stopped with the session says nothing");
		assert.equal((await loadGoal(details.dir)).record.status, "running");

		const untrusted = load(cwd, { trusted: false });
		await untrusted.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(untrusted.sent.length, 0);

		const next = load(cwd);
		await next.start();
		await until(() => next.sent.length > 0);
		assert.match(next.sent[0].message.content, /is done/);
		assert.equal((await loadGoal(details.dir)).record.checkpoints[0].attempts, 2, "the interrupted attempt counts");
	});
});

describe("texts", () => {
	it("shows the user the goal, the rules and every command before anything starts", () => {
		assert.match(confirmText(validated(plan("npm test"))), /g\n\nRules:\n- r1\n\nCheckpoints:\n1\. one {2}\[runs: npm test\]/);
	});
	it("names each checkpoint of a result", () => {
		const text = resultText(validated(plan()), { id: "A", status: "done", checkpoints: [{ index: 1, status: "done", attempts: 1, log: [] }] }, "/d");
		assert.match(text, /is done\.\n1\. one: done \(attempt: 1\/1\)/);
	});
});

function validated(input) {
	return { ...input, checkpoints: input.checkpoints.map((checkpoint, at) => ({ ...checkpoint, index: at + 1 })) };
}
