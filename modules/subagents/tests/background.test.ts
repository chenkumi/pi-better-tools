import assert from "node:assert/strict";
import test from "node:test";
import { retainResultSummary, resultSummary } from "../extensions/subagent/result.ts";
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
	assert.match(receipt.jobId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.match(receipt.tasks[0].taskId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
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
test("ready-query cleanup failure retains usage but never certifies cleanup or a completed answer", async () => {
  const done = deferred(); const notices: any[] = [];
  const queryId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const jobs = new BackgroundJobs((kind, _receipt, notice) => { if (kind === "query_result") { notices.push(notice); done.resolve(); } });
  try {
    const accepted = jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async (_signal, _ids, _live, finish, _attach, interaction) => {
      interaction(0, { kind: "query_result", queryId, status: "completed", output: "must not look successful", usage: { totalTokens: 7 }, cleanupPending: false });
      finish(0, { status: "completed", output: "must not look successful", usage: { totalTokens: 7 }, cleanupPending: false, cleanupEvidence: { childClosed: true, ioSettled: true, temporaryRemoved: true, originalLeaseReleased: true } }, "completed");
      throw new Error("LEASE_RELEASE_FAILED: original read lease not confirmed released");
    }, [], undefined, queryId);
    await done.promise;
    assert.equal(notices[0].status, "failed"); assert.equal(notices[0].cleanupPending, true);
    assert.equal(notices[0].usage.totalTokens, 7); assert.equal(notices[0].output, undefined);
    assert.match(notices[0].error, /LEASE_RELEASE_FAILED/);
    const final = jobs.get(accepted.jobId, "owner", "/cwd").tasks[0];
    const result = final.result as any;
    assert.equal(result.status, "failed"); assert.equal(result.cleanupPending, true);
    assert.equal(result.cleanupEvidence.originalLeaseReleased, false);
    assert.equal(result.output, undefined); assert.equal(result.usage.totalTokens, 7);
    assert.equal(final.queries![0].cleanupPending, result.cleanupPending);
    assert.equal((final.queries![0].cleanupEvidence as any).originalLeaseReleased, result.cleanupEvidence.originalLeaseReleased);
  } finally { await jobs.shutdown(); }
});
test("ready-query worker failure outranks a completed RPC snapshot while cleanup is held", async () => {
	const entered = deferred(), release = deferred(); const queryId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
	const jobs = new BackgroundJobs(() => {});
	try {
		const accepted = jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async (_signal, _ids, _live, finish, attach, interaction) => {
			attach(0, { isRunning: true, close() {}, snapshot: () => ({ controls: [], queries: [{ queryId, status: "completed", output: "stale answer", cleanupPending: false, usage: { totalTokens: 7 } }] }) } as any);
			interaction(0, { kind: "query_result", queryId, status: "failed", error: "QUERY_MAINLINE_FORBIDDEN", cleanupPending: true, usage: { totalTokens: 7 } });
			entered.resolve(); await release.promise; finish(0, { status: "failed" }, "failed");
		}, [], undefined, queryId);
		await entered.promise;
		const query = jobs.get(accepted.jobId, "owner", "/cwd").tasks[0].queries![0];
		assert.equal(query.status, "failed"); assert.equal(query.cleanupPending, true);
		assert.equal(query.output, undefined); assert.equal((query.usage as any).totalTokens, 7);
		assert.match(String(query.error), /QUERY_MAINLINE_FORBIDDEN/);
	} finally { release.resolve(); await jobs.shutdown(); }
});
test("ready-query success remains provisional until original lease cleanup settles", async () => {
	const entered = deferred(), release = deferred(), done = deferred(); const queryId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
	const jobs = new BackgroundJobs(kind => { if (kind === "query_result") done.resolve(); });
	try {
		const accepted = jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async (_signal, _ids, _live, finish, _attach, interaction) => {
			interaction(0, { kind: "query_result", queryId, status: "completed", output: "verified answer", cleanupPending: false });
			finish(0, { status: "completed", output: "verified answer", cleanupPending: false, cleanupEvidence: { originalLeaseReleased: true } }, "completed");
			entered.resolve(); await release.promise;
		}, [], undefined, queryId);
		await entered.promise;
		const pending = jobs.get(accepted.jobId, "owner", "/cwd").tasks[0];
		assert.equal(pending.status, "running"); assert.equal(pending.queries![0].status, "accepted");
		assert.equal(pending.queries![0].cleanupPending, true); assert.equal(pending.queries![0].output, undefined);
		assert.equal((pending.queries![0].cleanupEvidence as any).originalLeaseReleased, false);
		assert.equal(pending.result, undefined, "private worker result must not contradict the authoritative pending receipt");
		release.resolve(); await done.promise;
		const final = jobs.get(accepted.jobId, "owner", "/cwd").tasks[0].queries![0];
		assert.equal(final.status, "completed"); assert.equal(final.output, "verified answer");
		assert.equal((final.cleanupEvidence as any).originalLeaseReleased, true);
	} finally { release.resolve(); await jobs.shutdown(); }
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

test("background terminal metadata survives detached views, list and retained head; legacy remains compatible", async () => {
	const done = deferred();
	const jobs = new BackgroundJobs(kind => { if (kind === "task_result") done.resolve(); });
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async (_signal, _ids, _live, finish) => {
		const result = { output: "Early progress\n" + "p".repeat(8192), status: "completed", exitCode: 0 };
		retainResultSummary(result, "完成🙂 Final conclusion"); finish(0, result, "completed");
	});
	await done.promise;
	const result = jobs.get(receipt.jobId, "owner", "/cwd").tasks[0].result as any;
	assert.match(result.output, /^Early progress/);
	assert.equal(resultSummary(result, 512), "完成🙂 Final conclusion");
	assert.equal(jobs.list("owner", "/cwd")[0].tasks[0].summary, "完成🙂 Final conclusion");
	assert.equal(resultSummary(JSON.parse(JSON.stringify(result)), 512), "Early progress", "legacy serialized details are not rewritten");
	assert.equal(Object.hasOwn(result, "summary"), false, "no public result/schema field added");
	await jobs.shutdown();
});

