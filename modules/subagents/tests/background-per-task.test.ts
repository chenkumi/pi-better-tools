import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs, type BackgroundReceipt } from "../extensions/subagent/background.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Seen = { kind: string; receipt: BackgroundReceipt; scope: any };
const collect = (seen: Seen[], wake?: (kind: string) => void) => (kind: string, receipt: BackgroundReceipt, _interaction?: unknown, scope?: unknown) => { seen.push({ kind, receipt, scope }); wake?.(kind); };

test("perTaskNotify: a finished sibling is announced before the slow sibling ends; job_result follows once", async () => {
	const seen: Seen[] = [];
	const firstSeen = deferred(), jobDone = deferred(), release = deferred();
	const jobs = new BackgroundJobs(collect(seen, kind => { if (kind === "task_result") firstSeen.resolve(); if (kind === "job_result") jobDone.resolve(); }) as any);
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, ["fast", "slow"], async (_signal, _ids, _live, finish) => {
		finish(0, { output: "fast done" }, "completed");
		await release.promise;
		finish(1, { output: "slow done" }, "completed");
	}, [], undefined, undefined, { perTaskNotify: true });
	await firstSeen.promise;
	const early = seen.filter(n => n.kind === "task_result");
	assert.equal(early.length, 1, "only the fast task is announced while the slow one still runs");
	assert.equal(early[0].scope.taskId, receipt.tasks[0].taskId);
	assert.deepEqual([early[0].scope.completed, early[0].scope.total], [1, 2]);
	assert.deepEqual(early[0].receipt.tasks.map(t => t.taskId), [receipt.tasks[0].taskId], "notice carries only the finished task");
	assert.equal(seen.some(n => n.kind === "job_result"), false);
	release.resolve(); await jobDone.promise;
	assert.deepEqual(seen.filter(n => n.kind !== "log_ready").map(n => n.kind), ["task_result", "task_result", "job_result"]);
	const final = seen.find(n => n.kind === "job_result")!;
	assert.equal(final.receipt.status, "completed"); assert.equal(final.receipt.tasks.length, 2);
	assert.equal(final.scope.unnotified, 0, "every task was already announced individually");
	await jobs.shutdown();
});

test("perTaskNotify: cancelled or skipped tasks are covered by job_result with unnotified > 0", async () => {
	const seen: Seen[] = [];
	const jobDone = deferred();
	const jobs = new BackgroundJobs(collect(seen, kind => { if (kind === "job_result") jobDone.resolve(); }) as any);
	jobs.submit("owner", "/cwd", jobs.epoch, ["a", "b"], async (_signal, _ids, _live, finish) => { finish(0, { error: "boom" }, "failed"); }, [], undefined, undefined, { perTaskNotify: true });
	await jobDone.promise;
	assert.equal(seen.filter(n => n.kind === "task_result").length, 1);
	assert.equal(seen.find(n => n.kind === "job_result")!.scope.unnotified, 1, "task b never ran, so the summary must wake the parent");
	await jobs.shutdown();
});

test("default (no perTaskNotify) keeps one task_result for the whole job", async () => {
	const seen: Seen[] = [];
	const done = deferred();
	const jobs = new BackgroundJobs(collect(seen, kind => { if (kind === "task_result") done.resolve(); }) as any);
	jobs.submit("owner", "/cwd", jobs.epoch, ["a", "b"], async (_s, _i, _l, finish) => { finish(0, {}, "completed"); finish(1, {}, "completed"); });
	await done.promise;
	assert.deepEqual(seen.map(n => n.kind), ["task_result"]);
	assert.equal(seen[0].scope, undefined);
	await jobs.shutdown();
});
