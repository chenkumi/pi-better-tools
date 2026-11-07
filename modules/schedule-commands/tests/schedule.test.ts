import assert from "node:assert/strict";
import test from "node:test";
import { cronProblem, isValidTimezone, missedRuns, nextDue, parseIso } from "../src/schedule.ts";

const d = (s: string) => new Date(s);

test("cron: 5 fields and 6 fields (leading seconds) are accepted, other counts and bad names are not", () => {
	assert.equal(cronProblem("*/5 * * * *"), undefined);
	assert.equal(cronProblem("30 */5 * * * *"), undefined);
	assert.match(cronProblem("* * * *")!, /5 fields.*got 4/);
	assert.match(cronProblem("* * * * * * *")!, /got 7/);
	assert.match(cronProblem("61 * * * *")!, /not a valid cron/);
	assert.match(cronProblem("* * * * *", "Mars/Base")!, /IANA/);
	assert.equal(isValidTimezone("Asia/Taipei"), true);
});

test("cron nextDue honours the time zone and the seconds field", () => {
	const anchor = d("2030-01-01T00:00:00Z");
	// 09:00 in Taipei (UTC+8) is 01:00 UTC.
	assert.equal(nextDue({ type: "cron", expr: "0 9 * * *", timezone: "Asia/Taipei" }, d("2030-03-05T00:00:00Z"), anchor)!.toISOString(), "2030-03-05T01:00:00.000Z");
	assert.equal(nextDue({ type: "cron", expr: "15 * * * * *" }, d("2030-03-05T00:00:20Z"), anchor)!.toISOString(), "2030-03-05T00:01:15.000Z");
	// Strictly after: a time exactly on a boundary moves to the next one.
	assert.equal(nextDue({ type: "cron", expr: "0 9 * * *", timezone: "UTC" }, d("2030-03-05T09:00:00Z"), anchor)!.toISOString(), "2030-03-06T09:00:00.000Z");
});

test("interval is anchored, has no 2^31 limit and never returns the anchor itself", () => {
	const anchor = d("2030-01-01T00:00:00Z");
	const everyDay = { type: "interval" as const, everyMs: 86_400_000 };
	assert.equal(nextDue(everyDay, d("2030-01-01T00:00:00Z"), anchor)!.toISOString(), "2030-01-02T00:00:00.000Z");
	assert.equal(nextDue(everyDay, d("2030-01-03T12:00:00Z"), anchor)!.toISOString(), "2030-01-04T00:00:00.000Z");
	const huge = { type: "interval" as const, everyMs: 90 * 86_400_000 }; // far above the 2^31 ms timer limit
	assert.equal(nextDue(huge, d("2030-01-02T00:00:00Z"), anchor)!.toISOString(), "2030-04-01T00:00:00.000Z");
	assert.equal(nextDue(everyDay, d("2029-12-01T00:00:00Z"), anchor)!.toISOString(), "2030-01-02T00:00:00.000Z", "before the anchor still waits one full interval");
});

test("once is due only while it is in the future", () => {
	const once = { type: "once" as const, at: "2030-06-01T00:00:00Z" };
	assert.equal(nextDue(once, d("2030-05-31T23:59:59Z"), d("2030-01-01T00:00:00Z"))!.toISOString(), "2030-06-01T00:00:00.000Z");
	assert.equal(nextDue(once, d("2030-06-01T00:00:00Z"), d("2030-01-01T00:00:00Z")), undefined);
});

test("missedRuns counts by arithmetic over (since, now], oldest first", () => {
	const anchor = d("2030-01-01T00:00:00Z");
	const result = missedRuns({ type: "cron", expr: "0 * * * *", timezone: "UTC" }, d("2030-01-01T00:30:00Z"), d("2030-01-01T03:30:00Z"), anchor);
	assert.deepEqual(result.dates.map((x) => x.toISOString()), ["2030-01-01T01:00:00.000Z", "2030-01-01T02:00:00.000Z", "2030-01-01T03:00:00.000Z"]);
	assert.equal(result.truncated, false);
	assert.equal(result.latest!.toISOString(), "2030-01-01T03:00:00.000Z");
	assert.deepEqual(missedRuns({ type: "interval", everyMs: 60_000 }, d("2030-01-01T00:10:30Z"), d("2030-01-01T00:10:40Z"), anchor).dates, []);
});

test("missedRuns is bounded: a per-second cron offline for a day reports truncation and the true latest run", () => {
	const anchor = d("2030-01-01T00:00:00Z");
	const cron = { type: "cron" as const, expr: "* * * * * *", timezone: "UTC" };
	const result = missedRuns(cron, d("2030-01-01T00:00:00Z"), d("2030-01-02T00:00:00Z"), anchor, 50);
	assert.equal(result.dates.length, 50);
	assert.equal(result.truncated, true);
	assert.equal(result.latest!.toISOString(), "2030-01-02T00:00:00.000Z");
	const interval = missedRuns({ type: "interval", everyMs: 1000 }, d("2030-01-01T00:00:00Z"), d("2030-01-02T00:00:00Z"), anchor, 50);
	assert.equal(interval.truncated, true);
	assert.equal(interval.latest!.toISOString(), "2030-01-02T00:00:00.000Z");
});

test("parseIso requires a time zone designator and a real date", () => {
	assert.ok(parseIso("2030-01-01T09:00:00Z"));
	assert.ok(parseIso("2030-01-01T09:00+08:00"));
	assert.equal(parseIso("2030-01-01T09:00:00"), undefined);
	assert.equal(parseIso("2030-02-30T09:00:00Z")?.toISOString().slice(0, 10) === "2030-02-30", false);
	assert.equal(parseIso("tomorrow"), undefined);
});
