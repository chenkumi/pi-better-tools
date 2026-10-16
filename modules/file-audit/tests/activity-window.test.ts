import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityWindow, boundedString } from "../src/activity-window.js";

test("capacity is enforced at admission, and duplicate access updates recency", () => {
  const w = new ActivityWindow({ windowRuns: 4, maxFiles: 2 });
  w.record("A", "read"); w.record("B", "write"); w.record("A", "edit"); w.record("C", "note");
  assert.deepEqual(w.snapshot().map(x => x.path), ["C", "A"]);
  assert.equal(w.stats.capacityEvictions, 1);
  for (const path of ["D", "E", "F"]) { w.record(path, "read"); assert.equal(w.snapshot().length, 2); }
});
test("window expires fields as well as entries, preserving recent note creation", () => {
  const w = new ActivityWindow({ windowRuns: 2, maxFiles: 3 });
  w.record("A", "note"); w.advance(); w.record("A", "read");
  assert.equal(w.snapshot()[0].createdRun, 0);
  w.advance();
  assert.equal(w.snapshot()[0].createdRun, undefined);
  assert.equal(w.snapshot()[0].writeRun, undefined);
  w.advance(); assert.equal(w.snapshot().length, 0); assert.equal(w.stats.expired, 1);
});
test("limits are validated atomically and shrinking prunes immediately", () => {
  const w = new ActivityWindow(); w.record("A", "read"); w.record("B", "read");
  assert.throws(() => w.configure({ windowRuns: 0, maxFiles: 1 }));
  assert.equal(w.snapshot().length, 2); assert.equal(w.limits.windowRuns, 4);
  w.configure({ windowRuns: 1, maxFiles: 1 }); assert.deepEqual(w.snapshot().map(x => x.path), ["B"]);
  const copy = w.snapshot(); copy[0].path = "tampered"; assert.equal(w.snapshot()[0].path, "B");
  w.clear(true); assert.deepEqual(w.limits, { windowRuns: 4, maxFiles: 50 }); assert.equal(w.run, 0);
});
test("string admission is byte bounded and rejects malformed paths", () => {
  assert.equal(boundedString("中文", 5), false); assert.equal(boundedString("😀", 4), true);
  for (const value of ["", "a\0b", "\ud800", undefined, 1]) assert.equal(boundedString(value), false);
  const w = new ActivityWindow(); w.record("x".repeat(4097), "read");
  assert.equal(w.snapshot().length, 0); assert.equal(w.stats.skipped, 1);
});
