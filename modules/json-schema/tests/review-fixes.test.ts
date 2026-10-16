import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileSchema } from "../src/schema.ts";

const accepts = async (schemaText: string, data: unknown) => {
  try { return (await compileSchema(schemaText).validate(data)) === undefined; } catch { return false; }
};
/** Faithful: invalid data is rejected, or the schema itself is rejected at startup. */
const rejectsOrUnsupported = async (schemaText: string, data: unknown) => !(await accepts(schemaText, data));

test("G7-001: minItems/maxItems apply to arrays that declare no items", async () => {
  const min = JSON.stringify({ type: "object", properties: { xs: { type: "array", minItems: 1 } }, required: ["xs"] });
  assert.ok(await rejectsOrUnsupported(min, { xs: [] }));
  assert.ok(await accepts(min, { xs: [1] }));
  const max = JSON.stringify({ type: "object", properties: { xs: { type: "array", maxItems: 1 } }, required: ["xs"] });
  assert.ok(await rejectsOrUnsupported(max, { xs: [1, 2] }));
  assert.ok(await accepts(max, { xs: [1] }));
});

test("G7-002: required names that are not declared in properties are enforced", async () => {
  const schema = JSON.stringify({ type: "object", required: ["must"] });
  assert.ok(await rejectsOrUnsupported(schema, {}));
  assert.ok(await accepts(schema, { must: 1 }));
  const nested = JSON.stringify({ type: "object", properties: { o: { type: "object", required: ["k"] } } });
  assert.ok(await rejectsOrUnsupported(nested, { o: {} }));
  assert.ok(await accepts(nested, { o: { k: null } }));
});

test("G7-003: compound const is compared structurally (or rejected at startup)", async () => {
  const schema = JSON.stringify({ type: "object", properties: { x: { const: { a: 1 } } }, required: ["x"] });
  let compiled = true;
  try { compileSchema(schema); } catch { compiled = false; }
  if (compiled) assert.ok(await accepts(schema, JSON.parse('{"x":{"a":1}}')));
  if (compiled) assert.ok(await rejectsOrUnsupported(schema, { x: { a: 2 } }));
  const scalar = JSON.stringify({ type: "object", properties: { x: { const: 1 } }, required: ["x"] });
  assert.ok(await accepts(scalar, { x: 1 }));
});

test("G7-004: json_output validates and delivers the raw tool arguments, not host-coerced ones", async () => {
  const { default: extension } = await import("../extensions/json-schema.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-json-schema-raw-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Array<{ execute(id: string, params: unknown): Promise<unknown> }> = [];
  extension({ registerFlag: () => {}, registerTool: (tool: never) => { tools.push(tool); }, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
    getFlag: (name: string) => name === "json-schema" ? '{"type":"object","properties":{"n":{"type":"integer"},"s":{"type":"string"}},"required":["n"]}' : name === "json-output" ? "out.json" : undefined } as never);
  const ctx = { mode: "print", cwd: dir };
  try {
    hooks.get("session_start")!({}, ctx);
    hooks.get("input")!({}, ctx);
    // Host order: tool_execution_start carries the raw arguments, execute receives the coerced copy.
    hooks.get("tool_execution_start")!({ toolCallId: "c1", toolName: "json_output", args: { n: "7" } }, ctx);
    await assert.rejects(tools[0].execute("c1", { n: 7 }), /do not match the schema/);
    hooks.get("tool_execution_start")!({ toolCallId: "c2", toolName: "json_output", args: { n: 7, s: null } }, ctx);
    await assert.rejects(tools[0].execute("c2", { n: 7 }), /do not match the schema/);
    hooks.get("tool_execution_start")!({ toolCallId: "c3", toolName: "json_output", args: { n: 7 } }, ctx);
    await tools[0].execute("c3", { n: 7 });
    await hooks.get("session_shutdown")!({}, ctx);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "out.json"), "utf8")), { n: 7 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
