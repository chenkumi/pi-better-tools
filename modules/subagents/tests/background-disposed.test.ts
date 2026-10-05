import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs } from "../extensions/subagent/background.ts";

test("disposed-owner notification throws fail closed, abort work and suppress later callbacks", async () => {
	let notifications = 0;
	let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
	const jobs = new BackgroundJobs(() => { notifications++; throw new Error("Extension context disposed"); });
	const epoch = jobs.epoch;
	const receipt = jobs.submit("owner", "/cwd", epoch, ["worker"], async (signal, _ids, live, ended, _attach, interaction) => {
		live(0, "session", "/existing/transcript.jsonl.partial");
		assert.equal(signal.aborted, true, "observer failure synchronously closes the runtime and aborts owned work");
		interaction(0, { kind: "query_result" }); ended(0, {}, "aborted"); finish();
	});
	await done;
	assert.equal(notifications, 1, "no callback retries against a disposed context");
	assert.throws(() => jobs.get(receipt.jobId, "owner", "/cwd"), /NOT_FOUND/);
	assert.throws(() => jobs.submit("owner", "/cwd", epoch, ["worker"], async () => {}), /RUNTIME_CLOSED/);
	await jobs.shutdown();
});
