import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobs } from "../extensions/subagent/background.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSession, snapshotConfig, canonicalCwd } from "../extensions/subagent/session-store.ts";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
test("R8 cancelled preparation returns while actual allocation retains admission until settlement", async () => {
 const entered = deferred(), release = deferred(), settled = deferred();
 const jobs = new BackgroundJobs(() => { throw new Error("no notification before admission"); });
 let ran = false, outcome: string | undefined;
 const submission = jobs.submitManaged("owner", "/isolated-cwd", jobs.epoch, Array(32).fill("worker"), async () => {
  entered.resolve(); await release.promise; settled.resolve(); return Array(32).fill("real-owned-id");
 }, async () => { ran = true; }).then(() => { outcome = "accepted"; }, () => { outcome = "rejected"; });
 try {
  await entered.promise;
  const id = jobs.list("owner", "/isolated-cwd")[0].jobId;
  jobs.cancel(id, "owner", "/isolated-cwd");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(outcome, "rejected", "cancellation must stop waiting before actual allocation settles");
  assert.match(jobs.load(), /submitted 32\/32/);
  assert.throws(() => jobs.submit("owner", "/isolated-cwd", jobs.epoch, ["worker"], async () => {}), /CAPACITY/);
  assert.equal(ran, false);
  release.resolve(); await settled.promise; await submission;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(jobs.load(), /submitted 0\/32/); assert.equal(ran, false);
 } finally { release.resolve(); await submission; await jobs.shutdown(); }
});

for (const cancellation of ["tool", "shutdown"] as const) {
 test(`R8 actual late manifest I/O stays owned through ${cancellation} cancellation`, async (t) => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "pi-review-allocation-"));
  const cwd = await canonicalCwd(root), filePath = join(root, "agent.md");
  await fs.promises.writeFile(filePath, "offline fixture");
  const config = await snapshotConfig({ name: "worker", description: "fixture", source: "bundled", filePath, systemPrompt: "offline" }, "user", cwd, "offline/model", "off", false);
  const entered = deferred(), release = deferred(), settled = deferred(), tool = new AbortController();
  const jobs = new BackgroundJobs(() => {});
  let ran = false, allocations = 0, outcome: string | undefined;
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, "rename", async (from: any, to: any) => {
   if (String(to).endsWith("manifest.json")) { entered.resolve(); await release.promise; }
   return rename(from, to);
  });
  const submission = jobs.submitManaged("owner", cwd, jobs.epoch, ["worker", "worker"], async signal => {
   try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
     if (signal.aborted) throw new Error("allocation stopped");
     const session = await ManagedSession.allocate(join(root, "managed"), { parentSessionId: "owner", parentCwd: cwd }, config);
     allocations++; ids.push(session.id);
    }
    return ids;
   } finally { settled.resolve(); }
  }, async () => { ran = true; }, [], undefined, undefined, tool.signal).then(() => { outcome = "accepted"; }, () => { outcome = "rejected"; });
  let closing: Promise<void> | undefined;
  try {
   await entered.promise;
   if (cancellation === "tool") tool.abort(); else closing = jobs.shutdown();
   await new Promise<void>(resolve => setImmediate(resolve));
   assert.equal(outcome, "rejected"); assert.match(jobs.load(), /submitted 2\/32/);
   assert.equal(allocations, 0); assert.equal(ran, false);
   release.resolve(); await settled.promise; await submission;
   await new Promise<void>(resolve => setImmediate(resolve));
   assert.equal(allocations, 1, "second allocation must never start after cancellation");
   assert.match(jobs.load(), /submitted 0\/32/); assert.equal(ran, false);
   const [id] = await fs.promises.readdir(join(root, "managed"));
   assert.equal(JSON.parse(await fs.promises.readFile(join(root, "managed", id, "manifest.json"), "utf8")).state, "new");
  } finally {
   release.resolve(); await settled.promise; await submission; await closing; await jobs.shutdown();
   t.mock.restoreAll(); await fs.promises.rm(root, { recursive: true, force: true });
  }
 });
}
