import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatIssues, isValidationFault } from "../src/validation-schema.mjs";

async function setup(schema: string) {
  const { default: extension } = await import("../extensions/json-schema.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-json-schema-msg-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Array<{ execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown> }> = [];
  extension({ registerFlag: () => {}, registerTool: (tool: never) => { tools.push(tool); }, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
    getFlag: (name: string) => name === "json-schema" ? schema : name === "json-output" ? "out.json" : undefined } as never);
  const ctx = { mode: "print", cwd: dir };
  hooks.get("session_start")!({}, ctx);
  hooks.get("input")!({}, ctx);
  return { tools, hooks, ctx, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("formatIssues reports how many issues were dropped beyond the first five", () => {
  const issues = Array.from({ length: 8 }, (_, i) => ({ path: ["f" + i], message: "bad" }));
  const text = formatIssues(issues);
  assert.match(text, /f4: bad/);
  assert.doesNotMatch(text, /f5/);
  assert.match(text, /3 more issue\(s\) not shown/);
  assert.doesNotMatch(formatIssues(issues.slice(0, 5)), /more issue/);
});

test("isValidationFault recognises infrastructure reasons only", () => {
  for (const reason of ["Validation cancelled", "Validation capacity exhausted; retry after active validation completes", "Validation exceeded 2000ms CPU-worker budget", "Validation worker failed: x", "Validation worker exited without a result", "Validation failed: boom"]) {
    assert.equal(isValidationFault(reason), true, reason);
  }
  assert.equal(isValidationFault("n: Invalid input: expected string, received number"), false);
});

test("schema mismatch names the fix; infrastructure faults are not blamed on the arguments", async () => {
  const { tools, hooks, ctx, cleanup } = await setup('{"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}');
  try {
    hooks.get("tool_execution_start")!({ toolCallId: "c1", toolName: "json_output", args: { n: "x" } }, ctx);
    await assert.rejects(tools[0].execute("c1", { n: "x" }), (error: Error) => {
      assert.match(error.message, /do not match the schema: n: /);
      assert.match(error.message, /call json_output again with corrected arguments/i);
      return true;
    });
    const aborted = AbortSignal.abort();
    hooks.get("tool_execution_start")!({ toolCallId: "c2", toolName: "json_output", args: { n: 1 } }, ctx);
    await assert.rejects(tools[0].execute("c2", { n: 1 }, aborted), (error: Error) => {
      assert.doesNotMatch(error.message, /do not match the schema/);
      assert.match(error.message, /validator fault/i);
      assert.match(error.message, /Validation cancelled/);
      assert.match(error.message, /same arguments/i);
      return true;
    });
  } finally { await cleanup(); }
});

test("a conflicting second result explains that the run has ended", async () => {
  const { tools, hooks, ctx, cleanup } = await setup('{"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}');
  try {
    for (const [id, n] of [["a", 1], ["b", 2]] as const) hooks.get("tool_execution_start")!({ toolCallId: id, toolName: "json_output", args: { n } }, ctx);
    await tools[0].execute("a", { n: 1 });
    const second = await tools[0].execute("b", { n: 2 }) as { content: Array<{ text: string }> };
    assert.match(second.content[0].text, /different result was already submitted/);
    assert.match(second.content[0].text, /first result is not replaced/i);
    assert.match(second.content[0].text, /nothing more can be sent/i);
  } finally { process.exitCode = 0; await cleanup(); }
});
