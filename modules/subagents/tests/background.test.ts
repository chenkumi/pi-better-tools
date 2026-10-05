import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs, slimJobList, slimReceipt, type BackgroundReceipt } from "../extensions/subagent/background.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
test("receipt is detached queued data; live paths appear only after runner admission and completion once", async () => {
	const admitted = deferred(), complete = deferred(), finished = deferred();
	const notifications: Array<{ kind: string; receipt: BackgroundReceipt }> = [];
	const jobs = new BackgroundJobs((kind, receipt) => { notifications.push({ kind, receipt }); if (kind === "task_result") finished.resolve(); });
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async (_signal, ids, live, finish) => {
		await admitted.promise; live(0, "session", "/existing/transcript.jsonl.partial");
		await complete.promise; finish(0, { taskId: ids[0], logPath: "/final/transcript.jsonl", canResume: true }, "completed");
	});
	assert.equal(receipt.status, "queued"); assert.equal(receipt.tasks[0].logPending, true);
	assert.equal(receipt.tasks[0].liveLogPath, undefined); assert.equal(receipt.tasks[0].subagentSessionId, undefined);
	assert.throws(() => jobs.get(receipt.jobId, "another", "/cwd"), /NOT_FOUND/);
	assert.throws(() => jobs.cancel(receipt.jobId, "owner", "/another"), /NOT_FOUND/);
	admitted.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.match(jobs.get(receipt.jobId, "owner", "/cwd").tasks[0].liveLogPath!, /\.partial$/);
	assert.equal(jobs.get(receipt.jobId, "owner", "/cwd").tasks[0].finalLogPath, "/existing/transcript.jsonl", "live notice also announces the post-rename path");
	assert.equal(receipt.tasks[0].liveLogPath, undefined, "receipt cannot mutate after it was returned");
	complete.resolve(); await finished.promise;
	const result = jobs.get(receipt.jobId, "owner", "/cwd"); assert.equal(result.status, "completed");
	assert.equal(result.tasks[0].liveLogPath, undefined); assert.equal(result.tasks[0].finalLogPath, undefined); assert.deepEqual(notifications.map(n => n.kind), ["log_ready", "task_result"]);
	assert.equal(jobs.cancel(receipt.jobId, "owner", "/cwd").cancelRequested, false, "late cancel cannot rewrite success");
	await jobs.shutdown();
});
test("process-wide 32 task admission survives cancellation until cleanup settles", async () => {
	const release = deferred(), finished = deferred();
	const jobs = new BackgroundJobs(kind => { if (kind === "task_result") finished.resolve(); });
	const another = new BackgroundJobs(() => {});
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, Array(32).fill("worker"), async signal => { await release.promise; assert.equal(signal.aborted, true); });
	assert.throws(() => another.submit("owner", "/cwd", another.epoch, ["worker"], async () => {}), /CAPACITY/);
	assert.equal(jobs.cancel(receipt.jobId, "owner", "/cwd").cancelRequested, true);
	assert.throws(() => another.submit("owner", "/cwd", another.epoch, ["worker"], async () => {}), /CAPACITY/);
	release.resolve(); await finished.promise;
	assert.equal(jobs.get(receipt.jobId, "owner", "/cwd").status, "aborted");
	another.submit("owner", "/cwd", another.epoch, ["worker"], async () => {});
	await jobs.shutdown(); await another.shutdown();
});
test("shutdown cancels owned work, rejects stale preflight and suppresses old callbacks after replacement", async () => {
	const waiting = deferred(), entered = deferred(); let notifications = 0;
	const jobs = new BackgroundJobs(() => { notifications++; }); const epoch = jobs.epoch;
	jobs.submit("old", "/cwd", epoch, ["worker"], async (signal, _ids, live, finish) => {
		entered.resolve(); await waiting.promise; assert.equal(signal.aborted, true);
		live(0, "old-session", "/old/transcript.jsonl.partial"); finish(0, {}, "aborted");
	});
	await entered.promise;
	const closing = jobs.shutdown(); waiting.resolve(); await closing; jobs.start();
	assert.equal(notifications, 0);
	assert.throws(() => jobs.submit("old", "/cwd", epoch, ["worker"], async () => {}), /RUNTIME_CLOSED/);
	await jobs.shutdown();
});
test("chain unscheduled items are skipped rather than invented logs/results", async () => {
	const done = deferred(); const jobs = new BackgroundJobs(kind => { if (kind === "task_result") done.resolve(); });
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, ["worker", "worker"], async (_signal, _ids, _live, finish) => { finish(0, { error: "failed" }, "failed"); });
	await done.promise; const tasks = jobs.get(receipt.jobId, "owner", "/cwd").tasks;
	assert.equal(tasks[1].status, "skipped"); assert.equal(tasks[1].logPending, true); assert.equal(tasks[1].liveLogPath, undefined); assert.equal(tasks[1].result, undefined);
	await jobs.shutdown();
});

