import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bottomConfirm } from "../../../shared/src/bottom-panel/index.ts";
import { isManagedForegroundChild } from "../../../shared/src/background/index.ts";
import { ToolError } from "../../../shared/src/tool-error/index.ts";
import { jsonResult as output } from "../../../shared/src/tool-result/index.ts";
import { createGoalHost } from "./child.ts";
import { claim, otherOwner, release } from "./lock.ts";
import { PlanSchema, validatePlan, type Plan } from "./plan.ts";
import { GoalPanel, type GoalRow } from "./panel.ts";
import { renderCall, renderResult } from "./render.ts";
import { GoalRunner, type GoalHost } from "./runner.ts";
import { createGoal, goalsDir, listGoals, loadGoal, summarize, type GoalRecord } from "./store.ts";
import { join } from "node:path";

const strict = { additionalProperties: false };
export const goalNamespace = {
	name: "goal",
	description: "To submit a settled plan as a goal (only after /goal), or to inspect, cancel or continue the goals of this project, use tool_search to find and load the goal tools.",
};
export const GOAL_MESSAGE = "goal-result";

const clip = (text: string, max: number): string => (text.length > max ? `…${text.slice(text.length - max)}` : text);

/** What the user is asked to confirm: the plan's goal, the rules and every command that will be run. */
export function confirmText(plan: Plan): string {
	const checkpoints = plan.checkpoints.map((checkpoint) => `${checkpoint.index}. ${checkpoint.title}${checkpoint.verify.command ? `  [runs: ${checkpoint.verify.command}]` : `  [tier ${checkpoint.verify.tier}: needs a person or a review]`}`);
	return [plan.goal, ...(plan.rules.length > 0 ? ["", "Rules:", ...plan.rules.map((rule) => `- ${rule}`)] : []), "", "Checkpoints:", ...checkpoints].join("\n");
}

/** What the agent is told when a goal has nothing more to run. */
export function resultText(plan: Plan, record: GoalRecord, dir: string): string {
	const lines = [`Goal ${record.id} "${plan.title}" ${record.status === "done" ? "is done" : `stopped: ${record.status}`}.`];
	for (const checkpoint of plan.checkpoints) {
		const entry = record.checkpoints.find((candidate) => candidate.index === checkpoint.index)!;
		lines.push(`${checkpoint.index}. ${checkpoint.title}: ${entry.status} (attempt${entry.attempts === 1 ? "" : "s"}: ${entry.attempts}/${checkpoint.verify.maxAttempts})`);
		if (record.status !== "done" && entry.status !== "done" && entry.log.length > 0) lines.push(`   ${clip(entry.log.at(-1)!, 800).replace(/\n/g, "\n   ")}`);
	}
	lines.push(`Plan and log: ${join(dir, "plan.md")}`);
	if (record.status === "blocked") lines.push("Load the goal tools with tool_search \"goal\": goal_retry queues a failed or skipped checkpoint again; goal_resolve records what a person checked.");
	return lines.join("\n");
}

const goalId = Type.String({ minLength: 26, maxLength: 26, description: "The goal's id, as plan_submit or goal_status gave it." });
const checkpointNumber = Type.Integer({ minimum: 1, description: "The checkpoint's number." });

