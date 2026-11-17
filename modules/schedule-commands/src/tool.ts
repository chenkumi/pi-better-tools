/**
 * `schedule_prompt` (prompt and agent jobs) and `schedule_shell` (shell command jobs). One stored list, but each tool
 * lists and changes only its own kinds, so `--tools` / `--exclude-tools` can allow or deny them separately.
 */
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ScheduledMonitorStarter } from "../../../shared/src/background/index.ts";
import type { Clock } from "./clock.ts";
import type { ScheduleEngine } from "./engine.ts";
import { defaultShell, shellProblem, type ShellName } from "./guard.ts";
import { JobError, ownsMonitorTool, ownsPromptTool, ownsShellTool, type JobPatch, type JobService, type NewJob, type Owns } from "./jobs.ts";
import { monitorLines, monitorProblem } from "./monitor-link.ts";
import { isInScheduledExecution } from "./scheduled-turn.ts";
import { describeSchedule, parseScheduleText, SCHEDULE_HELP, type ScheduleType } from "./shorthand.ts";
import type { Job, MissedPolicy } from "./types.ts";
import { ValidationError } from "./validate.ts";

export interface ToolDeps {
	/** Throw a user-facing error when schedules are unavailable (untrusted project, not started). */
	jobs: () => JobService;
	engine: () => ScheduleEngine;
	clock: Clock;
	activeTools: () => readonly string[];
	/** This session's Monitor, when one is loaded; used to validate monitor jobs early. */
	monitor?: () => ScheduledMonitorStarter | undefined;
}

const ACTIONS = ["add", "remove", "list", "status", "enable", "disable", "update", "cleanup", "run_now"] as const;
type Action = (typeof ACTIONS)[number];
/** A scheduled turn may only shrink or read the schedule; anything that creates, rewrites or starts work is refused. */
const SCHEDULED_TURN_ALLOWED: readonly Action[] = ["list", "status", "remove", "disable"];

/** Plain `{ type: "string", enum }`: providers handle it better than an anyOf of literals. */
const StringEnum = <const T extends readonly string[]>(values: T, options?: { description?: string }) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(options?.description ? { description: options.description } : {}) });
const nullable = <T extends ReturnType<typeof Type.String>>(inner: T) => Type.Union([inner, Type.Null()]);
const listOrBool = Type.Union([Type.Boolean(), Type.Array(Type.String())]);

const common = {
	action: StringEnum(ACTIONS, { description: "add, remove, list, status, enable, disable, update, cleanup or run_now" }),
	jobId: Type.Optional(Type.String({ description: "Job id from action list (remove, status, enable, disable, update, run_now)." })),
	name: Type.Optional(Type.String({ description: "Unique job name; generated when omitted." })),
	description: Type.Optional(Type.String()),
	schedule: Type.Optional(Type.String({ description: SCHEDULE_HELP })),
	type: Type.Optional(StringEnum(["cron", "interval", "once"] as const, { description: "How to read schedule; inferred from its shape when omitted." })),
	timezone: Type.Optional(Type.String({ description: "IANA time zone for cron, default is the local zone." })),
	endAt: Type.Optional(nullable(Type.String({ description: "Exclusive ISO deadline with zone; no run is started at or after it. null on update clears it." }))),
	missed: Type.Optional(StringEnum(["skip", "run-once", "run-all"] as const, { description: "What to do with runs missed while Pi was closed: skip (default), run-once or run-all." })),
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
	shell: Type.Optional(StringEnum(["bash", "powershell"] as const)),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Total time limit in ms from the command start (as for the shell tool); omit for no limit." })),
}, { additionalProperties: false });

