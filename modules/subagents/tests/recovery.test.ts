import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs } from "../extensions/subagent/background.ts";
import { BackgroundRecovery, RECOVERY_ENTRY, recoveryCwd } from "../../shell-tools/src/recovery.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
function fixture() {
  const entries: any[] = [], messages: any[] = []; let fail = false;
  const owner = "owner", cwd = recoveryCwd(process.cwd());
  const ctx: any = { cwd, sessionManager: { getSessionId: () => owner, getHeader: () => ({ id: owner }), getEntries: () => entries, getBranch: () => entries } };
  const pi: any = { appendEntry(customType: string, data: any) { if (fail) throw new Error("IO failure"); entries.push({ type: "custom", customType, data }); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); entries.push({ type: "custom_message", ...message }); } };
  const recovery = new BackgroundRecovery(pi, "subagent"); recovery.bind(ctx);
  const jobs = new BackgroundJobs(() => {}, undefined, undefined, undefined, (o, c, s) => recovery.accept(s, { owner: o, cwd: c }));
  return { jobs, recovery, owner, cwd, ctx, entries, messages, fail: () => fail = true };
}

test("managed identities are journaled before runner admission; output/control/query payloads are excluded", async () => {
  const f = fixture(), entered = deferred(), finish = deferred();
  try {
    const receipt = await f.jobs.submitManaged(f.owner, f.cwd, f.jobs.epoch, ["worker"], async () => ["CHILD"], async (_signal, _ids, live, done) => {
      const accepted = f.entries.findLast(e => e.data?.state === "queued");
      assert.equal(accepted.data.tasks[0].subagentSessionId, "CHILD");
      live(0, "CHILD", "/log.partial"); entered.resolve(); await finish.promise;
      done(0, { exitCode: 0, output: "SECRET", errorMessage: "SECRET", queries: [{ answer: "SECRET" }] }, "completed");
    });
    await entered.promise;
    assert.equal(receipt.tasks[0].status, "queued");
    const latest = f.entries.at(-1).data; assert.equal(latest.started, true); assert.equal(latest.tasks[0].state, "running");
    finish.resolve(); await f.jobs.shutdown();
    const last = f.entries.at(-1).data; assert.equal(last.terminal, true); assert.equal(last.tasks[0].exitCode, 0);
    assert.doesNotMatch(JSON.stringify(f.entries.filter(e => e.customType === RECOVERY_ENTRY)), /SECRET|queries|controls|output/);
    f.recovery.close(); f.recovery.bind(f.ctx);
    assert.equal(f.messages[0].message.details.jobs[0].finding, "terminal_result_recorded");
    assert.deepEqual(f.messages[0].options, { triggerTurn: false });
  } finally { finish.resolve(); await f.jobs.shutdown(); f.recovery.close(); }
});

test("managed acceptance journal failure releases submitted capacity and never executes runner", async () => {
  const f = fixture(); f.fail(); let runs = 0, prepares = 0;
  try {
    await assert.rejects(f.jobs.submitManaged(f.owner, f.cwd, f.jobs.epoch, Array(32).fill("worker"), async () => { prepares++; return Array(32).fill("CHILD"); }, async () => { runs++; }), /BACKGROUND_JOURNAL_FAILED/);
    assert.equal(runs, 0); assert.equal(prepares, 0); assert.deepEqual(f.jobs.list(f.owner, f.cwd), []);
    // Holding the exact same 32-task process-wide budget proves failure released it.
    const another = new BackgroundJobs(() => {});
    another.submit(f.owner, f.cwd, another.epoch, Array(32).fill("worker"), async () => {});
    await another.shutdown();
  } finally { await f.jobs.shutdown(); f.recovery.close(); }
});

test("prepare rejection retains unstarted intent and failure evidence without acceptance notification", async () => {
  const f = fixture(); let runs = 0;
  try {
    await assert.rejects(f.jobs.submitManaged(f.owner, f.cwd, f.jobs.epoch, ["worker"], async () => { throw new Error("prepare failed"); }, async () => { runs++; }), /prepare failed/);
    assert.equal(runs, 0); assert.equal(f.entries.length, 2); assert.equal(f.messages.length, 0);
    assert.equal(f.entries[0].data.started, false); assert.equal(f.entries.at(-1).data.terminal, true); assert.equal(f.entries.at(-1).data.state, "failed");
  } finally { await f.jobs.shutdown(); f.recovery.close(); }
});

test("shutdown retains cancellation reason/aborted result but cannot replay callbacks into new binding", async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let late!: () => void;
  try {
    await f.jobs.submitManaged(f.owner, f.cwd, f.jobs.epoch, ["worker"], async () => ["CHILD"], async (_signal, _ids, live, finish) => {
      live(0, "CHILD", "/log.partial"); entered.resolve(); await release.promise;
      finish(0, { exitCode: 1 }, "aborted"); late = () => finish(0, { exitCode: 0 }, "completed");
    });
    await entered.promise; f.recovery.shutdown("reload"); const shutdown = f.jobs.shutdown(); release.resolve(); await shutdown;
    f.recovery.close(); f.recovery.bind(f.ctx);
    const report = f.messages[0].message.details;
    assert.equal(report.jobs[0].reason, "reload"); assert.equal(report.jobs[0].outcome, "aborted"); assert.equal(report.jobs[0].processTreeState, "unknown");
    const count = f.entries.length; late(); assert.equal(f.entries.length, count, "old recorder cannot write in the new epoch");
  } finally { release.resolve(); await f.jobs.shutdown(); f.recovery.close(); }
});
