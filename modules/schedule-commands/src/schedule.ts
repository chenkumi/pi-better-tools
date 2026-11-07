/** Pure schedule maths: validation helpers, next due time and missed-run counting. No clocks, timers or I/O. */
import { Cron } from "croner";
import type { Schedule } from "./types.ts";

export const MIN_INTERVAL_MS = 1000;
/** Counting stops here so a per-second cron that was offline for days stays cheap. */
export const MISSED_COUNT_LIMIT = 1000;

export function isValidTimezone(name: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

export function parseIso(value: string): Date | undefined {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Returns an error text naming the argument, or undefined when the expression is a valid 5 or 6 field cron. */
export function cronProblem(expr: string, timezone?: string): string | undefined {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5 && fields.length !== 6) return `schedule.expr must have 5 fields (minute hour day month weekday) or 6 fields with a leading seconds field, got ${fields.length}`;
	if (timezone !== undefined && !isValidTimezone(timezone)) return `schedule.timezone ${JSON.stringify(timezone)} is not an IANA time zone name`;
	try {
		new Cron(expr.trim(), { timezone, paused: true });
		return undefined;
	} catch (error) {
		return `schedule.expr is not a valid cron expression: ${error instanceof Error ? error.message : String(error)}`;
	}
}

const cronOf = (schedule: Extract<Schedule, { type: "cron" }>) => new Cron(schedule.expr.trim(), { timezone: schedule.timezone, paused: true });

/**
 * The first due time strictly after `after`. Intervals are anchored (anchor + k * everyMs) so missed runs can be
 * counted by arithmetic and there is no timer length limit. Returns undefined when nothing is left (a past `once`).
 */
export function nextDue(schedule: Schedule, after: Date, anchor: Date): Date | undefined {
	if (schedule.type === "once") {
		const at = new Date(schedule.at);
		return at.getTime() > after.getTime() ? at : undefined;
	}
	if (schedule.type === "interval") {
		const steps = Math.floor((after.getTime() - anchor.getTime()) / schedule.everyMs) + 1;
		return new Date(anchor.getTime() + Math.max(steps, 1) * schedule.everyMs);
	}
	return cronOf(schedule).nextRun(after) ?? undefined;
}

export interface MissedRuns {
	/** Due times in (since, now], oldest first, at most `limit` of them. */
	dates: Date[];
	/** True when more than `limit` runs were missed; `dates` then holds the oldest `limit`. */
	truncated: boolean;
	/** The most recent missed due time, also when `dates` is truncated. */
	latest?: Date;
}

/** Due times in the half-open window (since, now]. `since` is the persisted nextDue minus one tick, i.e. the last time handled. */
export function missedRuns(schedule: Schedule, since: Date, now: Date, anchor: Date, limit = MISSED_COUNT_LIMIT): MissedRuns {
	const dates: Date[] = [];
	let cursor = since;
	let truncated = false;
	for (;;) {
		const next = nextDue(schedule, cursor, anchor);
		if (!next || next.getTime() > now.getTime()) break;
		if (dates.length >= limit) { truncated = true; break; }
		dates.push(next);
		cursor = next;
	}
	if (!truncated) return { dates, truncated, latest: dates.at(-1) };
	let latest: Date | undefined;
	if (schedule.type === "cron") {
		// croner floors the reference to the second and excludes it, so look one second ahead and step back if that overshoots.
		const cron = cronOf(schedule);
		latest = cron.previousRuns(1, new Date(now.getTime() + 1000))[0];
		if (latest && latest.getTime() > now.getTime()) latest = cron.previousRuns(1, now)[0];
	}
	else if (schedule.type === "interval") latest = new Date(anchor.getTime() + Math.floor((now.getTime() - anchor.getTime()) / schedule.everyMs) * schedule.everyMs);
	return { dates, truncated, latest };
}
