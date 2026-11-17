import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalMonitorCwd, requestScheduledShell } from "../../../shared/src/background/index.ts";
import { ShellJobs } from "../src/background-jobs.ts";
import { createScheduledShellPublisher } from "../src/scheduled-start.ts";

function setup(active: string[] = ["bash", "powershell"], sessionId = "sched-shell-owner") {
  const root = mkdtempSync(join(tmpdir(), "shell-sched-"));
  const sent: any[] = [];
  const jobs = new ShellJobs({ sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); } } as any);
  const executed: Array<{ toolCallId: string; input: any }> = [];
  const base = (ctx: any, wrap?: any) => ({
    execute: async (toolCallId: string, input: any) => { executed.push({ toolCallId, input }); return { content: [{ type: "text", text: "ok" }], details: undefined }; },
  });
  const publisher = createScheduledShellPublisher({ getActiveTools: () => active } as any, jobs, { bash: base, powershell: base } as any);
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
  jobs.start(ctx);
  publisher.start(ctx);
  const scope = { sessionId, cwd: canonicalMonitorCwd(root) };
  return { root, ctx, jobs, publisher, scope, sent, executed, done: async () => { publisher.stop(); await jobs.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

test("a starter is published per owner and revoked at shutdown", async () => {
  const s = setup();
  try {
    assert.ok(requestScheduledShell(s.scope));
    assert.equal(requestScheduledShell({ sessionId: "someone-else", cwd: s.scope.cwd }), undefined);
    s.publisher.stop();
    assert.equal(requestScheduledShell(s.scope), undefined);
  } finally { await s.done(); }
});

test("start adds an ordinary background shell job that runs the command and is reported on completion", async () => {
  const s = setup();
  try {
    const result = requestScheduledShell(s.scope)!.start({ tool: "bash", command: "echo hi", timeoutMs: 5000 });
    assert.ok("jobId" in result, JSON.stringify(result));
    const listed = s.jobs.list(s.ctx).map((job: any) => ({ id: job.jobId, tool: job.tool, command: job.command }));
    assert.deepEqual(listed, [{ id: (result as any).jobId, tool: "bash", command: "echo hi" }]);
    for (let i = 0; i < 50 && s.executed.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(s.executed.length, 1);
    assert.equal(s.executed[0].input.command, "echo hi");
    assert.equal(s.executed[0].input.timeout, 5, "timeoutMs is passed as the shell tool's total time limit");
    assert.match(s.executed[0].toolCallId, /^schedule-[0-9A-Z]{26}$/);
    for (let i = 0; i < 100 && s.sent.length === 0; i++) { s.jobs.flushPending(s.ctx); await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(s.sent[0]?.message.customType, "shell-job-completed", "Shell reports the completion itself");
    assert.deepEqual(s.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
  } finally { await s.done(); }
});

test("start refuses a shell that is not enabled and reports a refused submission as an error", async () => {
  const s = setup(["powershell"]);
  try {
    const starter = requestScheduledShell(s.scope)!;
    const disabled = starter.start({ tool: "bash", command: "x" });
    assert.match((disabled as any).error, /bash tool is not enabled/);
    assert.equal(s.jobs.list(s.ctx).length, 0);
    await s.jobs.shutdown();
    const stopped = starter.start({ tool: "powershell", command: "x" });
    assert.ok("error" in stopped, "a shut-down Shell starts nothing");
  } finally { await s.done(); }
});
