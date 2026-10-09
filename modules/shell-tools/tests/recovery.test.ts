import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundRecovery, RECOVERY_ENTRY, RECOVERY_NOTICE, MAX_SCAN_ENTRIES, reconcileRecovery, recoveryCwd, recoveryText, renderRecoveryNotice } from "../src/recovery.ts";
import { ShellJobs } from "../src/background-jobs.ts";

const cwd = recoveryCwd(process.cwd());
const state = (fields: Record<string, unknown> = {}) => ({ type: "custom", customType: RECOVERY_ENTRY, data: {
  version: 1, kind: "shell", owner: "owner", cwd, runtimeId: "OLD", jobId: "JOB", state: "running", started: true, ...fields,
} });
const scan = (entries: any[], branch: any[] = [], kind: "shell" | "subagent" = "shell", options = {}) => reconcileRecovery(entries, branch, kind, "owner", cwd, { liveRuntimeIds: new Set(), ...options });
const boundary = () => new Promise<void>(r => setImmediate(r));
const success = () => ({ content: [{ type: "text" as const, text: "SECRET_OUTPUT" }], details: undefined, structuredContent: { output: "SECRET_OUTPUT", exit_code: 0 } });
function fixture(kind: "shell" | "subagent" = "shell") {
  const entries: any[] = [], messages: any[] = [];
  let owner = "owner", fail = false;
  const ctx: any = { cwd, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => owner, getEntries: () => entries.slice(), getBranch: () => entries.slice(), getHeader: () => ({ id: owner }) } };
  const pi: any = { appendEntry(customType: string, data: any) { if (fail) throw new Error("DISK_SECRET"); entries.push({ type: "custom", customType, data }); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); entries.push({ type: "custom_message", ...message }); } };
  const recovery = new BackgroundRecovery(pi, kind);
  return { ctx, pi, recovery, entries, messages, changeOwner: () => { owner = "foreign"; }, fail: () => { fail = true; } };
}

test("reconciliation distinguishes unknown, intent, shutdown and real terminal result without process-tree claims", () => {
  const r = scan([state(), state({ jobId: "QUEUED", state: "accepted", started: false }), state({ jobId: "CANCEL", shutdownReason: "quit" }),
    state({ jobId: "DONE", state: "completed", terminal: true, exitCode: 0 })]);
  assert.deepEqual(r.jobs.map(j => j.finding), ["terminal_result_recorded", "shutdown_cancellation_requested", "start_not_confirmed", "outcome_unknown"]);
  assert.equal(r.jobs[0].exitCode, 0); assert.equal(r.jobs[0].outcome, "completed");
  assert.ok(r.jobs.every(j => j.processTreeState === "unknown")); assert.match(recoveryText(r), /does not restart work/);
  assert.equal(r.incomplete, false);
});

test("newest journal state is authoritative and duplicates do not revert to earlier snapshots", () => {
  const r = scan([state(), state({ state: "failed", terminal: true, errorCode: "RPC_CLOSED" })]);
  assert.equal(r.jobs.length, 1); assert.equal(r.jobs[0].outcome, "failed"); assert.equal(r.jobs[0].errorCode, "RPC_CLOSED");
  assert.equal(r.jobs[0].exitCode, undefined);
});

test("foreign owner/cwd/kind and process-local live runtime are excluded", () => {
  const entries = [state({ owner: "foreign" }), state({ cwd: "/foreign" }), state({ kind: "subagent" }), state()];
  assert.equal(scan(entries).jobs.length, 1);
  assert.equal(scan(entries, [], "shell", { liveRuntimeIds: new Set(["OLD"]) }).jobs.length, 0);
});

test("deduplication uses persisted branch notice and permits new evidence and a different branch", () => {
  const s = state(), first = scan([s]);
  const notice = { type: "custom_message", customType: `${RECOVERY_NOTICE}-shell`, details: first };
  assert.equal(scan([s, notice], [notice]).jobs.length, 0);
  assert.equal(scan([s, notice], []).jobs.length, 1, "another branch needs model-visible context");
  assert.equal(scan([s, notice, state({ state: "completed", terminal: true, exitCode: 0 })], [notice]).jobs.length, 1);
});

