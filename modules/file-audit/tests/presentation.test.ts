import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ActivityWindow } from "../src/activity-window.js";
import { statusText, MAX_OUTPUT_BYTES } from "../src/presentation.js";

test("display is capped and sanitized", () => {
  const w = new ActivityWindow();
  for (let i = 0; i < 12; i++) w.record(join(process.cwd(), `file${i}\u001b[31m‮${"中".repeat(250)}`), "note");
  const text = statusText(w, 0, process.cwd());
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES); assert.match(text, /2 retained file details hidden/);
  assert.doesNotMatch(text, /\u001b|‮/);
});