const monitorParams = Type.Object({
	...common,
	start: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The monitor to start at each scheduled time, with the same parameters as monitor_start: source (command, file or system only), durationMs (default and maximum as monitor_start), wakeAgent (default false here), stopAfterEvents, label. A command source runs unattended and needs schedule_shell enabled." })),
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
	if (job.kind === "shell") lines.push(`Command: ${job.command}`, `Shell: ${job.shell ?? defaultShell()}`, ...(job.cwd ? [`Directory: ${job.cwd} (no longer supported; the run is refused)`] : []), ...(job.timeoutMs ? [`Time limit: ${job.timeoutMs} ms`] : []));
	if (job.kind === "monitor") lines.push(...monitorLines(job.start));
	lines.push(`Missed runs: ${job.missed ?? "default policy"}${job.maxLateMs !== undefined ? `, up to ${job.maxLateMs} ms late` : ""}`);
	return lines.join("\n");
}

export function createScheduleTool(kind: "prompt" | "shell" | "monitor", deps: ToolDeps): ToolDefinition<any, any> {
	const isShell = kind === "shell", isMonitor = kind === "monitor";
	const owns: Owns = isShell ? ownsShellTool : isMonitor ? ownsMonitorTool : ownsPromptTool;
	const other = isShell ? "schedule_prompt" : isMonitor ? "schedule_prompt or schedule_shell" : "schedule_shell or schedule_monitor";
	const self = isShell ? "schedule_shell" : isMonitor ? "schedule_monitor" : "schedule_prompt";

	return {
		name: self,
		label: isShell ? "Schedule Shell" : isMonitor ? "Schedule Monitor" : "Schedule Prompt",
		description: isMonitor
			? "Schedule a Monitor: at each scheduled time (while this Pi session is open; nothing runs when Pi is closed) a monitor is started with the parameters in start, exactly as monitor_start would. add needs schedule and start. To watch the output of a command that schedule_shell starts, schedule both for the same time: the shell command is started first. Also: list, status, update, enable, disable, remove, cleanup, run_now."
			: isShell
			? `Schedule a shell command (nothing runs when Pi is closed). add needs schedule and command. At each scheduled time a background shell job is added and the schedule run ends; the shell job's completion is reported to you like any background shell job, and you are told when it starts. Also: list, status, update, enable, disable, remove, cleanup, run_now. A scheduled run cannot add, update, enable, clean up or run jobs. Prompt jobs: ${other}.`
			: `Schedule a prompt for this Pi session (nothing runs when Pi is closed). add needs schedule and prompt; with model it runs as an independent agent session instead of joining this conversation. Also: list, status, update, enable, disable, remove, cleanup, run_now. A scheduled run cannot add, update, enable, clean up or run jobs. Shell commands: ${other}.`,
		parameters: isShell ? shellParams : isMonitor ? monitorParams : promptParams,
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
						return reply(all.length ? all.map(line).join("\n") : `No ${isShell ? "shell" : isMonitor ? "monitor" : "prompt"} jobs.`, all);
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
						const job = jobs.setEnabled(current.id, true, owns);
						return reply(`Enabled "${job.name}" (${job.id}); ${job.state.nextDue ? `next run ${job.state.nextDue}` : "no further run"}.`, [job]);
					}
					case "run_now": {
						const current = jobs.get(needId(), owns);
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
				if (isMonitor) return await addMonitor(p, jobs);
				const wrong = isShell ? p.prompt ?? p.model ?? p.cwd : p.command ?? p.shell ?? p.cwd ?? p.timeoutMs;
				if (wrong !== undefined) throw new JobError(`${isShell ? "prompt, model and cwd are" : "command, shell, cwd and timeoutMs are"} not accepted by ${self}; use ${other} for those jobs`);
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
					const spec = { command: body, shell, ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs as number } : {}) };
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

			async function addMonitor(p: Params, jobs: JobService) {
				const wrong = p.prompt ?? p.model ?? p.command ?? p.shell ?? p.cwd ?? p.timeoutMs;
				if (wrong !== undefined) throw new JobError("prompt, model, command, shell, cwd and timeoutMs are not accepted by schedule_monitor; use schedule_prompt or schedule_shell for those jobs");
				const scheduleText = str(p.schedule), start = p.start;
				if (!scheduleText || !isStart(start)) throw new JobError(`add needs ${[!scheduleText && "schedule", !isStart(start) && "start"].filter(Boolean).join(" and ")}. ${SCHEDULE_HELP}`);
				if (p.endAt === null) throw new JobError("endAt: null is only allowed on update");
				checkMonitorStart(start);
				const job = jobs.add({
					...(str(p.name) ? { name: str(p.name) } : {}), ...(str(p.description) ? { description: str(p.description) } : {}),
					schedule: parseScheduleText(scheduleText, p.type as ScheduleType | undefined, str(p.timezone), deps.clock.now()),
					...(str(p.endAt) ? { endAt: str(p.endAt) } : {}), ...(p.missed ? { missed: p.missed as MissedPolicy } : {}),
					...(p.maxLateMs !== undefined ? { maxLateMs: p.maxLateMs as number } : {}),
					body: { kind: "monitor", start },
				});
				return reply(`Created monitor job "${job.name}" (${job.id}).\nSchedule: ${describeSchedule(job.schedule)}\nNext run: ${job.state.nextDue}${job.endAt ? `\nEnds: ${job.endAt}` : ""}`, [job]);
			}

			function checkMonitorStart(start: MonitorStartParams) {
				const problem = monitorProblem(start, deps.activeTools());
				if (problem) throw new JobError(problem);
				const invalid = deps.monitor?.()?.validate(start);
				if (invalid) throw new JobError(`start: ${invalid}`);
			}

			async function updateMonitor(p: Params, jobs: JobService) {
				const id = str(p.jobId);
				if (!id) throw new JobError('jobId: required for action "update"; get ids with action "list"');
				const current = jobs.get(id, owns) as Extract<Job, { kind: "monitor" }>;
				if (p.prompt !== undefined || p.model !== undefined || p.command !== undefined || p.shell !== undefined || p.cwd !== undefined || p.timeoutMs !== undefined) throw new JobError("only start can change the body of a monitor job");
				const patch: JobPatch = {
					...(str(p.name) ? { name: str(p.name) } : {}), ...(p.description !== undefined ? { description: str(p.description) } : {}),
					...(p.endAt !== undefined ? { endAt: p.endAt as string | null } : {}), ...(p.missed ? { missed: p.missed as MissedPolicy } : {}),
					...(p.maxLateMs !== undefined ? { maxLateMs: p.maxLateMs as number } : {}),
				};
				if (str(p.schedule)) patch.schedule = parseScheduleText(str(p.schedule)!, p.type as ScheduleType | undefined, str(p.timezone), deps.clock.now());
				else if (p.timezone !== undefined && current.schedule.type === "cron") patch.schedule = parseScheduleText(current.schedule.expr, "cron", str(p.timezone), deps.clock.now());
				if (p.start !== undefined) {
					if (!isStart(p.start)) throw new JobError("start: must be an object with a source");
					checkMonitorStart(p.start);
					patch.body = { start: p.start };
				}
				const job = jobs.update(id, patch, owns);
				return reply(`Updated "${job.name}" (${job.id}).\n${detail(job)}`, [job]);
			}

			async function update(p: Params, context: ExtensionContext, jobs: JobService) {
				if (isMonitor) return await updateMonitor(p, jobs);
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
				if (isShell) {
					if (p.prompt !== undefined || p.model !== undefined || p.cwd !== undefined) throw new JobError("prompt, model and cwd are not accepted by schedule_shell");
					const body: Record<string, unknown> = {};
					if (str(p.command)) body.command = str(p.command);
					if (str(p.shell)) { const problem = shellProblem(deps.activeTools(), str(p.shell) as ShellName); if (problem) throw new JobError(problem); body.shell = str(p.shell); }
					if (p.timeoutMs !== undefined) body.timeoutMs = p.timeoutMs;
					patch.body = body;
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
				const job = jobs.update(id, patch, owns);
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

type MonitorStartParams = Extract<Job, { kind: "monitor" }>["start"];
const isStart = (v: unknown): v is MonitorStartParams => typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { source?: unknown }).source === "object" && (v as { source?: unknown }).source !== null;

export const createPromptTool = (deps: ToolDeps) => createScheduleTool("prompt", deps);
export const createShellTool = (deps: ToolDeps) => createScheduleTool("shell", deps);
export const createMonitorTool = (deps: ToolDeps) => createScheduleTool("monitor", deps);