test("persisted normal completion suppresses duplicates only on the active branch", () => {
  const s = state({ state: "completed", terminal: true, exitCode: 0 });
  const notice = { type: "custom_message", customType: "shell-job-completed", details: { jobs: [{ jobId: "JOB", status: "completed", exitCode: 0 }] } };
  assert.equal(scan([s, notice], [notice]).jobs.length, 0);
  assert.equal(scan([s, notice], []).jobs[0].finding, "terminal_result_recorded");
});

test("legacy shell receipt is conservative; ordinary command/output prose is not parsed as lifecycle", () => {
  const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "CALL", name: "bash", arguments: { background: true } }] } };
  const receipt = { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "CALL", content: [{ type: "text", text: "Background job accepted; its outcome will be reported when it finishes.\njob LEGACY running\nlog /tmp/log\nProgress: read log tail." }] } };
  assert.equal(scan([call, receipt]).jobs[0].finding, "start_not_confirmed");
  assert.equal(scan([call, receipt], [], "shell", { allowLegacy: false }).jobs.length, 0);
  assert.equal(scan([receipt]).jobs.length, 0, "uncorrelated command output cannot create job evidence");
  assert.equal(scan([call, { ...receipt, message: { ...receipt.message, toolName: "read" } }]).jobs.length, 0);
  assert.equal(scan([call, { ...receipt, message: { ...receipt.message, isError: true } }]).jobs.length, 0);
});

test("legacy status never overrides durable accepted/terminal journal; no output/prompt copying", () => {
  const receipt = { type: "message", message: { role: "toolResult", toolName: "shell_job_status", structuredContent: { jobId: "JOB", status: "running", command: "SECRET", output: "SECRET" } } };
  const report = scan([state({ state: "completed", terminal: true, exitCode: 0 }), receipt]);
  assert.equal(report.jobs[0].finding, "terminal_result_recorded"); assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test("subagent batches retain exact task/session identity, queued is not interactive or ready", () => {
  const s = state({ kind: "subagent", state: "queued", started: false, tasks: [{ taskId: "TASK", subagentSessionId: "CHILD", state: "queued" }] });
  const r = scan([s], [], "subagent");
  assert.equal(r.jobs[0].finding, "start_not_confirmed"); assert.equal(r.jobs[0].tasks![0].subagentSessionId, "CHILD");
  assert.equal(JSON.stringify(r).includes("canResume"), false);
  const n = { type: "custom_message", customType: "subagent_background", content: JSON.stringify({ kind: "task_result", jobId: "JOB", status: "aborted" }) };
  assert.equal(scan([s, n], [n], "subagent").jobs.length, 0);
});

test("malformed newest records are incomplete, never silently replaced by older successful evidence", () => {
  for (const invalid of [{ state: "invented" }, { version: 2 }, { runtimeId: "../escape" }, { tasks: Array(33).fill({ taskId: "T", state: "running" }) },
    { state: "running", terminal: true }, { state: "completed", terminal: true, tasks: [{ taskId: "T", state: "running" }] }]) {
    const r = scan([state({ state: "completed", terminal: true }), state(invalid)]);
    assert.equal(r.incomplete, true, JSON.stringify(invalid)); assert.equal(r.jobs.length, 0);
  }
});

test("bounded session scan and job findings explicitly report omitted/incomplete", () => {
  const many = Array.from({ length: 140 }, (_, i) => state({ jobId: `JOB_${i}` }));
  const r = scan(many); assert.equal(r.jobs.length, 32); assert.equal(r.omitted, 96); assert.equal(r.incomplete, true);
  const over = Array(MAX_SCAN_ENTRIES + 1).fill({ type: "custom", customType: "unrelated" });
  assert.equal(scan(over).incomplete, true);
});

test("identical incomplete diagnostic is deduped from persisted evidence but remains incomplete", () => {
  const f = fixture(); f.entries.push(state({ version: 2 })); f.recovery.bind(f.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].message.details.incomplete, true);
  f.recovery.close(); f.recovery.bind(f.ctx); assert.equal(f.messages.length, 1); f.recovery.close();
});

test("compacted-away branch notices do not suppress fresh model-visible evidence", () => {
  const f = fixture(); f.entries.push(state()); f.recovery.bind(f.ctx); f.recovery.close();
  assert.equal(f.messages.length, 1);
  f.ctx.sessionManager.buildContextEntries = () => [];
  f.recovery.bind(f.ctx); assert.equal(f.messages.length, 2); f.recovery.close();
});

test("legacy explicit status preserves confirmed failure/exit code rather than inventing pending work", () => {
  const s = { type: "message", message: { role: "toolResult", toolName: "shell_job_status", structuredContent: { jobId: "JOB", status: "failed", exitCode: 7 } } };
  assert.equal(scan([s]).jobs[0].finding, "terminal_result_recorded"); assert.equal(scan([s]).jobs[0].exitCode, 7);
});

test("old shell receipt without new preamble requires a correlated background call", () => {
  const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "CALL", name: "bash", arguments: { background: true } }] } };
  const receipt = { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "CALL", content: [{ type: "text", text: "job LEGACY running\nlog /tmp/log\nProgress: read log tail." }] } };
  assert.equal(scan([call, receipt]).jobs[0].finding, "start_not_confirmed");
  const spoof = { ...receipt, message: { ...receipt.message, content: [{ type: "text", text: '{"jobId":"FAKE","status":"running"}' }] } };
  assert.equal(scan([spoof]).jobs.length, 0);
  assert.equal(scan([{ ...call, message: { ...call.message, content: [{ ...call.message.content[0], arguments: { background: false } }] } }, spoof]).jobs.length, 0);
});

