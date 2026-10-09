import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs } from "../extensions/subagent/background.ts";
import { reserveContinuation } from "../extensions/subagent/message-reservation.ts";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("registry resolves queued/startup/running/finalizing/canceling from current evidence, not saved canMessage", async () => {
	const allocated = deferred(), startup = deferred(), attachNow = deferred(), settled = deferred(), release = deferred(), entered = deferred(), liveReady = deferred(), attached = deferred(), finalized = deferred(), done = deferred();
	let running = true, controls = 0;
	const handle: any = { get isRunning() { return running; }, snapshot: () => ({ controls: [], queries: [] }), control(text: string) { assert.equal(text, "literal"); controls++; return { messageId: "accepted", status: "accepted" }; }, query: () => ({ queryId: "query", status: "accepted" }), close() { running = false; } };
	const jobs = new BackgroundJobs(kind => { if (kind === "task_result") done.resolve(); });
	try {
		const pending = jobs.submitManaged("owner", "/cwd", jobs.epoch, ["worker"], async () => { entered.resolve(); await allocated.promise; return ["stable-session"]; }, async (_signal, _ids, live, finish, attach) => {
			await startup.promise; live(0, "stable-session", "/actual.partial"); liveReady.resolve(); await attachNow.promise; attach(0, handle); attached.resolve();
			await settled.promise; running = false; finalized.resolve(); await release.promise; finish(0, {}, "completed");
		});
		await entered.promise; allocated.resolve(); const receipt = await pending;
		assert.equal(jobs.locate("stable-session", "owner", "/cwd")?.state, "queued");
		assert.throws(() => jobs.locate("stable-session", "foreign", "/cwd"), /OWNER_MISMATCH:/);
		assert.throws(() => jobs.locate("stable-session", "owner", "/foreign-cwd"), /OWNER_MISMATCH:/);
		assert.equal(jobs.locate("unknown-session", "owner", "/cwd"), undefined);
		startup.resolve(); await liveReady.promise; assert.equal(jobs.locate("stable-session", "owner", "/cwd")?.state, "startup");
		attachNow.resolve(); await attached.promise; assert.equal(jobs.locate("stable-session", "owner", "/cwd")?.state, "running");
		const saved = jobs.get(receipt.jobId, "owner", "/cwd"); assert.equal(saved.tasks[0].canMessage, true);
		assert.equal(jobs.message(receipt.jobId, receipt.tasks[0].taskId, "control", "literal", "owner", "/cwd").status, "accepted");
		settled.resolve(); await finalized.promise;
		assert.equal(saved.tasks[0].canMessage, true); assert.equal(jobs.locate("stable-session", "owner", "/cwd")?.state, "finalizing");
		assert.throws(() => jobs.message(receipt.jobId, receipt.tasks[0].taskId, "control", "literal", "owner", "/cwd"), /TASK_NOT_RUNNING/); assert.equal(controls, 1, "no accepted-control replay on settlement");
		jobs.cancel(receipt.jobId, "owner", "/cwd"); assert.equal(jobs.locate("stable-session", "owner", "/cwd")?.state, "canceling");
		release.resolve(); await done.promise; assert.equal(jobs.locate("stable-session", "owner", "/cwd"), undefined);
	} finally { allocated.resolve(); startup.resolve(); attachNow.resolve(); settled.resolve(); release.resolve(); await jobs.shutdown(); }
});

test("allocation failure releases admission and emits no completion for an unaccepted create", async () => {
	let notifications = 0, ran = false; const jobs = new BackgroundJobs(() => { notifications++; });
	try {
		await assert.rejects(jobs.submitManaged("owner", "/cwd", jobs.epoch, Array(32).fill("worker"), async () => { throw new Error("allocation failure"); }, async () => { ran = true; }), /allocation failure/);
		assert.equal(ran, false); assert.equal(notifications, 0); assert.match(jobs.load(), /submitted 0\/32/); assert.deepEqual(jobs.list("owner", "/cwd"), []);
	} finally { await jobs.shutdown(); }
});

test("process-wide reservation survives duplicate extension instances and releases idempotently", () => {
	const release = reserveContinuation("/canonical-root", "same-session");
	try { assert.throws(() => reserveContinuation("/canonical-root", "same-session"), /SESSION_BUSY/); } finally { release(); release(); }
	reserveContinuation("/canonical-root", "same-session")();
});
