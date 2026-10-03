import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/delivery.ts";

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
