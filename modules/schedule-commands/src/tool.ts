/**
 * `schedule_prompt` (prompt and agent jobs) and `schedule_shell` (shell command jobs). One stored list, but each tool
 * lists and changes only its own kinds, so `--tools` / `--exclude-tools` can allow or deny them separately.
 */
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { bottomConfirm } from "../../../shared/src/bottom-panel/index.js";
import type { Clock } from "./clock.ts";
import { CommandApprovals, resolveCwd } from "./cwd.ts";
import type { ScheduleEngine } from "./engine.ts";
import { defaultShell, shellProblem, type ShellName } from "./guard.ts";
import { JobError, ownsPromptTool, ownsShellTool, type JobPatch, type JobService, type NewJob, type Owns } from "./jobs.ts";
import { isInScheduledExecution } from "./scheduled-turn.ts";
import { describeSchedule, parseScheduleText, SCHEDULE_HELP, type ScheduleType } from "./shorthand.ts";
import type { Job, MissedPolicy } from "./types.ts";
import { ValidationError } from "./validate.ts";

export interface ToolDeps {
	/** Throw a user-facing error when schedules are unavailable (untrusted project, not started). */
	jobs: () => JobService;
	engine: () => ScheduleEngine;
	approvals: () => CommandApprovals;
	clock: Clock;
	activeTools: () => readonly string[];
}

const ACTIONS = ["add", "remove", "list", "status", "enable", "disable", "update", "cleanup", "run_now"] as const;
type Action = (typeof ACTIONS)[number];
/** A scheduled turn may only shrink or read the schedule; anything that creates, rewrites or starts work is refused. */
const SCHEDULED_TURN_ALLOWED: readonly Action[] = ["list", "status", "remove", "disable"];

const nullable = <T extends ReturnType<typeof Type.String>>(inner: T) => Type.Union([inner, Type.Null()]);
const listOrBool = Type.Union([Type.Boolean(), Type.Array(Type.String())]);

