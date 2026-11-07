/** Strict validation for persisted jobs and the store file. Unknown keys are errors; messages name the argument. */
import { cronProblem, MIN_INTERVAL_MS, parseIso } from "./schedule.ts";
import type { Job, JobState, MonitorStart, Schedule, StoreFile } from "./types.ts";

export class ValidationError extends Error {}

const fail = (message: string): never => { throw new ValidationError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function only(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}.${key} is not a known field`);
}
function text(value: unknown, where: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a non-empty string`);
	if ((value as string).length > max) fail(`${where} must be at most ${max} characters`);
	return value as string;
}
function optText(value: unknown, where: string, max: number): string | undefined { return value === undefined ? undefined : text(value, where, max); }
function optBool(value: unknown, where: string): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") fail(`${where} must be a boolean`);
	return value as boolean | undefined;
}
function optInt(value: unknown, where: string, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`${where} must be an integer from ${min} to ${max}`);
	return value as number;
}
function iso(value: unknown, where: string): string {
	const s = text(value, where, 40);
	if (!parseIso(s)) fail(`${where} must be an ISO 8601 date-time with a time zone, e.g. 2030-01-01T09:00:00Z`);
	return s;
}
function listOrBool(value: unknown, where: string): boolean | string[] | undefined {
	if (value === undefined || typeof value === "boolean") return value as boolean | undefined;
	if (!Array.isArray(value) || value.length > 64 || value.some((v) => typeof v !== "string" || v === "" || v.length > 256)) fail(`${where} must be a boolean or a list of at most 64 names`);
	return value as string[];
}

export function validateSchedule(value: unknown, where = "schedule"): Schedule {
	if (!isRecord(value)) return fail(`${where} must be an object`);
	if (value.type === "cron") {
		only(value, ["type", "expr", "timezone"], where);
		const expr = text(value.expr, `${where}.expr`, 200);
		const timezone = optText(value.timezone, `${where}.timezone`, 100);
		const problem = cronProblem(expr, timezone);
		if (problem) fail(problem);
		return { type: "cron", expr: expr.trim(), ...(timezone ? { timezone } : {}) };
	}
	if (value.type === "interval") {
		only(value, ["type", "everyMs"], where);
		const everyMs = optInt(value.everyMs, `${where}.everyMs`, MIN_INTERVAL_MS, Number.MAX_SAFE_INTEGER);
		if (everyMs === undefined) fail(`${where}.everyMs is required`);
		return { type: "interval", everyMs: everyMs as number };
	}
	if (value.type === "once") {
		only(value, ["type", "at"], where);
		return { type: "once", at: iso(value.at, `${where}.at`) };
	}
	return fail(`${where}.type must be "cron", "interval" or "once"`);
}

function validateState(value: unknown): JobState {
	if (!isRecord(value)) return fail("state must be an object");
	only(value, ["nextDue", "lastRun", "lastStatus", "lastError", "runCount"], "state");
	const lastStatus = value.lastStatus;
	if (lastStatus !== undefined && !["success", "error", "running", "skipped"].includes(lastStatus as string)) fail("state.lastStatus is not a known status");
	return {
		runCount: optInt(value.runCount, "state.runCount", 0, Number.MAX_SAFE_INTEGER) ?? 0,
		...(value.nextDue !== undefined ? { nextDue: iso(value.nextDue, "state.nextDue") } : {}),
		...(value.lastRun !== undefined ? { lastRun: iso(value.lastRun, "state.lastRun") } : {}),
		...(lastStatus !== undefined ? { lastStatus: lastStatus as JobState["lastStatus"] } : {}),
		...(value.lastError !== undefined ? { lastError: text(value.lastError, "state.lastError", 2000) } : {}),
	};
}

const MONITOR_SOURCES = ["command", "file", "system"];
function validateMonitorStart(value: unknown): MonitorStart {
	if (!isRecord(value) || !isRecord(value.source)) return fail("start.source must be an object");
	if (!MONITOR_SOURCES.includes(value.source.kind as string)) fail(`start.source.kind must be one of ${MONITOR_SOURCES.join(", ")}`);
	return value as MonitorStart;
}

