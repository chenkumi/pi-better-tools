import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, AgentBeforeSettleEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";
import { GoalController } from "../src/controller.ts";
import { newGoal, resumeGoal, parseCommand, latestSnapshot, validateSnapshot, validateArguments, STATE_TYPE, CONTROL_TYPE, type GoalState } from "../src/state.ts";
import { controlEntry, filterControls, launchPrompt } from "../src/prompts.ts";

const cwd = resolve("isolated-unit-workspace");
function harness(hasUI = true) {
  const entries: { type: string; customType: string; data: unknown }[] = [];
  let idle = true, pending = false, fault = false, aborted = 0, sessionId = "unit-session";
  const active = ["goal", "write"], prompts: unknown[] = [], notices: unknown[] = [], statuses: unknown[] = [];
  const manager = { getSessionId: () => sessionId, getBranch: () => entries };
  const ctx = { cwd, hasUI, mode: hasUI ? "tui" : "json", sessionManager: manager, isIdle: () => idle,
    hasPendingMessages: () => pending, abort: () => { aborted++; }, signal: undefined,
    ui: { setStatus: (...v: unknown[]) => statuses.push(v), notify: (...v: unknown[]) => notices.push(v),
      input: async () => undefined, confirm: async () => false } } as unknown as ExtensionCommandContext;
  const pi = { getActiveTools: () => active,
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); if (fault) throw new Error("injected disk failure after memory append"); },
    sendUserMessage: (...p: unknown[]) => prompts.push(p), sendMessage: (...p: unknown[]) => notices.push(p),
  } as unknown as ExtensionAPI;
  let controller = new GoalController(pi); controller.restore(ctx);
  const get = () => controller.execute({ action: "get" }, ctx);
  const start = async (objective = "驗收成果成立；不得縮小要求。") => {
    await controller.command(objective, ctx);
    const prompt = launchPrompt(get().goal!);
    controller.input({ type: "input", text: prompt, source: "extension" }, ctx);
    assert.ok(controller.beforeStart(prompt, ctx)); idle = false;
    controller.agentStarted(ctx);
    controller.messageStarted({ role: "custom", ...controlEntry(get().goal!), timestamp: 1 } as AgentMessage, ctx);
    return get().goal!;
  };
  const outcome = (goal = get().goal!) => ({ action: "complete" as const, goalId: goal.id, runId: goal.runId, summary: "驗收結果成立", verification: [{ criterion: "結果成立", evidence: "實際離線查核成功" }] });
  const boundary = (extra = {}) => ({ type: "agent_before_settle", entries: [], continue: false, outcome: "completed",
    context: { pendingMessages: [], contextEntries: [], contextMessages: [], llmMessages: [], canContinue: false }, ...extra }) as AgentBeforeSettleEvent;
  return { ctx, pi, entries, active, prompts, notices, statuses, get, start, outcome, boundary,
    get controller() { return controller; }, reload: () => { const old = controller; controller = new GoalController(pi); controller.restore(ctx); return old; },
    setIdle: (v: boolean) => { idle = v; }, setPending: (v: boolean) => { pending = v; }, setFault: () => { fault = true; },
    switchIdentity: () => { sessionId = "different-session"; }, aborts: () => aborted };
}
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as AgentMessage;
const call = (name = "write") => ({ type: "tool_call", toolName: name, toolCallId: "call", input: {} }) as ToolCallEvent;

