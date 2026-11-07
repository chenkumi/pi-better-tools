import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newJobId, ScheduleStore, StoreLockUnavailable } from "../src/storage.ts";
import { parseStore, validateJob, validateSchedule } from "../src/validate.ts";
import type { Job } from "../src/types.ts";

const workspace = () => {
	const cwd = mkdtempSync(join(tmpdir(), "sc-store-"));
	mkdirSync(join(cwd, ".pi"));
	return { cwd, done: () => rmSync(cwd, { recursive: true, force: true }) };
};
const base = { enabled: true, createdAt: "2030-01-01T00:00:00Z", state: { runCount: 0 }, schedule: { type: "interval", everyMs: 60_000 } };
const job = (over: Record<string, unknown> = {}): Job => validateJob({ id: newJobId(), name: "n", ...(over.kind ? {} : { kind: "prompt", prompt: "hi" }), ...base, ...over });

test("new ids are upper-case ULIDs", () => {
	assert.match(newJobId(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("validation: every kind round-trips and unknown fields are rejected", () => {
	for (const extra of [
		{ kind: "prompt", prompt: "p" },
		{ kind: "agent", prompt: "p", model: "m", notify: true, extensions: ["a"], skills: false },
		{ kind: "shell", command: "echo hi", shell: "bash", cwd: "sub", timeoutMs: 1000 },
		{ kind: "monitor", start: { source: { kind: "file", path: "a.log" }, wakeAgent: false } },
	]) assert.deepEqual(JSON.parse(JSON.stringify(job(extra))).kind, extra.kind);
	assert.throws(() => job({ bogus: 1 }), /job\.bogus is not a known field/);
	assert.throws(() => job({ kind: "shell", command: "x", prompt: "y" }), /job\.prompt is not a known field/);
	assert.throws(() => job({ kind: "shell", command: "x", shell: "zsh" }), /shell must be/);
	assert.throws(() => job({ kind: "agent", prompt: "p" }), /model must be a non-empty string/);
	assert.throws(() => job({ kind: "monitor", start: { source: { kind: "websocket" } } }), /start\.source\.kind must be one of command, file, system/);
	assert.throws(() => job({ kind: "monitor", start: { source: { kind: "file" } }, missed: "run-all" }), /not allowed for a monitor job/);
	assert.throws(() => job({ enabled: undefined }), /enabled is required/);
});

test("validation: schedules", () => {
	assert.deepEqual(validateSchedule({ type: "cron", expr: " 0 9 * * * ", timezone: "Asia/Taipei" }), { type: "cron", expr: "0 9 * * *", timezone: "Asia/Taipei" });
	assert.throws(() => validateSchedule({ type: "interval", everyMs: 500 }), /everyMs must be an integer from 1000/);
	assert.deepEqual(validateSchedule({ type: "interval", everyMs: 90 * 86_400_000 }), { type: "interval", everyMs: 90 * 86_400_000 });
	assert.throws(() => validateSchedule({ type: "once", at: "2030-01-01T09:00:00" }), /ISO 8601/);
	assert.throws(() => validateSchedule({ type: "cron", expr: "* * * * *", extra: 1 }), /schedule\.extra is not a known field/);
	assert.throws(() => validateSchedule({ type: "weekly" }), /must be "cron", "interval" or "once"/);
});

test("parseStore drops invalid and duplicate jobs but rejects a bad envelope", () => {
	const good = job();
	const parsed = parseStore({ version: 2, jobs: [good, { kind: "prompt" }, good] });
	assert.equal(parsed.store.jobs.length, 1);
	assert.deepEqual(parsed.dropped.map((x) => x.index), [1, 2]);
	assert.match(parsed.dropped[1].reason, /duplicated/);
	assert.throws(() => parseStore({ version: 1, jobs: [] }), /version must be 2/);
	assert.throws(() => parseStore({ version: 2, jobs: [], extra: 1 }), /store\.extra/);
});

test("store: missing file is empty, update persists atomically, no temp files are left", () => {
	const w = workspace();
	try {
		const store = new ScheduleStore(w.cwd);
		assert.deepEqual(store.read().store.jobs, []);
		const a = job();
		assert.equal(store.update((jobs) => ({ jobs: [...jobs, a], result: "added" })), "added");
		assert.deepEqual(new ScheduleStore(w.cwd).read().store.jobs, [a]);
		assert.equal(store.update((jobs) => ({ result: jobs.length })), 1, "returning no list leaves the file alone");
		assert.deepEqual(readdirSync(join(w.cwd, ".pi")).sort(), ["schedule-commands.json"]);
		assert.equal(JSON.parse(readFileSync(store.file, "utf8")).version, 2);
	} finally { w.done(); }
});

test("store: an unusable file is moved aside, never overwritten silently", () => {
	const w = workspace();
	try {
		const store = new ScheduleStore(w.cwd);
		writeFileSync(store.file, "{ not json");
		const loaded = store.read();
		assert.deepEqual(loaded.store.jobs, []);
		assert.ok(loaded.quarantined && readFileSync(loaded.quarantined, "utf8") === "{ not json");
		assert.equal(existsSync(store.file), false);
	} finally { w.done(); }
});

test("store: invalid jobs are dropped on read, and a backup of the original is kept before the next write", () => {
	const w = workspace();
	try {
		const store = new ScheduleStore(w.cwd);
		const good = job();
		const original = JSON.stringify({ version: 2, jobs: [good, { kind: "prompt", name: "broken" }] });
		writeFileSync(store.file, original);
		assert.equal(store.read().dropped.length, 1);
		assert.equal(readFileSync(store.file, "utf8"), original, "reading never rewrites");
		store.update((jobs) => ({ jobs, result: undefined }));
		const backup = readdirSync(join(w.cwd, ".pi")).find((name) => name.includes(".invalid-"));
		assert.ok(backup);
		assert.equal(readFileSync(join(w.cwd, ".pi", backup!), "utf8"), original);
		assert.equal(JSON.parse(readFileSync(store.file, "utf8")).jobs.length, 1);
	} finally { w.done(); }
});

test("store: a held lock makes update fail without touching the file; a stale lock is taken over", () => {
	const w = workspace();
	const previous = process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS;
	process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS = "100";
	try {
		const store = new ScheduleStore(w.cwd);
		const lock = join(w.cwd, ".pi", "schedule-commands.lock");
		mkdirSync(lock);
		assert.throws(() => store.update((jobs) => ({ jobs: [...jobs, job()], result: 1 })), StoreLockUnavailable);
		assert.equal(existsSync(store.file), false);
		assert.equal(existsSync(lock), true, "a lock we did not take is left alone");
		const old = new Date(Date.now() - 120_000);
		utimesSync(lock, old, old);
		assert.equal(store.update((jobs) => ({ jobs: [...jobs, job()], result: "ok" })), "ok");
		assert.equal(existsSync(lock), false, "the lock is released afterwards");
	} finally {
		if (previous === undefined) delete process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS; else process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS = previous;
		w.done();
	}
});

test("store: the legacy Schedule Prompt file is detected but never read or changed", () => {
	const w = workspace();
	try {
		const store = new ScheduleStore(w.cwd);
		assert.equal(store.hasLegacyFile(), false);
		writeFileSync(store.legacyFile, "legacy");
		assert.equal(store.hasLegacyFile(), true);
		store.update((jobs) => ({ jobs: [job()], result: undefined }));
		assert.equal(readFileSync(store.legacyFile, "utf8"), "legacy");
	} finally { w.done(); }
});
