import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameWithRetry, writeJsonFile } from "../src/delivery.ts";

test("L33: rename retries transient Windows locks with bounded backoff", async () => {
  const delays: number[] = [];
  const codes = ["EPERM", "EBUSY", "EACCES"];
  let attempts = 0;
  await renameWithRetry("temp", "target", {
    rename: async (from, to) => {
      assert.equal(from, "temp"); assert.equal(to, "target");
      if (attempts++ < codes.length) throw Object.assign(new Error("locked"), { code: codes[attempts - 1] });
    },
    sleep: async ms => { delays.push(ms); },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [20, 40, 60]);
});

test("L33: rename exhaustion and non-transient errors preserve the original error", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES", "ENOENT", "EXDEV", undefined]) {
    const error = Object.assign(new Error("injected failure"), { code });
    let attempts = 0;
    const delays: number[] = [];
    await assert.rejects(renameWithRetry("temp", "target", {
      rename: async () => { attempts++; throw error; },
      sleep: async ms => { delays.push(ms); },
    }), actual => actual === error);
    const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
    assert.equal(attempts, transient ? 9 : 1);
    assert.deepEqual(delays, transient ? [20, 40, 60, 80, 120, 200, 300, 500] : []);
  }
});

test("writes 2-space JSON with a trailing newline and replaces an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "json-delivery-"));
  try {
    const target = join(dir, "out", "result.json");
    await writeJsonFile(target, { a: 1, b: ["x"] });
    assert.equal(await readFile(target, "utf8"), '{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
    await writeJsonFile(target, { a: 2 });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { a: 2 });
    assert.deepEqual((await readdir(join(dir, "out"))).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed write keeps the previous file and leaves no temporary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "json-delivery-"));
  try {
    const target = join(dir, "result.json");
    await writeFile(target, "OLD\n");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(writeJsonFile(target, circular));
    assert.equal(await readFile(target, "utf8"), "OLD\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repeated session_start keeps one signal listener and registers the tool once", async () => {
  const { default: extension } = await import("../extensions/json-schema.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-json-schema-listeners-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>(); const tools: Array<{ execute(id: string, params: unknown): Promise<unknown> }> = [];
  extension({ registerFlag: () => {}, registerTool: (tool: never) => { tools.push(tool); }, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
    getFlag: (name: string) => name === "json-schema" ? '{"type":"object"}' : name === "json-output" ? "out.json" : undefined } as never);
  const before = process.listenerCount("SIGTERM");
  const ctx = { mode: "print", cwd: dir };
  try {
    hooks.get("session_start")!({}, ctx); hooks.get("session_start")!({}, ctx);
    assert.equal(process.listenerCount("SIGTERM"), before + 1);
    assert.equal(tools.length, 1);
    await tools[0].execute("id", {});
    await hooks.get("session_shutdown")!({}, ctx);
    assert.equal(process.listenerCount("SIGTERM"), before);
    assert.equal(await readFile(join(dir, "out.json"), "utf8"), "{}\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recover validates every candidate and the extraction transcript keeps the final assistant text", async () => {
  const { default: extension } = await import("../extensions/json-schema.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-json-schema-recover-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension({ registerFlag: () => {}, registerTool: () => {}, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
    getActiveTools: () => ["json_output"],
    getFlag: (name: string) => name === "json-schema" ? '{"type":"object","required":["a"],"properties":{"a":{"type":"number"}}}' : name === "json-output" ? "out.json" : undefined } as never);
  const ctx = { mode: "print", cwd: dir };
  try {
    hooks.get("session_start")!({}, ctx);
    hooks.get("input")!({}, ctx);
    const assistant = { role: "assistant", content: [{ type: "text", text: 'Empty {} then {"a":1}' }], stopReason: "stop" };
    const replaced = hooks.get("message_end")!({ message: assistant }, ctx) as { message: { content: unknown[] } };
    assert.deepEqual(replaced.message.content, []);
    hooks.get("agent_end")!({ messages: [{ role: "user", content: "hi", timestamp: 1 }, replaced.message] }, ctx);
    await hooks.get("session_shutdown")!({}, ctx);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "out.json"), "utf8")), { a: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("when no candidate validates the extraction request sees the final assistant text", async () => {
  const { default: extension } = await import("../extensions/json-schema.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-json-schema-transcript-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension({ registerFlag: () => {}, registerTool: () => {}, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
    getActiveTools: () => ["json_output"],
    getFlag: (name: string) => name === "json-schema" ? '{"type":"object","required":["a"],"properties":{"a":{"type":"number"}}}' : name === "json-output" ? "out.json" : undefined } as never);
  let seen = "";
  const ctx = { mode: "print", cwd: dir, model: { id: "m" }, modelRegistry: { find: () => undefined, complete: async (_model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }) => {
    seen = request.messages[0].content[0].text;
    return { stopReason: "stop", content: [{ type: "toolCall", name: "json_output", arguments: { a: 2 } }] };
  } } };
  const savedExit = process.exitCode;
  try {
    hooks.get("session_start")!({}, ctx);
    hooks.get("input")!({}, ctx);
    const replaced = hooks.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "the answer is forty-two" }], stopReason: "stop" } }, ctx) as { message: unknown };
    hooks.get("agent_end")!({ messages: [replaced.message] }, ctx);
    await hooks.get("session_shutdown")!({}, ctx);
    assert.match(seen, /the answer is forty-two/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "out.json"), "utf8")), { a: 2 });
  } finally { process.exitCode = savedExit; await rm(dir, { recursive: true, force: true }); }
});
