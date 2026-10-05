import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs } from "../extensions/subagent/background.ts";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function handle() {
	const controls: any[] = [], queries: any[] = []; let running = true;
	return { controls, queries, get isRunning() { return running; }, close() { running = false; }, snapshot() { return { controls: controls.map(c => ({ ...c })), queries: queries.map(q => ({ ...q })) }; },
		control(_message: string) { const receipt = { messageId: `control-${controls.length}`, status: "accepted" }; controls.push(receipt); return receipt; },
		query(_message: string) { const receipt = { queryId: `query-${queries.length}`, status: "accepted" }; queries.push(receipt); return receipt; } };
}
test("exact target authorization, cross-task query quota and detached settled receipts", async () => {
	const entered = deferred(), release = deferred(), retired = deferred(), done = deferred(); const children = [handle(), handle()];
	const jobs = new BackgroundJobs(kind => { if (kind === "task_result") done.resolve(); });
	const receipt = jobs.submit("owner", "/cwd", jobs.epoch, ["worker", "worker"], async (_signal, _ids, live, finish, attach) => {
		for (let index = 0; index < 2; index++) { live(index, `session-${index}`, `/log-${index}.partial`); attach(index, children[index] as any); }
		entered.resolve(); await retired.promise; children[0].close(); finish(0, {}, "completed");
		await release.promise; children[1].close(); finish(1, {}, "completed");
	});
	try {
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[0].taskId, "control", "early", "owner", "/cwd"), /TASK_NOT_RUNNING/);
		await entered.promise;
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[0].taskId, "query", "wrong", "other", "/cwd"), /NOT_FOUND/);
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[0].taskId, "query", "wrong", "owner", "/other"), /NOT_FOUND/);
		assert.throws(() => jobs.message(receipt.jobId, "bad-task", "query", "wrong", "owner", "/cwd"), /TASK_NOT_RUNNING/);
		jobs.message(receipt.jobId, receipt.tasks[0].taskId, "control", "literal", "owner", "/cwd"); children[0].controls[0].status = "applied";
		for (const task of receipt.tasks) jobs.message(receipt.jobId, task.taskId, "query", "query", "owner", "/cwd");
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[1].taskId, "query", "third", "owner", "/cwd"), /CAPACITY/);
		for (const child of children) child.queries[0].status = "completed";
		children[0].queries.push(...Array.from({ length: 30 }, (_, i) => ({ queryId: `retained-${i}`, status: "completed" })));
		retired.resolve(); await Promise.resolve();
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[1].taskId, "query", "retired quota still counts", "owner", "/cwd"), /CAPACITY/);
		children[0].queries[0].status = "failed"; children[0].controls[0].status = "unknown";
		const task = jobs.get(receipt.jobId, "owner", "/cwd").tasks[0];
		assert.equal(task.canMessage, false); assert.equal(task.queries![0].status, "completed"); assert.equal(task.controls![0].status, "applied", "settled status does not retain old transport handle");
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[0].taskId, "control", "late", "owner", "/cwd"), /TASK_NOT_RUNNING/);
		release.resolve(); await done.promise;
	} finally { retired.resolve(); release.resolve(); await jobs.shutdown(); }
});