test("capacity errors report submitted/active load and the next action; list is owner-scoped and read-only", async () => {
	const release = deferred(), finished = deferred();
	const jobs = new BackgroundJobs(kind => { if (kind === "task_result") finished.resolve(); }, () => 3);
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, Array(32).fill("worker"), async (_signal, ids, _live, finish) => { await release.promise; ids.forEach((_id, index) => finish(index, { output: "\n\nDone: first line\nsecond line" }, "completed")); });
	assert.throws(() => jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async () => {}), /BACKGROUND_CAPACITY.*submitted 32\/32, active 3\/8.*subagent_status.*subagent_cancel.*split/);
	assert.deepEqual(jobs.list("other", "/cwd"), []); assert.deepEqual(jobs.list("owner", "/elsewhere"), []);
	const running = jobs.list("owner", "/cwd"); assert.equal(running.length, 1); assert.equal(running[0].jobId, receipt.jobId); assert.equal(running[0].tasks.length, 32);
	release.resolve(); await finished.promise;
	const done = jobs.list("owner", "/cwd")[0];
	assert.equal(done.status, "completed"); assert.equal(done.tasks[0].summary, "Done: first line"); assert.equal(done.cancelRequested, false);
	await jobs.shutdown(); assert.deepEqual(jobs.list("owner", "/cwd"), []);
});

test("model-visible receipt text omits defaults and duplicates but keeps next-step fields", () => {
	const receipt: BackgroundReceipt = { jobId: "j", status: "completed", cancelRequested: false, tasks: [
		{ taskId: "t1", agent: "worker", status: "completed", logPending: false, subagentSessionId: "s1", canMessage: false, result: { agent: "worker", status: "completed", exitCode: 0, stopReason: "stop", canResume: true, subagentSessionId: "s1", output: "done", logPath: "/l.jsonl", usage: { totalTokens: 12 }, model: "m", outputTruncated: false } },
		{ taskId: "t2", agent: "scout", status: "failed", logPending: true, result: { exitCode: 1, errorCode: "E", errorMessage: "boom" } },
	] };
	const slim = slimReceipt(receipt, "task_result") as any;
	assert.deepEqual(slim, { kind: "task_result", jobId: "j", status: "completed", tasks: [
		{ taskId: "t1", agent: "worker", status: "completed", subagentSessionId: "s1", result: { output: "done", logPath: "/l.jsonl", canResume: true, usage: { totalTokens: 12 } } },
		{ taskId: "t2", agent: "scout", status: "failed", result: { errorCode: "E", errorMessage: "boom", exitCode: 1 } },
	] });
	assert.deepEqual(slimJobList([{ jobId: "j", status: "running", cancelRequested: false, tasks: [{ taskId: "t", agent: "a", status: "running", canMessage: false }] }]), { jobs: [{ jobId: "j", status: "running", tasks: [{ taskId: "t", agent: "a", status: "running" }] }] });
});