test("older malformed journal cannot erase newer confirmed terminal evidence", () => {
  const r = scan([state({ version: 2 }), state({ state: "completed", terminal: true })]);
  assert.equal(r.incomplete, true); assert.equal(r.jobs[0].finding, "terminal_result_recorded");
});

test("legacy and branch JSON parsing share an aggregate budget and report incomplete", () => {
  const text = JSON.stringify({ jobId: "LEGACY", status: "running" }) + " ".repeat(30000);
  const many = Array(200).fill({ type: "message", message: { role: "toolResult", toolName: "shell_job_status", content: [{ type: "text", text }] } });
  assert.equal(scan(many).incomplete, true);
  const branch = Array(200).fill({ type: "custom_message", customType: "shell-job-completed", content: "[]" + " ".repeat(30000) });
  assert.equal(scan([state()], branch).incomplete, true);
});

test("empty persisted and memory-only host contracts reject before journal or runner", () => {
  for (const file of ["/fixture/session.jsonl", undefined]) {
    const f = fixture(); f.ctx.sessionManager.getSessionFile = () => file;
    f.recovery.bind(f.ctx);
    assert.throws(() => f.recovery.accept({ jobId: "JOB", state: "accepted", started: false }), /BACKGROUND_JOURNAL_FAILED/);
    assert.equal(f.entries.length, 0); f.recovery.close();
  }
});

test("journal binds session, projects metadata, writes acceptance before runner, and sends no wake-up", async () => {
  const f = fixture(), jobs = new ShellJobs(f.pi); jobs.start(f.ctx);
  try {
    const receipt = jobs.submit(f.ctx, "bash", "TOOL", undefined, async () => {
      assert.ok(f.entries.some(e => e.customType === RECOVERY_ENTRY && e.data.jobId === receipt.jobId && e.data.started));
      return success();
    }, "SECRET_COMMAND");
    assert.equal(f.entries.at(-1).data.state, "accepted");
    await boundary(); await boundary(); await boundary();
    assert.ok(f.entries.some(e => e.data?.terminal && e.data.exitCode === 0));
    assert.doesNotMatch(JSON.stringify(f.entries.filter(e => e.type === "custom")), /SECRET_COMMAND|SECRET_OUTPUT/);
    assert.equal(f.messages[0].message.customType, "shell-job-completed");
    assert.deepEqual(f.messages[0].options, { triggerTurn: true, deliverAs: "followUp" }, "normal completion unchanged");
    await jobs.shutdown("quit"); jobs.start(f.ctx);
    assert.equal(f.messages.filter(m => m.message.customType === `${RECOVERY_NOTICE}-shell`).length, 0, "already persisted completion is not re-notified");
  } finally { await jobs.shutdown(); }
});

test("shell acceptance journal failure rejects before scheduling runner and leaks no registry slot", async () => {
  const f = fixture(), jobs = new ShellJobs(f.pi); jobs.start(f.ctx); f.fail(); let runs = 0;
  try {
    assert.throws(() => jobs.submit(f.ctx, "bash", "TOOL", undefined, async () => { runs++; return success(); }), /BACKGROUND_JOURNAL_FAILED/);
    await boundary(); assert.equal(runs, 0); assert.equal(jobs.list(f.ctx).length, 0);
  } finally { await jobs.shutdown(); }
});