export default function goalExtension(pi: ExtensionAPI, seam: { host?: (context: () => ExtensionContext) => GoalHost } = {}): void {
	// A managed child (Subagent or Spinoff) plans nothing: only the session the user talks to submits and runs goals.
	if (isManagedForegroundChild()) return;
	let current: ExtensionContext | undefined;
	const context = (): ExtensionContext => current ?? (() => { throw new ToolError("GOAL_NO_SESSION", "No session is active."); })();
	// What the Jobs panel shows: the goals of this session's project, kept in memory (the files stay the truth).
	const rows = new Map<string, GoalRow>();
	const panel = new GoalPanel();
	const runner = new GoalRunner(seam.host ? seam.host(context) : createGoalHost(context, () => pi.getThinkingLevel()), (dir, record) => {
		const row = rows.get(dir);
		if (row) { rows.set(dir, { plan: row.plan, record }); panel.refresh(); }
	});

	const dirOf = (cwd: string, id: string): string => {
		if (!/^[0-9A-Za-z]{26}$/.test(id)) throw new ToolError("GOAL_UNKNOWN", `Unknown goal: ${id}`);
		return join(goalsDir(cwd), id.toUpperCase());
	};

	const tell = (text: string, details: Record<string, unknown>): void => {
		try { pi.sendMessage({ customType: GOAL_MESSAGE, display: true, content: text, details }, { triggerTurn: true, deliverAs: "steer" }); }
		catch { /* the session may be shutting down; the goal's files keep the result */ }
	};

	/** Runs (or continues) the goal in this process unless another live process already runs it, and tells the agent how it ended. */
	const begin = (dir: string): void => {
		void (async () => {
			if (runner.isRunning(dir) || !(await claim(dir))) return;
			try {
				const record = await runner.start(dir);
				// A goal left in progress (this process is stopping) says nothing: the next session continues it.
				if (record.status === "done" || record.status === "blocked" || record.status === "failed") tell(resultText((await loadGoal(dir)).plan, record, dir), { goalId: record.id, status: record.status });
			} catch (error) {
				tell(`Goal ${dir.slice(-26)} did not run: ${error instanceof Error ? error.message : String(error)}`, { goalId: dir.slice(-26), status: "failed" });
			} finally {
				await release(dir).catch(() => undefined);
			}
		})();
	};

	/** The goal is not being run by another process: changing its files now would race with it. */
	const free = async (dir: string): Promise<void> => {
		const pid = await otherOwner(dir);
		if (pid !== undefined) throw new ToolError("GOAL_RUNNING_ELSEWHERE", `The goal is being run by another Pi process (pid ${pid}); do it from that session.`);
	};

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		rows.clear();
		panel.bind(ctx, () => [...rows.values()]);
		for (const { dir, plan, record } of await listGoals(ctx.cwd)) rows.set(dir, { plan, record });
		panel.refresh();
		// After a restart, goals that were queued or running go on from their files. A project that is not trusted runs nothing.
		if (!ctx.isProjectTrusted()) return;
		for (const [dir, { record }] of rows) if (record.status === "queued" || record.status === "running") begin(dir);
	});
	pi.on("session_shutdown", async () => { panel.clear(); await runner.stopAll(); });

	pi.registerTool({
		exposure: "deferred", namespace: goalNamespace, name: "plan_submit", label: "Submit plan",
		description:
			"Hands a settled plan for a long-running goal to the goal runner, which carries it out step by step in the background without the user watching. Call it only when the user asked for a plan to be carried out that way and every open question is already answered with them: the plan has no place for open questions, so ask them first and record each answer in `decisions`. The plan is checked; a problem comes back as an error to fix, then submit again. The user then confirms before anything starts. The plan can only be read by whoever runs it: put everything they need in the goal, rules, decisions and todos.",
		promptSnippet: "Submit a settled plan to run as a goal",
		parameters: PlanSchema,
		renderCall: renderCall("plan_submit", (args) => args.title), renderResult: renderResult("plan_submit"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			current = ctx;
			const checked = validatePlan(params);
			if (!checked.ok) throw new ToolError("GOAL_PLAN_INVALID", `The plan was not accepted. Fix these and submit it again:\n${checked.errors.map((error) => `- ${error}`).join("\n")}`);
			if (!ctx.hasUI) throw new ToolError("GOAL_NEEDS_UI", "A goal needs an interactive session so the user can confirm it; nothing was saved.");
			if (!ctx.isProjectTrusted()) throw new ToolError("GOAL_PROJECT_NOT_TRUSTED", "A goal runs commands and changes files without the user watching, so the project must be trusted first; nothing was saved. Tell the user they can trust the folder and ask again.");
			signal?.throwIfAborted();
			if (!(await bottomConfirm(ctx, `Start this goal? ${checked.plan.title}`, confirmText(checked.plan), { signal }))) {
				throw new ToolError("GOAL_NOT_CONFIRMED", "The user did not confirm the plan; nothing was saved. Ask what they want changed, then submit the revised plan.");
			}
			const { id, dir, record } = await createGoal(ctx.cwd, checked.plan);
			rows.set(dir, { plan: checked.plan, record });
			panel.refresh();
			begin(dir);
			return output({ ok: true, goalId: id, dir, checkpoints: checked.plan.checkpoints.length, note: "Queued; it runs in the background and you are told when it ends. goal_status shows the progress." });
		},
	});

	pi.registerTool({
		exposure: "deferred", namespace: goalNamespace, name: "goal_status", label: "Goal Status",
		description: "Lists the goals of this project (id, title, status, checkpoints done), or with `goalId` one goal's checkpoints, attempts and the latest verification log of each.",
		promptSnippet: "Show the goals of this project and their progress",
		parameters: Type.Object({ goalId: Type.Optional(goalId) }, strict),
		renderCall: renderCall("goal_status", (args) => args.goalId), renderResult: renderResult("goal_status"),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			current = ctx;
			if (!params.goalId) {
				const goals = (await listGoals(ctx.cwd)).map(({ plan, record }) => summarize(plan, record));
				return output({ goals: goals.map((goal) => ({ goalId: goal.goalId, title: goal.title, status: goal.status, done: goal.checkpoints.filter((checkpoint) => checkpoint.status === "done").length, checkpoints: goal.checkpoints.length })) });
			}
			const dir = dirOf(ctx.cwd, params.goalId);
			const loaded = await loadGoal(dir).catch(() => { throw new ToolError("GOAL_UNKNOWN", `Unknown goal: ${params.goalId}`); });
			const goal = summarize(loaded.plan, loaded.record);
			return output({ ...goal, checkpoints: goal.checkpoints.map((checkpoint) => ({ ...checkpoint, log: checkpoint.log.slice(-1).map((entry) => clip(entry, 1500)) })), dir });
		},
	});

	pi.registerTool({
		exposure: "deferred", namespace: goalNamespace, name: "goal_cancel", label: "Cancel Goal",
		description: "Stops a goal: the checkpoint in progress is stopped and the goal is cancelled, with what was done kept. A goal that already ended is not changed.",
		parameters: Type.Object({ goalId }, strict),
		renderCall: renderCall("goal_cancel", (args) => args.goalId), renderResult: renderResult("goal_cancel"),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			current = ctx;
			const dir = dirOf(ctx.cwd, params.goalId);
			await free(dir);
			const record = await runner.cancel(dir).catch(() => { throw new ToolError("GOAL_UNKNOWN", `Unknown goal: ${params.goalId}`); });
			return output({ goalId: record.id, status: record.status });
		},
	});

	pi.registerTool({
		exposure: "deferred", namespace: goalNamespace, name: "goal_retry", label: "Retry Goal Checkpoint",
		description: "Queues a failed or skipped checkpoint of a blocked goal again (with fresh attempts) and runs the goal on.",
		parameters: Type.Object({ goalId, index: checkpointNumber }, strict),
		renderCall: renderCall("goal_retry", (args) => `${String(args.goalId)} #${String(args.index)}`), renderResult: renderResult("goal_retry"),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			current = ctx;
			const dir = dirOf(ctx.cwd, params.goalId);
			await free(dir);
			const record = await runner.retry(dir, params.index).catch((error: unknown) => { throw new ToolError("GOAL_REJECTED", error instanceof Error ? error.message : String(error)); });
			begin(dir);
			return output({ goalId: record.id, status: record.status });
		},
	});

	pi.registerTool({
		exposure: "deferred", namespace: goalNamespace, name: "goal_resolve", label: "Resolve Goal Checkpoint",
		description: "Records the result of a checkpoint that needed a person (a hands-on check, or a review that gave no verdict): passed or not, with a note, and runs the goal on.",
		parameters: Type.Object({ goalId, index: checkpointNumber, passed: Type.Boolean({ description: "Whether the person found it correct." }), note: Type.String({ minLength: 1, description: "What was checked and what was seen." }) }, strict),
		renderCall: renderCall("goal_resolve", (args) => `${String(args.goalId)} #${String(args.index)} ${args.passed ? "passed" : "failed"}`), renderResult: renderResult("goal_resolve"),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			current = ctx;
			const dir = dirOf(ctx.cwd, params.goalId);
			await free(dir);
			const record = await runner.resolve(dir, params.index, params.passed, params.note).catch((error: unknown) => { throw new ToolError("GOAL_REJECTED", error instanceof Error ? error.message : String(error)); });
			begin(dir);
			return output({ goalId: record.id, status: record.status });
		},
	});
}