const COMMON = ["id", "kind", "name", "description", "schedule", "endAt", "enabled", "session", "missed", "maxLateMs", "createdAt", "state"] as const;
const BODY: Record<string, readonly string[]> = {
	prompt: ["prompt"],
	agent: ["prompt", "model", "notify", "extensions", "skills"],
	shell: ["command", "shell", "cwd", "timeoutMs"],
	monitor: ["start"],
};

export function validateJob(value: unknown): Job {
	if (!isRecord(value)) return fail("job must be an object");
	const kind = value.kind;
	if (typeof kind !== "string" || !(kind in BODY)) return fail('kind must be "prompt", "agent", "shell" or "monitor"');
	only(value, [...COMMON, ...BODY[kind]], "job");
	if (value.missed !== undefined && !["skip", "run-once", "run-all"].includes(value.missed as string)) fail('missed must be "skip", "run-once" or "run-all"');
	if (kind === "monitor" && value.missed === "run-all") fail('missed "run-all" is not allowed for a monitor job');
	const schedule = validateSchedule(value.schedule);
	const endAt = value.endAt === undefined ? undefined : iso(value.endAt, "endAt");
	const common = {
		id: text(value.id, "id", 64),
		name: text(value.name, "name", 200),
		...(value.description !== undefined ? { description: text(value.description, "description", 2000) } : {}),
		schedule,
		...(endAt ? { endAt } : {}),
		enabled: optBool(value.enabled, "enabled") ?? fail("enabled is required"),
		...(value.session !== undefined ? { session: text(value.session, "session", 200) } : {}),
		...(value.missed !== undefined ? { missed: value.missed as Job["missed"] } : {}),
		...(value.maxLateMs !== undefined ? { maxLateMs: optInt(value.maxLateMs, "maxLateMs", 0, Number.MAX_SAFE_INTEGER) } : {}),
		createdAt: iso(value.createdAt, "createdAt"),
		state: validateState(value.state),
	};
	if (kind === "prompt") return { ...common, kind, prompt: text(value.prompt, "prompt", 100_000) } as Job;
	if (kind === "agent") {
		return {
			...common, kind, prompt: text(value.prompt, "prompt", 100_000), model: text(value.model, "model", 200),
			...(value.notify !== undefined ? { notify: optBool(value.notify, "notify") } : {}),
			...(value.extensions !== undefined ? { extensions: listOrBool(value.extensions, "extensions") } : {}),
			...(value.skills !== undefined ? { skills: listOrBool(value.skills, "skills") } : {}),
		} as Job;
	}
	if (kind === "shell") {
		if (value.shell !== undefined && value.shell !== "bash" && value.shell !== "powershell") fail('shell must be "bash" or "powershell"');
		return {
			...common, kind, command: text(value.command, "command", 20_000),
			...(value.shell !== undefined ? { shell: value.shell as "bash" | "powershell" } : {}),
			...(value.cwd !== undefined ? { cwd: text(value.cwd, "cwd", 1000) } : {}),
			...(value.timeoutMs !== undefined ? { timeoutMs: optInt(value.timeoutMs, "timeoutMs", 1, 24 * 3600_000) } : {}),
		} as Job;
	}
	return { ...common, kind: "monitor", start: validateMonitorStart(value.start) } as Job;
}

export interface ParsedStore { store: StoreFile; dropped: Array<{ index: number; reason: string }> }

/** A job that fails validation is dropped (and reported); an unusable envelope throws so callers never mistake it for "empty". */
export function parseStore(value: unknown): ParsedStore {
	if (!isRecord(value)) return fail("store must be an object");
	only(value, ["version", "jobs"], "store");
	if (value.version !== 2) fail(`store.version must be 2, got ${JSON.stringify(value.version)}`);
	if (!Array.isArray(value.jobs)) return fail("store.jobs must be an array");
	const jobs: Job[] = [], dropped: ParsedStore["dropped"] = [], seen = new Set<string>();
	value.jobs.forEach((raw, index) => {
		try {
			const job = validateJob(raw);
			if (seen.has(job.id)) fail(`id ${JSON.stringify(job.id)} is duplicated`);
			seen.add(job.id);
			jobs.push(job);
		} catch (error) {
			if (!(error instanceof ValidationError)) throw error;
			dropped.push({ index, reason: error.message });
		}
	});
	return { store: { version: 2, jobs }, dropped };
}