test("notification evidence distinguishes canonical applied, callback attempted/returned and stale suppression", async () => {
	const entered = deferred(), release = deferred(), returned = deferred();
	const events: any[] = [], notifications: any[] = [];
	const jobs = new BackgroundJobs((kind, _receipt, notice) => { notifications.push({ kind, notice }); }, undefined, undefined, event => { events.push(event); if (event.phase === "callback_returned" && event.kind === "control_result") returned.resolve(); throw new Error("observer failure is isolated"); });
	jobs.submit("owner", "/cwd", jobs.epoch, ["worker"], async (_signal, _ids, _live, finish, _attach, interaction) => {
		interaction(0, { kind: "control_result", status: "applied", messageId: "id", secret: "must not enter evidence" }); entered.resolve();
		await release.promise;
		interaction(0, { kind: "control_result", status: "applied", messageId: "late-id", secret: "must not enter evidence" }); finish(0, {}, "aborted");
	});
	await entered.promise; await returned.promise;
	assert.deepEqual(events.map(event => event.phase), ["canonical_applied", "callback_attempted", "callback_returned"]);
	const shutdown = jobs.shutdown(); release.resolve(); await shutdown;
	assert.deepEqual(events.slice(3).map(event => event.phase), ["canonical_applied", "suppressed", "suppressed"]);
	assert.equal(notifications.length, 1, "late canonical evidence never resends or revives a notice");
	assert.equal(events.every(event => event.hostAcknowledgment === "unknown"), true);
	assert.equal(JSON.stringify(jobs.notificationEvidence()).includes("secret"), false);
	assert.equal(JSON.stringify(jobs.notificationEvidence()).includes("late-id"), false);
	assert.ok(jobs.notificationEvidence().events.length <= 128);
});

test("slim list preserves known true/false and leaves undefined unknown", () => {
	const list = slimJobList([{ jobId: "j", status: "running", cancelRequested: true, tasks: [true, false, undefined].map((canMessage, index) => ({ taskId: String(index), agent: "a", status: "running", canMessage })) }]) as any;
	assert.equal(list.jobs[0].cancelRequested, true);
	assert.equal(list.jobs[0].tasks[0].canMessage, true); assert.equal(list.jobs[0].tasks[1].canMessage, false);
	assert.equal(Object.hasOwn(list.jobs[0].tasks[2], "canMessage"), false);
});

test("model-visible receipt preserves negative operation flags and omits unrelated defaults/duplicates", () => {
	const receipt: BackgroundReceipt = { jobId: "j", status: "completed", cancelRequested: false, tasks: [
		{ taskId: "t1", agent: "worker", status: "completed", logPending: false, subagentSessionId: "s1", canMessage: false, result: { agent: "worker", status: "completed", exitCode: 0, stopReason: "stop", canResume: true, subagentSessionId: "s1", output: "done", logPath: "/l.jsonl", usage: { totalTokens: 12 }, model: "m", outputTruncated: false } },
		{ taskId: "t2", agent: "scout", status: "failed", logPending: true, result: { exitCode: 1, errorCode: "E", errorMessage: "boom" } },
	] };
	const slim = slimReceipt(receipt, "task_result") as any;
	assert.deepEqual(slim, { kind: "task_result", jobId: "j", status: "completed", cancelRequested: false, tasks: [
		{ taskId: "t1", agent: "worker", status: "completed", subagentSessionId: "s1", canMessage: false, logPending: false, result: { output: "done", logPath: "/l.jsonl", canResume: true, usage: { totalTokens: 12 } } },
		{ taskId: "t2", agent: "scout", status: "failed", canMessage: false, logPending: true, result: { errorCode: "E", errorMessage: "boom", exitCode: 1 } },
	] });
	assert.deepEqual(slimJobList([{ jobId: "j", status: "running", cancelRequested: false, tasks: [{ taskId: "t", agent: "a", status: "running", canMessage: false }] }]), { jobs: [{ jobId: "j", status: "running", cancelRequested: false, tasks: [{ taskId: "t", agent: "a", status: "running", canMessage: false }] }] });
});
