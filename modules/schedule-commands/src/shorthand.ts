/** Turns the tool's `schedule` text (plus optional `type`) into the structured Schedule that is stored. */
import { cronProblem, MIN_INTERVAL_MS, parseIso } from "./schedule.ts";
import type { Schedule } from "./types.ts";
import { ValidationError } from "./validate.ts";

export type ScheduleType = "cron" | "interval" | "once";

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const RELATIVE = /^\+(\d+)([smhd])$/;
const INTERVAL = /^(\d+)([smhd])$/;

export const SCHEDULE_HELP = 'schedule: "cron" takes a 5 or 6 field cron expression (6 fields start with seconds); "interval" takes 30s, 5m, 1h or 2d; "once" takes +10m (relative) or an ISO time with a zone such as 2030-01-01T09:00:00Z';

const fail = (message: string): never => { throw new ValidationError(message); };

function inferType(text: string): ScheduleType {
	if (RELATIVE.test(text) || parseIso(text)) return "once";
	if (INTERVAL.test(text)) return "interval";
	return "cron";
}

export function parseScheduleText(text: string, type: ScheduleType | undefined, timezone: string | undefined, nowMs: number): Schedule {
	const value = text.trim();
	const kind = type ?? inferType(value);
	if (kind === "once") {
		const relative = RELATIVE.exec(value);
		if (relative) {
			const amount = Number(relative[1]);
			if (amount <= 0) fail("schedule: a relative time must be greater than zero");
			return { type: "once", at: new Date(nowMs + amount * UNIT_MS[relative[2]]).toISOString() };
		}
		const at = parseIso(value);
		if (!at) fail(`schedule: for type "once" give +10m style relative time or an ISO time with a zone. ${SCHEDULE_HELP}`);
		if (at!.getTime() <= nowMs) fail("schedule: the time is already in the past");
		return { type: "once", at: at!.toISOString() };
	}
	if (kind === "interval") {
		const match = INTERVAL.exec(value);
		if (!match) fail(`schedule: for type "interval" give a number and a unit s, m, h or d. ${SCHEDULE_HELP}`);
		const everyMs = Number(match![1]) * UNIT_MS[match![2]];
		if (everyMs < MIN_INTERVAL_MS) fail("schedule: an interval must be at least 1s");
		return { type: "interval", everyMs };
	}
	const problem = cronProblem(value, timezone);
	if (problem) fail(`${problem}. ${SCHEDULE_HELP}`);
	return { type: "cron", expr: value, ...(timezone ? { timezone } : {}) };
}

/** Human-readable one-line description for tool output and confirmations. */
export function describeSchedule(schedule: Schedule): string {
	if (schedule.type === "cron") return `cron ${schedule.expr}${schedule.timezone ? ` (${schedule.timezone})` : ""}`;
	if (schedule.type === "once") return `once at ${schedule.at}`;
	const ms = schedule.everyMs;
	const unit = ms % 86_400_000 === 0 ? [86_400_000, "d"] : ms % 3_600_000 === 0 ? [3_600_000, "h"] : ms % 60_000 === 0 ? [60_000, "m"] : [1000, "s"];
	return `every ${ms / (unit[0] as number)}${unit[1]}`;
}
