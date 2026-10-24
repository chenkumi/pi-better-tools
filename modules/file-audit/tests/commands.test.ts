import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AuditTracker } from "../src/events.js";
import { AuditCommands, parseCommand } from "../src/commands.js";
import type { ScanResult } from "../src/provenance.js";
const empty = (): ScanResult => ({ findings: [], bytes: 0, metadataBytes: 0, elapsedMs: 0 });
function context() {
  const notifications: string[] = [];
  const ctx = { mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => "session" },
    ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}
test("commands parse atomically, status does not inspect and limits prune immediately", async () => {
  const t = new AuditTracker(); t.reset("session"); t.window.record("a", "note"); t.window.record("b", "read");
  let calls = 0; const commands = new AuditCommands(t, async () => { calls++; return empty(); });
  const { ctx, notifications } = context();
  await commands.handle("status", ctx); assert.equal(calls, 0); assert.match(notifications.at(-1)!, /Candidates: 2/);
  await commands.handle("limits --max-files 1 --window 0", ctx); assert.equal(t.window.snapshot().length, 2);
  await commands.handle("limits --max-files 1", ctx); assert.equal(t.window.snapshot().length, 1);
  await commands.handle("check", { ...ctx, mode: "json" }); assert.equal(calls, 0);
  await commands.handle("check", ctx); assert.equal(calls, 1); assert.match(notifications.at(-1)!, /No candidates/);
  for (const value of ["check extra", "limits --window 2 --window 3", "limits --bad 1", "limits --window Infinity", "limits"]) {
    assert.throws(() => parseCommand(value, t.window.limits));
  }
});
test("one active check, fixed candidate snapshot and clear suppresses stale completion", async () => {
  const t = new AuditTracker(); t.reset("session"); t.window.record("a", "read");
  let finish!: (value: ScanResult) => void, count = 0, observedSignal: AbortSignal | undefined;
  const commands = new AuditCommands(t, async (_cwd, files, options) => {
    count++; assert.equal(files.length, 1); observedSignal = options?.signal;
    return new Promise<ScanResult>(resolve => { finish = resolve; });
  });
  const { ctx, notifications } = context();
  const pending = commands.handle("check", ctx);
  t.window.record("b", "note"); await commands.handle("check", ctx);
  assert.equal(count, 1); assert.match(notifications.at(-1)!, /busy/);
  await commands.handle("clear", ctx); assert.equal(observedSignal?.aborted, true);
  const before = notifications.length; finish(empty()); await pending;
  assert.equal(notifications.length, before); assert.equal(t.window.snapshot().length, 0);
});
test("usage errors name the offending token, rule and fix", () => {
  const limits = new AuditTracker().window.limits;
  const message = (value: string) => { try { parseCommand(value, limits); } catch (error) { return (error as Error).message; } assert.fail(`no error for ${value}`); };
  assert.match(message("chek"), /Unknown action "chek".*status, check, clear, limits/);
  assert.match(message("check extra"), /"check" takes no arguments; got "extra"/);
  assert.match(message("limits"), /limits requires at least one of --window <1–30> or --max-files <1–500>/);
  assert.match(message("limits --window"), /--window needs a value/);
  assert.match(message("limits --window 2 --window 3"), /--window was given twice/);
  assert.match(message("limits --bad 1"), /Unknown flag "--bad".*--window or --max-files/);
  assert.match(message("limits --window abc"), /--window value "abc" is not a non-negative integer/);
  assert.match(message("limits --window 99"), /window must be an integer 1–30 \(received 99\)/);
  assert.match(message("limits --max-files 0"), /max-files must be an integer 1–500 \(received 0\)/);
  assert.match(message("x".repeat(1100)), /exceed 1024 characters \(received 1100\)/);
  assert.match(message("chek"), /Usage: \/file-audit \[status/);
});
test("a failing inspection reports a sanitized failure code, not a bare failure", async () => {
  const t = new AuditTracker(); t.reset("session");
  const { ctx, notifications } = context();
  await new AuditCommands(t, async () => { throw Object.assign(new Error("secret C:/Users/x/file"), { code: "EMFILE" }); }).handle("check", ctx);
  assert.match(notifications.at(-1)!, /inspection failed \(EMFILE\); no verification claimed/);
  assert.doesNotMatch(notifications.at(-1)!, /secret/);
  await new AuditCommands(t, async () => { throw new Error("Secret value"); }).handle("check", ctx);
  assert.match(notifications.at(-1)!, /inspection failed \(inspection-failed\)/);
});