const common = {
	action: Type.Union(ACTIONS.map((a) => Type.Literal(a)), { description: "add, remove, list, status, enable, disable, update, cleanup or run_now" }),
	jobId: Type.Optional(Type.String({ description: "Job id from action list (remove, status, enable, disable, update, run_now)." })),
	name: Type.Optional(Type.String({ description: "Unique job name; generated when omitted." })),
	description: Type.Optional(Type.String()),
	schedule: Type.Optional(Type.String({ description: SCHEDULE_HELP })),
	type: Type.Optional(Type.Union([Type.Literal("cron"), Type.Literal("interval"), Type.Literal("once")], { description: "How to read schedule; inferred from its shape when omitted." })),
	timezone: Type.Optional(Type.String({ description: "IANA time zone for cron, default is the local zone." })),
	endAt: Type.Optional(nullable(Type.String({ description: "Exclusive ISO deadline with zone; no run is started at or after it. null on update clears it." }))),
	missed: Type.Optional(Type.Union([Type.Literal("skip"), Type.Literal("run-once"), Type.Literal("run-all")], { description: "What to do with runs missed while Pi was closed: skip (default), run-once or run-all." })),
	maxLateMs: Type.Optional(Type.Integer({ minimum: 0, description: "A missed run later than this is not caught up." })),
};
const promptParams = Type.Object({
	...common,
	prompt: Type.Optional(Type.String({ description: "Text delivered at the scheduled time (required for add)." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Run as an independent agent session on this model (provider/id) instead of joining this conversation." })),
	notify: Type.Optional(Type.Boolean({ description: "With model: wake this conversation with the result." })),
	extensions: Type.Optional(listOrBool),
	skills: Type.Optional(listOrBool),
}, { additionalProperties: false });
const shellParams = Type.Object({
	...common,
	command: Type.Optional(Type.String({ description: "Shell command run unattended (required for add)." })),
	shell: Type.Optional(Type.Union([Type.Literal("bash"), Type.Literal("powershell")])),
	cwd: Type.Optional(Type.String({ description: "Working directory, default is the project directory." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Stop the command after this long without any output (not a total time limit)." })),
}, { additionalProperties: false });

type Params = Record<string, unknown> & { action: Action };
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function line(job: Job): string {
	const when = job.enabled && job.state.nextDue ? `next ${job.state.nextDue}` : "not scheduled";
	return `${job.id} | ${job.name} | ${job.kind}${job.kind === "agent" ? `:${job.model}` : ""} | ${job.enabled ? "enabled" : "disabled"} | ${describeSchedule(job.schedule)} | ${when} | last ${job.state.lastStatus ?? "never"}${job.session ? "" : " | all sessions"}`;
}
function detail(job: Job): string {
	const lines = [line(job), `Created: ${job.createdAt}`, ...(job.endAt ? [`Ends: ${job.endAt}`] : []), `Runs: ${job.state.runCount}${job.state.lastRun ? `, last ${job.state.lastRun}` : ""}`, ...(job.state.lastError ? [`Last error: ${job.state.lastError}`] : [])];
	if (job.kind === "prompt" || job.kind === "agent") lines.push(`Prompt: ${job.prompt}`);
	if (job.kind === "shell") lines.push(`Command: ${job.command}`, `Shell: ${job.shell ?? defaultShell()}`, `Directory: ${job.cwd ?? "(project directory)"}`, ...(job.timeoutMs ? [`Output stall limit: ${job.timeoutMs} ms`] : []));
	lines.push(`Missed runs: ${job.missed ?? "default policy"}${job.maxLateMs !== undefined ? `, up to ${job.maxLateMs} ms late` : ""}`);
	return lines.join("\n");
}

const canConfirm = (ctx: ExtensionContext) => ctx.hasUI === true && typeof ctx.ui?.confirm === "function";

/** The exact text the user approves: command, shell, directory and the stall limit. */
function commandLines(ctx: ExtensionContext, spec: { command: string; shell: ShellName; cwd?: string; timeoutMs?: number }): string[] {
	const resolved = resolveCwd(ctx.cwd, spec.cwd);
	return [
		`Command: ${spec.command}`, `Shell: ${spec.shell}`,
		`Directory: ${resolved.ok ? resolved.cwd : spec.cwd ?? "(project directory)"}${resolved.ok && resolved.outsideProject ? "  (OUTSIDE the project)" : ""}`,
		...(spec.timeoutMs ? [`Output stall limit: ${spec.timeoutMs} ms`] : []),
		"It runs unattended while this Pi session is open; it is not a sandbox.",
	];
}

export function createScheduleTool(kind: "prompt" | "shell", deps: ToolDeps): ToolDefinition<any, any> {
	const isShell = kind === "shell";
	const owns: Owns = isShell ? ownsShellTool : ownsPromptTool;
	const other = isShell ? "schedule_prompt" : "schedule_shell";
	const self = isShell ? "schedule_shell" : "schedule_prompt";

	return {
		name: self,
		label: isShell ? "Schedule Shell" : "Schedule Prompt",
		description: isShell
			? `Schedule a shell command that runs unattended while this Pi session is open (nothing runs when Pi is closed). add needs schedule and command; the user must confirm the exact command interactively. Output is shown to the user only, never sent to the model. Also: list, status, update, enable, disable, remove, cleanup, run_now. A scheduled run cannot add, update, enable, clean up or run jobs. Prompt jobs: ${other}.`
			: `Schedule a prompt for this Pi session (nothing runs when Pi is closed). add needs schedule and prompt; with model it runs as an independent agent session instead of joining this conversation. Also: list, status, update, enable, disable, remove, cleanup, run_now. A scheduled run cannot add, update, enable, clean up or run jobs. Shell commands: ${other}.`,
		parameters: isShell ? shellParams : promptParams,
		async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
			const params = raw as Params;
			const action = params.action;
			const reply = (text: string, jobs: Job[] = []) => ({ content: [{ type: "text" as const, text }], details: { action, jobs } });
			try {
				if (!SCHEDULED_TURN_ALLOWED.includes(action) && isInScheduledExecution(ctx.sessionManager as never)) {
					throw new JobError(`action "${action}" is not available from within a scheduled run; that prevents endless chains and unattended changes to the schedule`);
				}
				const jobs = deps.jobs();
				const needId = () => { const id = str(params.jobId); if (!id) throw new JobError(`jobId: required for action "${action}"; get ids with action "list"`); return id; };

				switch (action) {
					case "list": {
						const all = jobs.list(owns);
						return reply(all.length ? all.map(line).join("\n") : `No ${isShell ? "shell" : "prompt"} jobs.`, all);
					}
					case "status": {
						const job = jobs.get(needId(), owns);
						return reply(detail(job), [job]);
					}
					case "remove": {
						const job = jobs.remove(needId(), owns);
						return reply(`Removed ${job.kind} job "${job.name}" (${job.id}).`, [job]);
					}
					case "cleanup": {
						const gone = jobs.cleanup(owns);
						return reply(gone.length ? `Removed ${gone.length} disabled job(s): ${gone.map((j) => j.name).join(", ")}.` : "No disabled jobs to clean up.", gone);
					}
					case "disable": {
						const job = jobs.setEnabled(needId(), false, owns);
						return reply(`Disabled "${job.name}" (${job.id}).`, [job]);
					}
					case "enable": {
						const current = jobs.get(needId(), owns);
						if (current.kind === "shell") await confirmShell(ctx, deps, `Enable "${current.name}"?`, current, "Confirm enabling scheduled command");
						const job = jobs.setEnabled(current.id, true, owns, current.kind === "shell" ? (j) => sameSpec(j, current) : undefined);
						return reply(`Enabled "${job.name}" (${job.id}); ${job.state.nextDue ? `next run ${job.state.nextDue}` : "no further run"}.`, [job]);
					}
					case "run_now": {
						const current = jobs.get(needId(), owns);
						if (current.kind === "shell") await confirmShell(ctx, deps, `Run "${current.name}" now?`, current, "Confirm running scheduled command now");
						const result = deps.engine().runNow(current.id);
						if (!result.ok) throw new JobError(result.error);
						return reply(`Started "${current.name}" (${current.id}); its result appears as a marker in the conversation.`, [current]);
					}
					case "add": return await add(params, ctx, jobs);
					case "update": return await update(params, ctx, jobs);
				}
			} catch (error) {
				const message = error instanceof JobError || error instanceof ValidationError || error instanceof Error ? error.message : String(error);
				return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }], details: { action, jobs: [], error: message } };
			}

			async function add(p: Params, context: ExtensionContext, jobs: JobService) {
				const wrong = isShell ? p.prompt ?? p.model : p.command ?? p.shell ?? p.cwd ?? p.timeoutMs;
				if (wrong !== undefined) throw new JobError(`${isShell ? "prompt and model are" : "command, shell, cwd and timeoutMs are"} not accepted by ${self}; use ${other} for those jobs`);
				const scheduleText = str(p.schedule), body = str(isShell ? p.command : p.prompt);
				if (!scheduleText || !body) throw new JobError(`add needs ${[!scheduleText && "schedule", !body && (isShell ? "command" : "prompt")].filter(Boolean).join(" and ")}. ${SCHEDULE_HELP}`);
				const schedule = parseScheduleText(scheduleText, p.type as ScheduleType | undefined, str(p.timezone), deps.clock.now());
				if (p.endAt === null) throw new JobError("endAt: null is only allowed on update");
				const common: Omit<NewJob, "body"> = {
					...(str(p.name) ? { name: str(p.name) } : {}), ...(str(p.description) ? { description: str(p.description) } : {}),
					schedule, ...(str(p.endAt) ? { endAt: str(p.endAt) } : {}), ...(p.missed ? { missed: p.missed as MissedPolicy } : {}),
					...(p.maxLateMs !== undefined ? { maxLateMs: p.maxLateMs as number } : {}),
				};
				let newJob: NewJob;
				if (isShell) {
					const shell = (str(p.shell) as ShellName | undefined) ?? defaultShell();
					const problem = shellProblem(deps.activeTools(), shell);
					if (problem) throw new JobError(problem);
					let cwd: string | undefined;
					if (p.cwd !== undefined) { const resolved = resolveCwd(context.cwd, str(p.cwd)); if (!resolved.ok) throw new JobError(resolved.error); cwd = resolved.cwd; }
					const spec = { command: body, shell, ...(cwd ? { cwd } : {}), ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs as number } : {}) };
					if (!canConfirm(context)) throw new JobError("a shell command needs an interactive session so the user can confirm the exact command; nothing was saved. Ask the user to add it from the TUI, or use schedule_prompt");
					const confirmed = await bottomConfirm(context, "Confirm scheduled command", [`Create "${str(p.name) ?? "new job"}" (${describeSchedule(schedule)})?`, ...commandLines(context, spec)].join("\n"));
					if (!confirmed) throw new JobError("the user did not confirm the scheduled command; nothing was saved");
					deps.approvals().approve(spec.command, spec.shell, cwd ?? (resolveCwd(context.cwd) as { cwd: string }).cwd);
					newJob = { ...common, body: { kind: "shell", ...spec } };
				} else {
					const model = p.model;
					if (model !== undefined && (typeof model !== "string" || model === "")) throw new JobError("model: must be a non-empty string; omit it for a prompt that joins this conversation");
					if (model === undefined && (p.notify !== undefined || p.extensions !== undefined || p.skills !== undefined)) throw new JobError("notify, extensions and skills only apply together with model");
					newJob = { ...common, body: model === undefined ? { kind: "prompt", prompt: body } : { kind: "agent", prompt: body, model: model as string, ...(p.notify !== undefined ? { notify: p.notify as boolean } : {}), ...(p.extensions !== undefined ? { extensions: p.extensions as boolean | string[] } : {}), ...(p.skills !== undefined ? { skills: p.skills as boolean | string[] } : {}) } };
				}
				const job = jobs.add(newJob);
				return reply(`Created ${job.kind} job "${job.name}" (${job.id}).\nSchedule: ${describeSchedule(job.schedule)}\nNext run: ${job.state.nextDue}${job.endAt ? `\nEnds: ${job.endAt}` : ""}`, [job]);
			}

			async function update(p: Params, context: ExtensionContext, jobs: JobService) {
				const id = str(p.jobId);
				if (!id) throw new JobError('jobId: required for action "update"; get ids with action "list"');
				const current = jobs.get(id, owns);
				const patch: JobPatch = {
					...(str(p.name) ? { name: str(p.name) } : {}), ...(p.description !== undefined ? { description: str(p.description) } : {}),
					...(p.endAt !== undefined ? { endAt: p.endAt as string | null } : {}), ...(p.missed ? { missed: p.missed as MissedPolicy } : {}),
					...(p.maxLateMs !== undefined ? { maxLateMs: p.maxLateMs as number } : {}),
				};
				if (str(p.schedule)) patch.schedule = parseScheduleText(str(p.schedule)!, p.type as ScheduleType | undefined, str(p.timezone), deps.clock.now());
				else if (p.timezone !== undefined && current.schedule.type === "cron") patch.schedule = parseScheduleText(current.schedule.expr, "cron", str(p.timezone), deps.clock.now());
				let expect: ((j: Job) => boolean) | undefined;
				if (isShell) {
					if (p.prompt !== undefined || p.model !== undefined) throw new JobError("prompt and model are not accepted by schedule_shell");
					const body: Record<string, unknown> = {};
					if (str(p.command)) body.command = str(p.command);
					if (str(p.shell)) { const problem = shellProblem(deps.activeTools(), str(p.shell) as ShellName); if (problem) throw new JobError(problem); body.shell = str(p.shell); }
					if (p.cwd !== undefined) { const resolved = resolveCwd(context.cwd, str(p.cwd)); if (!resolved.ok) throw new JobError(resolved.error); body.cwd = resolved.cwd; }
					if (p.timeoutMs !== undefined) body.timeoutMs = p.timeoutMs;
					patch.body = body;
					const shell = current as Extract<Job, { kind: "shell" }>;
					const next = { command: (body.command as string) ?? shell.command, shell: ((body.shell as ShellName) ?? shell.shell ?? defaultShell()), cwd: (body.cwd as string | undefined) ?? shell.cwd, timeoutMs: (body.timeoutMs as number | undefined) ?? shell.timeoutMs };
					if (next.command !== shell.command || next.shell !== (shell.shell ?? defaultShell()) || next.cwd !== shell.cwd) {
						if (!canConfirm(context)) throw new JobError("changing a shell command needs an interactive session so the user can confirm the exact command; nothing was changed");
						const confirmed = await bottomConfirm(context, "Confirm changed scheduled command", [`Change "${current.name}"?`, ...commandLines(context, next)].join("\n"));
						if (!confirmed) throw new JobError("the user did not confirm the changed command; nothing was changed");
						deps.approvals().approve(next.command, next.shell, next.cwd ?? (resolveCwd(context.cwd) as { cwd: string }).cwd);
						expect = (j) => sameSpec(j, current);
					}
				} else {
					if (p.command !== undefined || p.shell !== undefined || p.cwd !== undefined || p.timeoutMs !== undefined) throw new JobError("command, shell, cwd and timeoutMs are not accepted by schedule_prompt");
					const body: Record<string, unknown> = {};
					if (str(p.prompt)) body.prompt = str(p.prompt);
					if (p.model !== undefined || p.notify !== undefined || p.extensions !== undefined || p.skills !== undefined) {
						if (current.kind !== "agent") throw new JobError("model, notify, extensions and skills only apply to an agent job; remove this job and add it again with a model to change its kind");
						if (str(p.model)) body.model = str(p.model);
						for (const key of ["notify", "extensions", "skills"] as const) if (p[key] !== undefined) body[key] = p[key];
					}
					patch.body = body;
				}
				const job = jobs.update(id, patch, owns, expect);
				return reply(`Updated "${job.name}" (${job.id}).\n${detail(job)}`, [job]);
			}
		},
		renderCall(args, theme) {
			const a = args as Params | undefined;
			return new Text(theme.fg("toolTitle", `${self} ${a?.action ?? ""}`) + (a?.name ? theme.fg("muted", ` ${String(a.name)}`) : a?.jobId ? theme.fg("muted", ` ${String(a.jobId)}`) : ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const first = (result.content?.[0] as { text?: string } | undefined)?.text?.split("\n")[0] ?? "";
			return new Text((result as { isError?: boolean }).isError ? theme.fg("error", first) : theme.fg("muted", first), 0, 0);
		},
	};
}

function sameSpec(a: Job, b: Job): boolean {
	if (a.kind !== "shell" || b.kind !== "shell") return false;
	return a.command === b.command && (a.shell ?? defaultShell()) === (b.shell ?? defaultShell()) && a.cwd === b.cwd;
}

async function confirmShell(ctx: ExtensionContext, deps: ToolDeps, question: string, job: Job, title: string): Promise<void> {
	if (job.kind !== "shell") return;
	if (!canConfirm(ctx)) throw new JobError("this shell job needs an interactive session so the user can confirm the exact command; ask the user to do it from the TUI");
	const shell = job.shell ?? defaultShell();
	const problem = shellProblem(deps.activeTools(), shell);
	if (problem) throw new JobError(problem);
	const confirmed = await bottomConfirm(ctx, title, [question, ...commandLines(ctx, { command: job.command, shell, cwd: job.cwd, timeoutMs: job.timeoutMs })].join("\n"));
	if (!confirmed) throw new JobError("the user did not confirm; nothing was changed");
	const resolved = resolveCwd(ctx.cwd, job.cwd);
	if (!resolved.ok) throw new JobError(resolved.error);
	deps.approvals().approve(job.command, shell, resolved.cwd);
}

export const createPromptTool = (deps: ToolDeps) => createScheduleTool("prompt", deps);
export const createShellTool = (deps: ToolDeps) => createScheduleTool("shell", deps);