test("objective preserved exactly; no planning state/step fields; escape reserved operations", () => {
  const objective = "  條件一\n條件二 😀  "; const goal = newGoal(objective, cwd);
  assert.equal(goal.objective, objective); assert.equal(goal.status, "active");
  assert.deepEqual(parseCommand("-- pause"), { action: "start", objective: "pause" });
  assert.deepEqual(parseCommand("status"), { action: "status" });
  assert.deepEqual(parseCommand(objective), { action: "start", objective });
  for (const name of ["plan", "tasks", "currentStepId", "progress", "noCheckpointRounds"]) assert.ok(!(name in goal));
  for (const invalid of [" ", "x".repeat(4001), "\uD800"]) assert.throws(() => newGoal(invalid, cwd), /INVALID_STATE/);
});
test("latest snapshot is authoritative including tombstone and malformed version", () => {
  const first = { type: "custom", customType: STATE_TYPE, data: { version: 1, goal: newGoal("success", cwd) } };
  assert.equal(latestSnapshot([first])?.objective, "success");
  assert.equal(latestSnapshot([first, { ...first, data: { version: 1, goal: null } }]), null);
  assert.throws(() => latestSnapshot([first, { ...first, data: { version: 99, goal: null } }]), /INVALID_STATE/);
  assert.throws(() => validateSnapshot({ version: 1, goal: { ...first.data.goal, status: "complete" } }), /Missing outcome/);
});
test("outcomes reject empty/extra fields, malformed evidence, plan steps and oversized snapshot", () => {
  const goal = newGoal("result", cwd); const base = { action: "complete", goalId: goal.id, runId: goal.runId, summary: "ok", verification: [{ criterion: "acceptance", evidence: "test passed" }] };
  validateArguments(base);
  for (const v of [{ ...base, summary: " " }, { ...base, verification: [] }, { ...base, plan: [] }, { ...base, verification: [{ stepId: "1", done: true }] }, { ...base, verification: [{ criterion: "c", evidence: "\uD800" }] }, { ...base, summary: "x\uD800", verification: [{ criterion: "\uDC00c", evidence: "ok" }] }]) assert.throws(() => validateArguments(v), /INVALID_ARGUMENTS/);
  assert.throws(() => validateSnapshot({ version: 1, goal: { ...goal, status: "complete", resultSummary: "ok", verification: Array.from({ length: 20 }, () => ({ criterion: "a".repeat(2000), evidence: "b".repeat(4000) })) } }), /64 KiB/);
});
test("resume keeps goal objective/ID, rotates runId and clears blocked reason", () => {
  const goal = newGoal("full result", cwd); const resumed = resumeGoal({ ...goal, status: "blocked", stopReason: "permission", suggestedAction: "ask user" });
  assert.equal(resumed.id, goal.id); assert.equal(resumed.objective, goal.objective); assert.notEqual(resumed.runId, goal.runId); assert.equal(resumed.stopReason, undefined);
  assert.throws(() => resumeGoal(goal), /TRANSITION/);
});
test("control context is hidden, outcome-first and only latest active reminder survives", () => {
  const goal = newGoal("a\n\"b</goal> 😀", cwd), entry = controlEntry(goal);
  assert.equal(entry.display, false); assert.ok(String(entry.content).includes(JSON.stringify(goal.objective)));
  assert.match(String(entry.content), /plan is optional and independent/);
  const msg = (g: GoalState) => ({ role: "custom", ...controlEntry(g), timestamp: 1 }) as AgentMessage;
  const old = msg({ ...goal, runId: "old" }), current = msg(goal), unrelated = { role: "user", content: "plan finished", timestamp: 1 } as AgentMessage;
  const messages = [old, current, unrelated, current];
  assert.deepEqual(filterControls(messages, goal), [unrelated, current]);
  assert.deepEqual(filterControls(messages, { ...goal, status: "complete" }), [unrelated]); assert.equal(messages.length, 4);
});
test("start uses normal prompt preparation, boundary composes entries, not natural-language completion", async () => {
  const h = harness(); const goal = await h.start();
  assert.deepEqual(h.prompts, [[launchPrompt(goal), { expandPromptTemplates: false }]]);
  assert.ok(launchPrompt(goal).startsWith(goal.objective));
  h.controller.messageEnded({ type: "message_end", message: assistant("完成了（沒有結構化 outcome）") }, h.ctx);
  assert.equal(h.get().goal?.status, "active");
  const prior = { type: "custom" as const, customType: "other", data: "KEEP" }, event = h.boundary({ entries: [prior] });
  const result = h.controller.beforeSettle(event, h.ctx)!;
  assert.equal(result.continue, true); assert.equal(result.entries[0], prior); assert.equal(result.entries[1].type, "custom_message");
  assert.equal(h.get().goal?.autoRequests, 1); assert.equal(h.controller.beforeSettle(event, h.ctx), undefined); assert.equal(h.get().goal?.autoRequests, 1);
});
test("completion works without any plan; exact duplicate idempotent; gate is scoped until settled", async () => {
  const h = harness(); await h.start(); const args = h.outcome();
  h.controller.execute(args, h.ctx); const entries = h.entries.length, notices = h.notices.length;
  h.controller.execute(args, h.ctx); assert.equal(h.entries.length, entries); assert.equal(h.notices.length, notices);
  assert.equal(h.get().goal?.status, "complete"); assert.equal(h.controller.beforeSettle(h.boundary(), h.ctx), undefined);
  assert.equal(h.controller.toolCall(call(), h.ctx)?.block, true); assert.equal(h.controller.toolCall(call("goal"), h.ctx), undefined);
  h.controller.settled(h.ctx); assert.equal(h.controller.toolCall(call(), h.ctx), undefined);
  assert.throws(() => h.controller.execute(args, h.ctx), /STALE_RUN/);
});
test("rejects complete while independent/nested working tools are in flight", async () => {
  const h = harness(); await h.start();
  h.controller.toolStarted({ type: "tool_execution_start", toolCallId: "work", toolName: "write", args: {} }, h.ctx);
  assert.throws(() => h.controller.execute(h.outcome(), h.ctx), /WORK_IN_FLIGHT/);
  h.controller.toolEnded({ type: "tool_execution_end", toolCallId: "work", toolName: "write", result: {}, isError: false }, h.ctx);
  h.controller.execute(h.outcome(), h.ctx); assert.equal(h.get().goal?.status, "complete");
});
test("blocked stops, preserves concrete action, and stale run results cannot overwrite resume", async () => {
  const h = harness(); const old = await h.start(); const done = h.outcome();
  h.controller.execute({ action: "blocked", goalId: old.id, runId: old.runId, reason: "need credential", suggestedAction: "ask user" }, h.ctx);
  assert.equal(h.get().goal?.status, "blocked"); h.controller.settled(h.ctx); h.setIdle(true);
  await h.controller.command("resume", h.ctx); assert.equal(h.get().goal?.objective, old.objective); assert.notEqual(h.get().goal?.runId, old.runId);
  assert.throws(() => h.controller.execute(done, h.ctx), /STALE_RUN/);
});
test("pause fences first and aborts; clear tombstone does not roll back project or revive old outcome", async () => {
  const h = harness(); await h.start(); const old = h.outcome(); await h.controller.command("pause", h.ctx);
  assert.equal(h.get().goal?.status, "paused"); assert.equal(h.aborts(), 1); assert.throws(() => h.controller.execute(old, h.ctx), /NOT_ACTIVE/);
  await h.controller.command("clear", h.ctx); assert.equal(h.get().goal, null); assert.equal(latestSnapshot(h.entries), null);
  assert.equal(h.controller.toolCall(call(), h.ctx)?.block, true); h.reload(); assert.equal(h.get().goal, null);
});
test("restore/fault/old runtime identity are fail-closed", async () => {
  const h = harness(); await h.start(); const args = h.outcome(), old = h.reload(); assert.equal(h.get().goal?.status, "paused");
  assert.throws(() => old.execute(args, h.ctx), /STALE_SESSION/);
  h.switchIdentity(); assert.throws(() => h.controller.execute(args, h.ctx), /STALE_SESSION/);
});
test("disk failure after tentative append never commits or resurrects on reload", async () => {
  const h = harness(); await h.start(); h.setFault(); assert.throws(() => h.controller.execute(h.outcome(), h.ctx), /STORAGE_FAULT/);
  assert.equal(h.get().goal, null); assert.match(h.get().diagnostic!, /STORAGE_FAULT/);
  assert.equal(latestSnapshot(h.entries)?.status, "complete", "fault injection matches Pi's tentative manager append");
  await h.controller.command("pause", h.ctx); assert.equal(h.aborts(), 1, "storage fault must not prevent cancellation");
  h.reload(); assert.equal(h.get().goal, null); await assert.rejects(h.controller.command("resume", h.ctx), /STORAGE_FAULT/);
  await assert.rejects(h.controller.command("clear", h.ctx), /STORAGE_FAULT/);
});
test("unknown latest snapshot does not revive old goal; explicit clear repairs metadata", async () => {
  const h = harness(); h.entries.push({ type: "custom", customType: STATE_TYPE, data: { version: 99 } }); h.reload();
  assert.match(h.get().diagnostic!, /INVALID_STATE/); await assert.rejects(h.controller.command("result", h.ctx), /INVALID_STATE/);
  await h.controller.command("clear", h.ctx); assert.equal(h.get().diagnostic, null);
});
test("disabled tools, busy and pending message states do not enable/launch goal", async () => {
  const h = harness(); h.active.splice(0, 1); await assert.rejects(h.controller.command("result", h.ctx), /TOOL_DISABLED/); assert.equal(h.entries.length, 0);
  h.active.push("goal"); h.setPending(true); await assert.rejects(h.controller.command("result", h.ctx), /BUSY/);
  h.setPending(false); h.setIdle(false); await assert.rejects(h.controller.command("result", h.ctx), /BUSY/); assert.equal(h.prompts.length, 0);
});
test("another boundary continuation/pending work has priority; tool exclusion pauses not enables", async () => {
  const h = harness(); await h.start();
  assert.equal(h.controller.beforeSettle(h.boundary({ continue: true }), h.ctx), undefined);
  h.setPending(true); assert.equal(h.controller.beforeSettle(h.boundary(), h.ctx), undefined); h.setPending(false);
  assert.equal(h.get().goal?.autoRequests, 0); h.active.splice(0, 1);
  assert.equal(h.controller.beforeSettle(h.boundary(), h.ctx), undefined); assert.equal(h.get().goal?.status, "paused");
});
test("20 own continuation proposals stop without checkpoint gates; three empty automatic responses stop", async () => {
  const h = harness(); await h.start();
  for (let i = 0; i < 20; i++) { h.controller.messageEnded({ type: "message_end", message: assistant("useful investigation, no checkpoint tool") }, h.ctx); assert.equal(h.controller.beforeSettle(h.boundary(), h.ctx)?.continue, true); }
  assert.equal(h.controller.beforeSettle(h.boundary(), h.ctx), undefined); assert.equal(h.get().goal?.status, "paused"); assert.equal(h.get().goal?.autoRequests, 20);
  const empty = harness(); await empty.start(); assert.equal(empty.controller.beforeSettle(empty.boundary(), empty.ctx)?.continue, true);
  for (let i = 0; i < 2; i++) assert.equal(empty.controller.beforeSettle(empty.boundary(), empty.ctx)?.continue, true);
  assert.equal(empty.controller.beforeSettle(empty.boundary(), empty.ctx), undefined); assert.equal(empty.get().goal?.emptyResponses, 3);
});
test("error/abort and downstream-veto settlement pause; shutdown performs no writes", async () => {
  for (const outcome of ["error", "aborted"] as const) { const h = harness(); await h.start(); assert.equal(h.controller.beforeSettle(h.boundary({ outcome }), h.ctx), undefined); assert.equal(h.get().goal?.status, "paused"); }
  const h = harness(); await h.start(); h.controller.settled(h.ctx); assert.equal(h.get().goal?.status, "paused");
  const entries = h.entries.length; h.controller.shutdown(h.ctx); assert.equal(h.entries.length, entries);
});
test("replacement requires confirmation; cancelled/stale dialogs do not change goal", async () => {
  const h = harness(); await h.start(); h.controller.settled(h.ctx); h.setIdle(true);
  const goalId = h.get().goal!.id; await h.controller.command("replacement", h.ctx); assert.equal(h.get().goal?.id, goalId);
  let accept!: (value: boolean) => void; h.ctx.ui.confirm = () => new Promise<boolean>(r => { accept = r; });
  const command = h.controller.command("replacement", h.ctx); await h.controller.command("clear", h.ctx); accept(true);
  await assert.rejects(command, /STALE_DIALOG/); assert.equal(h.get().goal, null);
  const headless = harness(false); await headless.start(); headless.controller.settled(headless.ctx); headless.setIdle(true);
  await assert.rejects(headless.controller.command("replacement", headless.ctx), /REPLACE_CONFIRMATION/);
});
test("input handled elsewhere cannot let unrelated user prompt inherit pending launch", async () => {
  const h = harness(); await h.controller.command("result", h.ctx);
  h.controller.input({ type: "input", text: "unrelated user prompt", source: "interactive" }, h.ctx);
  assert.equal(h.get().goal?.status, "paused"); assert.equal(h.controller.beforeStart("unrelated user prompt", h.ctx), undefined);
});
test("preflight pause/clear before control creation leaves a cancellation fence", async () => {
  for (const action of ["pause", "clear"]) {
    const h = harness(); await h.controller.command("result", h.ctx); const prompt = launchPrompt(h.get().goal!);
    h.controller.input({ type: "input", text: prompt, source: "extension" }, h.ctx);
    await h.controller.command(action, h.ctx);
    const fence = h.controller.beforeStart(prompt, h.ctx)!;
    h.controller.messageStarted({ role: "custom", ...fence.message, timestamp: 1 } as AgentMessage, h.ctx);
    assert.equal(h.aborts(), 2); assert.equal(h.controller.beforeSettle(h.boundary(), h.ctx), undefined);
  }
});
test("downstream handled input in preparing phase cannot adopt an unrelated prompt", async () => {
  const h = harness(); await h.controller.command("result", h.ctx);
  h.controller.input({ type: "input", text: launchPrompt(h.get().goal!), source: "extension" }, h.ctx);
  h.controller.input({ type: "input", text: "unrelated", source: "interactive" }, h.ctx);
  assert.equal(h.get().goal?.status, "paused"); assert.equal(h.controller.beforeStart("unrelated", h.ctx), undefined);
});
test("preflight custom control emitted after pause is cancelled before working tools", async () => {
  const h = harness(); const goal = await h.start(); await h.controller.command("pause", h.ctx);
  h.controller.messageStarted({ role: "custom", ...controlEntry(goal), timestamp: 1 } as AgentMessage, h.ctx); assert.equal(h.aborts(), 2);
});
test("late cancelled launch cannot promote, pause or settle a newer ready run", async () => {
  const h = harness(); await h.controller.command("original", h.ctx); const oldPrompt = launchPrompt(h.get().goal!);
  h.controller.input({ type: "input", text: oldPrompt, source: "extension" }, h.ctx);
  await h.controller.command("pause", h.ctx); await h.controller.command("resume", h.ctx);
  const current = h.get().goal!, prompt = launchPrompt(current);
  h.controller.input({ type: "input", text: prompt, source: "extension" }, h.ctx);
  const admitted = h.controller.beforeStart(prompt, h.ctx)!;
  const cancelled = h.controller.beforeStart(oldPrompt, h.ctx)!;
  assert.equal(h.get().goal?.status, "active");
  h.controller.agentStarted(h.ctx);
  h.controller.messageStarted({ role: "custom", ...cancelled.message, timestamp: 1 } as AgentMessage, h.ctx);
  h.controller.settled(h.ctx);
  assert.throws(() => h.controller.execute(h.outcome(), h.ctx), /STALE_RUN/);
  assert.equal(h.get().goal?.runId, current.runId); assert.equal(h.get().goal?.status, "active");
  h.controller.messageStarted({ role: "custom", ...admitted.message, timestamp: 1 } as AgentMessage, h.ctx);
  h.controller.execute(h.outcome(), h.ctx); assert.equal(h.get().goal?.status, "complete");
});
test("child markers register only context filter (no tool/command/automatic hooks)", () => {
  for (const key of ["PI_SUBAGENTS_GUARD", "PI_SCHEDULER_CHILD"]) {
    const previous = process.env[key]; process.env[key] = "";
    try { const hooks: string[] = []; extension({ on: (event: string) => { hooks.push(event); }, registerTool: () => { throw new Error("child registered tool"); }, registerCommand: () => { throw new Error("child registered command"); } } as unknown as ExtensionAPI); assert.deepEqual(hooks, ["context"]); }
    finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
});
