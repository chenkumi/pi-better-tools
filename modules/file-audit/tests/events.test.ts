import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditTracker } from "../src/events.js";

test("only paired successful completions record, note deduplicates with later read", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "file-audit-events-"));
  try {
    await writeFile(join(cwd, "note.md"), "note");
    const t = new AuditTracker(); t.reset("owner");
    t.start("failed", "read", { path: "note.md" }, cwd, "owner"); t.finish("failed", "read", {}, true, "owner");
    t.finish("unknown", "read", {}, false, "owner"); assert.equal(t.window.snapshot().length, 0);
    t.start("note", "note", { type: "plan", content: "secret not stored" }, cwd, "owner");
    t.finish("note", "note", { details: { relativePath: "note.md" } }, false, "owner");
    t.start("parent/1", "read", { path: "note.md" }, cwd, "owner"); t.finish("parent/1", "read", {}, false, "owner");
    assert.equal(t.window.snapshot().length, 1); assert.equal(t.window.snapshot()[0].createdRun, 0);
    assert.equal(JSON.stringify(t).includes("secret not stored"), false);
    t.start("old", "edit", { path: "note.md" }, cwd, "owner"); t.advance(); t.finish("old", "edit", {}, false, "owner");
    assert.equal(t.window.snapshot()[0].action, "read");
    t.start("late", "write", { path: "note.md" }, cwd, "owner"); t.reset("replacement");
    t.finish("late", "write", {}, false, "owner"); assert.equal(t.window.snapshot().length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("pending admissions are bounded, cleared at settlement, and invalid notes skipped", () => {
  const t = new AuditTracker(); t.reset("owner");
  for (let i = 0; i < 129; i++) t.start(String(i), "note", {}, process.cwd(), "owner");
  assert.equal(t.pendingCount, 128); assert.equal(t.window.stats.skipped, 1);
  t.settled(); assert.equal(t.pendingCount, 0);
  t.start("bad", "note", {}, process.cwd(), "owner"); t.finish("bad", "note", { details: {} }, false, "owner");
  assert.equal(t.window.stats.skipped, 2); assert.equal(t.window.snapshot().length, 0);
  t.reset("owner", true, false); t.start("shutdown", "note", {}, process.cwd(), "owner"); assert.equal(t.pendingCount, 0);
});
