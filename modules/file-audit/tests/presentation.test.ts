import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ActivityWindow } from "../src/activity-window.js";
import { resultText, statusText, MAX_OUTPUT_BYTES } from "../src/presentation.js";

test("display is capped, sanitized and distinguishes uninspected from passes", () => {
  const w = new ActivityWindow();
  for (let i = 0; i < 12; i++) w.record(join(process.cwd(), `file${i}\u001b[31m\u202e${"中".repeat(250)}`), "note");
  const text = statusText(w, 0, process.cwd());
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES); assert.match(text, /2 retained file details hidden/);
  assert.doesNotMatch(text, /\u001b|\u202e/);
  const result = resultText({ findings: w.snapshot().map(x => ({ path: x.path, status: "untracked" })), bytes: 0, metadataBytes: 0, elapsedMs: 1 }, process.cwd());
  assert.ok(Buffer.byteLength(result, "utf8") <= MAX_OUTPUT_BYTES); assert.match(result, /checked: 0/);
  assert.match(result, /NOT passes/); assert.match(result, /NOT full-project/); assert.match(result, /2 finding details hidden/);
});
