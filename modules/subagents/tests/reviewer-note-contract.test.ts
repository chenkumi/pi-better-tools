import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const definition = readFileSync(new URL("../agents/reviewer.md", import.meta.url), "utf8");

test("bundled reviewer selects note without general file mutation tools", () => {
  const tools = /^tools:\s*(.+)$/m.exec(definition)?.[1].split(",").map(value => value.trim());
  assert.deepEqual(tools, ["read", "grep", "find", "ls", "bash", "note"]);
  assert.ok(!tools.includes("write") && !tools.includes("edit"));
});

test("reviewer reports only through native note with explicit failure handling", () => {
  assert.match(definition, /note\(\{ type: "report", content \}\)/);
  assert.match(definition, /only permitted report-writing mechanism/);
  assert.match(definition, /Do not use bash, write, edit/);
  assert.match(definition, /Never invent a saved path/);
  assert.doesNotMatch(definition, /\.pi\/notes\/review-/);
  assert.match(definition, /Do not specify a filename or folder/);
  assert.match(definition, /After note succeeds, return only the one-sentence verdict and the exact returned relative path/);
  assert.match(definition, /keep the reply under 150 words/);
  assert.match(definition, /If note is unavailable or fails, report that delivery is blocked and the actual reason/);
  assert.match(definition, /do not use another writing mechanism/);
  assert.equal((definition.match(/note\(\{ type: /g) ?? []).length, 1);
});
