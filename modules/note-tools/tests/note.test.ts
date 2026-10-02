import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import noteExtension, { noteTool } from "../extensions/note.ts";

const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
const firstName = "PLAN-2026-01-02T03-04-05-006Z.md";
const types = ["plan", "issue", "research", "report", "task"] as const;
const execute = (cwd: string, args: Static<typeof noteTool.parameters>, signal?: AbortSignal) =>
  noteTool.execute("test-note", args, signal, undefined, { cwd } as ExtensionToolContext);
async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-note-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return cwd;
}

test("extension registers only note without I/O or lifecycle hooks", () => {
  const tools: unknown[] = [];
  noteExtension({ registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as unknown as ExtensionAPI);
  assert.deepEqual(tools, [noteTool]);
});

test("schema accepts exactly type/content and the five categories", () => {
  for (const type of types) assert.equal(Check(noteTool.parameters, { type, content: "" }), true);
  for (const args of [
    { type: "../outside", content: "x" }, { type: "PLAN", content: "x" },
    { type: "plan", content: 12 }, { content: "x" }, { type: "plan" },
    { type: "plan", content: "x", path: "custom.md" },
    { type: "plan", content: "x", target: "issue" },
  ]) assert.equal(Check(noteTool.parameters, args), false, JSON.stringify(args));
});

for (const type of types) {
  test(`${type}: creates missing directory, Windows-safe name and verbatim UTF-8 content`, async t => {
    const cwd = await workspace(t);
    t.mock.method(Date, "now", () => timestamp);
    const content = "# 測試 😀\r\n\nno trailing newline";
    const result = await execute(cwd, { type, content });
    const saved = result.details;
    assert.equal(saved.path, resolve(cwd, type, `${type.toUpperCase()}-2026-01-02T03-04-05-006Z.md`));
    assert.equal(saved.relativePath, `${type}/${basename(saved.path)}`);
    assert.equal(saved.type, type);
    assert.deepEqual(result.structuredContent, saved);
    assert.equal(Check(noteTool.outputSchema!, result.structuredContent), true);
    const text = result.content[0];
    assert.equal(text.type, "text");
    if (text.type !== "text") throw new Error("Expected text output");
    assert.match(text.text, /Saved note:/);
    assert.ok(text.text.includes(saved.path));
    assert.equal(await readFile(saved.path, "utf8"), content);
    assert.deepEqual(await readdir(cwd), [type]);
    assert.deepEqual(await readdir(join(cwd, type)), [basename(saved.path)]);
    assert.doesNotMatch(basename(saved.path), /[:<>"/\\|?*]/);
  });
}

test("empty string creates an empty new file", async t => {
  const cwd = await workspace(t);
  const result = await execute(cwd, { type: "task", content: "" });
  assert.equal((await stat(result.details.path)).size, 0);
});

test("collision never overwrites an existing file or touches PLAN.md", async t => {
  const cwd = await workspace(t);
  t.mock.method(Date, "now", () => timestamp);
  await mkdir(join(cwd, "plan"));
  await writeFile(join(cwd, "plan", firstName), "KEEP");
  await writeFile(join(cwd, "plan", "PLAN.md"), "KEEP BASELINE");
  const result = await execute(cwd, { type: "plan", content: "NEW" });
  assert.equal(basename(result.details.path), "PLAN-2026-01-02T03-04-05-007Z.md");
  assert.equal(await readFile(join(cwd, "plan", firstName), "utf8"), "KEEP");
  assert.equal(await readFile(join(cwd, "plan", "PLAN.md"), "utf8"), "KEEP BASELINE");
  assert.equal(await readFile(result.details.path, "utf8"), "NEW");
});

test("parallel calls with identical timestamp each create a unique complete file", async t => {
  const cwd = await workspace(t);
  t.mock.method(Date, "now", () => timestamp);
  const contents = Array.from({ length: 32 }, (_, i) => `note ${i}\n${"文".repeat(100)}`);
  const results = await Promise.all(contents.map(content => execute(cwd, { type: "plan", content })));
  assert.equal(new Set(results.map(r => r.details.path)).size, contents.length);
  assert.equal((await readdir(join(cwd, "plan"))).length, contents.length);
  for (const [i, result] of results.entries()) assert.equal(await readFile(result.details.path, "utf8"), contents[i]);
});

test("uses invocation cwd, not process cwd or extension installation directory", async t => {
  const root = await workspace(t);
  const a = join(root, "a"), b = join(root, "b");
  await mkdir(a); await mkdir(b);
  t.mock.method(Date, "now", () => timestamp);
  const first = await execute(a, { type: "plan", content: "A" });
  const second = await execute(b, { type: "plan", content: "B" });
  assert.equal(first.details.path, join(a, "plan", firstName));
  assert.equal(second.details.path, join(b, "plan", firstName));
  assert.equal(await readFile(first.details.path, "utf8"), "A");
  assert.equal(await readFile(second.details.path, "utf8"), "B");
});

test("invalid direct calls fail before creating any directories", async t => {
  const cwd = await workspace(t);
  for (const args of [{ type: "../outside", content: "x" }, { type: "plan", content: 42 }]) {
    await assert.rejects(execute(cwd, args as Parameters<typeof execute>[1]), /NOTE_INVALID_ARGUMENTS/);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("lone surrogates are rejected before I/O instead of silently replacing content", async t => {
  const cwd = await workspace(t);
  for (const content of ["\ud800", "\udfff", "valid prefix\ud800 invalid suffix"]) {
    await assert.rejects(execute(cwd, { type: "plan", content }), /NOTE_INVALID_ARGUMENTS/);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("pre-aborted calls do not create a directory or file", async t => {
  const cwd = await workspace(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(execute(cwd, { type: "plan", content: "x" }, controller.signal), { name: "AbortError" });
  assert.deepEqual(await readdir(cwd), []);
});

test("filesystem failure is reported, not a success path", async t => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "plan"), "existing regular file");
  await assert.rejects(execute(cwd, { type: "plan", content: "x" }));
  assert.equal(await readFile(join(cwd, "plan"), "utf8"), "existing regular file");
  assert.deepEqual(await readdir(cwd), ["plan"]);
});
