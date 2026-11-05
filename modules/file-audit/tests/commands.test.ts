import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AuditTracker } from "../src/events.js";
import { AuditCommands, parseCommand } from "../src/commands.js";
function context() {
  const notifications: string[] = [];
  const ctx = { mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => "session" },
    ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}
test("commands parse atomically and limits prune immediately", async () => {
  const t = new AuditTracker(); t.reset("session"); t.window.record("a", "note"); t.window.record("b", "read");
  const commands = new AuditCommands(t);
  const { ctx, notifications } = context();
  await commands.handle("status", ctx); assert.match(notifications.at(-1)!, /Candidates: 2/);
  await commands.handle("limits --max-files 1 --window 0", ctx); assert.equal(t.window.snapshot().length, 2);
  await commands.handle("limits --max-files 1", ctx); assert.equal(t.window.snapshot().length, 1);
  await commands.handle("status", { ...ctx, mode: "json" }); assert.equal(notifications.length, 3, "outside the TUI nothing is shown");
  for (const value of ["status extra", "limits --window 2 --window 3", "limits --bad 1", "limits --window Infinity", "limits"]) {
    assert.throws(() => parseCommand(value, t.window.limits));
  }
});
test("clear drops the observed candidates", async () => {
  const t = new AuditTracker(); t.reset("session"); t.window.record("a", "read");
  const { ctx, notifications } = context();
  await new AuditCommands(t).handle("clear", ctx);
  assert.equal(t.window.snapshot().length, 0); assert.match(notifications.at(-1)!, /Candidates: 0/);
});
test("check is no longer an action", async () => {
  const t = new AuditTracker(); t.reset("session");
  const { ctx, notifications } = context();
  await new AuditCommands(t).handle("check", ctx);
  assert.match(notifications.at(-1)!, /Unknown action "check".*status, clear, limits/);
});
test("usage errors name the offending token, rule and fix", () => {
  const limits = new AuditTracker().window.limits;
  const message = (value: string) => { try { parseCommand(value, limits); } catch (error) { return (error as Error).message; } assert.fail(`no error for ${value}`); };
  assert.match(message("chek"), /Unknown action "chek".*status, clear, limits/);
  assert.match(message("status extra"), /"status" takes no arguments; got "extra"/);
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