test("orderly shell shutdown outcome is saved despite suppressed completion and reported on next bind", async () => {
  const f = fixture(), jobs = new ShellJobs(f.pi); jobs.start(f.ctx);
  let entered!: () => void; const running = new Promise<void>(r => entered = r);
  jobs.submit(f.ctx, "bash", "TOOL", undefined, async signal => {
    entered(); await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true })); throw new Error("Command aborted");
  });
  await running; await jobs.shutdown("quit"); assert.equal(f.messages.length, 0);
  jobs.start(f.ctx);
  try {
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0].message.details.jobs[0].outcome, "cancelled");
    assert.equal(f.messages[0].message.details.jobs[0].reason, "quit"); assert.deepEqual(f.messages[0].options, { triggerTurn: false });
  } finally { await jobs.shutdown(); }
});

test("late updates and foreign context cannot write to a rebound owner", () => {
  const f = fixture(); f.recovery.bind(f.ctx);
  const writer = f.recovery.accept({ jobId: "JOB", state: "accepted" });
  f.changeOwner(); assert.throws(() => f.recovery.accept({ jobId: "NEW", state: "accepted" }), /JOURNAL_FAILED/);
  const before = f.entries.length; writer.update({ jobId: "JOB", state: "completed", terminal: true });
  assert.equal(f.entries.length, before);
  f.recovery.bind(f.ctx); writer.update({ jobId: "JOB", state: "failed", terminal: true });
  assert.equal(f.entries.length, before);
  assert.throws(() => f.recovery.accept({ jobId: "NEW", state: "accepted" }, { owner: "other", cwd }), /JOURNAL_FAILED/);
  f.recovery.close();
});

test("reload recovery notice is persisted/deduped; updates after close do not mutate the new session", () => {
  const f = fixture(); f.recovery.bind(f.ctx); const w = f.recovery.accept({ jobId: "JOB", state: "running", started: true });
  f.recovery.close(); f.recovery.bind(f.ctx);
  assert.equal(f.messages.length, 1); assert.deepEqual(f.messages[0].options, { triggerTurn: false });
  const before = f.entries.length; w.update({ jobId: "JOB", state: "completed", terminal: true }); assert.equal(f.entries.length, before);
  f.recovery.close(); f.recovery.bind(f.ctx); assert.equal(f.messages.length, 1);
  f.recovery.close();
});

test("fork legacy fallback is disabled, durable owner metadata is enforced", () => {
  const f = fixture(); f.ctx.sessionManager.getHeader = () => ({ parentSession: "/original" });
  f.entries.push({ type: "message", message: { role: "toolResult", toolName: "bash", structuredContent: { jobId: "OLD", status: "running" } } });
  f.recovery.bind(f.ctx); assert.equal(f.messages.length, 0); f.recovery.close();
});

test("post-acceptance journal failure does not falsify or reject a completed job", async () => {
  const f = fixture(), jobs = new ShellJobs(f.pi); jobs.start(f.ctx);
  try {
    const r = jobs.submit(f.ctx, "bash", "TOOL", undefined, async () => { f.fail(); return success(); });
    await boundary(); await boundary(); await boundary(); assert.equal(jobs.status(f.ctx, r.jobId).status, "completed");
    assert.equal(f.messages[0].message.customType, "shell-job-completed");
  } finally { await jobs.shutdown(); }
});

const theme: any = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, getBgAnsi: () => "" };
test("recovery renderer is neutral, sanitized, bounded and has collapsed/expanded full identities", () => {
  const details = scan([state({ jobId: "FULL_JOB_123456", shutdownReason: "quit" })]);
  details.jobs[0].nextAction = "safe\x1b]52;c;SECRET\x07\u202e";
  const message: any = { role: "custom", customType: `${RECOVERY_NOTICE}-shell`, display: true, content: recoveryText(details), details };
  for (const expanded of [false, true]) for (const width of [0, 1, 2, 30, 100]) {
    const before = JSON.stringify(message), rendered = renderRecoveryNotice(message, { expanded }, theme).render(width);
    assert.ok(rendered.length <= 300); assert.ok(rendered.every(l => visibleWidth(l) <= width));
    assert.doesNotMatch(rendered.join("\n"), /\x1b\]|\u202e/); assert.equal(JSON.stringify(message), before);
    if (expanded && width === 100) assert.match(stripVTControlCharacters(rendered.join("\n")), /FULL_JOB_123456/);
  }
});
