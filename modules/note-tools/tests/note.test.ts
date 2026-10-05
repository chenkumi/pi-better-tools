import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import noteExtension, { MAX_NOTE_BYTES, deriveSlug, noteTool } from "../extensions/note.ts";

const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
const firstName = "PLAN-20260102T030405006Z.md";
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
  for (const type of types) assert.equal(Check(noteTool.parameters, { type, content: "" }), true); // schema stays permissive; execute rejects blank content
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
    assert.equal(saved.path, resolve(cwd, type, `${type.toUpperCase()}-20260102T030405006Z-測試.md`));
    assert.equal(saved.relativePath, `${type}/${basename(saved.path)}`);
    assert.equal(saved.type, type);
    assert.deepEqual(result.structuredContent, saved);
    assert.equal(Check(noteTool.outputSchema!, result.structuredContent), true);
    const text = result.content[0];
    assert.equal(text.type, "text");
    if (text.type !== "text") throw new Error("Expected text output");
    assert.match(text.text, /Saved note:/);
    assert.ok(text.text.includes(saved.relativePath));
    assert.ok(!text.text.includes(saved.path), "absolute path is not repeated in text");
    assert.equal(await readFile(saved.path, "utf8"), content);
    assert.deepEqual(await readdir(cwd), [type]);
    assert.deepEqual(await readdir(join(cwd, type)), [basename(saved.path)]);
    assert.doesNotMatch(basename(saved.path), /[:<>"/\\|?*]/);
  });
}

test("empty or whitespace-only content is rejected with NOTE_EMPTY and creates nothing", async t => {
  const cwd = await workspace(t);
  for (const content of ["", "  \n\t "]) {
    await assert.rejects(execute(cwd, { type: "task", content }), /NOTE_EMPTY.*call note again/);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("result text tells the model the path is relative to cwd and to use read/edit", async t => {
  const cwd = await workspace(t);
  const result = await execute(cwd, { type: "task", content: "# t" });
  const text = result.content[0];
  if (text.type !== "text") throw new Error("Expected text output");
  assert.match(text.text, /relative to cwd; use read\/edit/);
});

test("collision never overwrites an existing file or touches PLAN.md", async t => {
  const cwd = await workspace(t);
  t.mock.method(Date, "now", () => timestamp);
  await mkdir(join(cwd, "plan"));
  await writeFile(join(cwd, "plan", firstName), "KEEP");
  await writeFile(join(cwd, "plan", "PLAN-20260102T030405006Z-new.md"), "KEEP SLUG");
  await writeFile(join(cwd, "plan", "PLAN.md"), "KEEP BASELINE");
  const result = await execute(cwd, { type: "plan", content: "NEW" });
  assert.equal(basename(result.details.path), "PLAN-20260102T030405007Z-new.md");
  assert.equal(await readFile(join(cwd, "plan", firstName), "utf8"), "KEEP");
  assert.equal(await readFile(join(cwd, "plan", "PLAN-20260102T030405006Z-new.md"), "utf8"), "KEEP SLUG");
  assert.equal(await readFile(join(cwd, "plan", "PLAN.md"), "utf8"), "KEEP BASELINE");
  assert.equal(await readFile(result.details.path, "utf8"), "NEW");
});

test("compact timestamps keep UTC milliseconds, lexical ordering and rollover collision semantics", async t => {
  const cwd = await workspace(t);
  const rollover = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
  t.mock.method(Date, "now", () => rollover);
  await mkdir(join(cwd, "report"));
  const oldName = "REPORT-2026-12-31T23-59-59-999Z.md";
  await writeFile(join(cwd, "report", oldName), "OLD FORMAT KEEP");
  const a = await execute(cwd, { type: "report", content: "first" });
  const b = await execute(cwd, { type: "report", content: "first" });
  assert.equal(basename(a.details.path), "REPORT-20261231T235959999Z-first.md");
  assert.equal(basename(b.details.path), "REPORT-20270101T000000000Z-first.md");
  assert.ok(basename(a.details.path) < basename(b.details.path));
  assert.match(basename(a.details.path), /^REPORT-\d{8}T\d{9}Z-first\.md$/);
  assert.equal(await readFile(join(cwd, "report", oldName), "utf8"), "OLD FORMAT KEEP");
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

test("1000 compact timestamp collisions fail without overwriting or creating a 1001st file", async t => {
  const cwd = await workspace(t);
  t.mock.method(Date, "now", () => timestamp);
  const dir = join(cwd, "plan");
  await mkdir(dir);
  for (let i = 0; i < 1000; i++) {
    const name = `PLAN-${new Date(timestamp + i).toISOString().replace(/[-:.]/g, "")}-x.md`;
    await writeFile(join(dir, name), "KEEP");
  }
  await assert.rejects(execute(cwd, { type: "plan", content: "# x\nMUST NOT WRITE" }), /NOTE_FILENAME_COLLISION/);
  assert.equal((await readdir(dir)).length, 1000);
  for (const name of await readdir(dir)) assert.equal(await readFile(join(dir, name), "utf8"), "KEEP");
});

test("slug derivation: heading, first line, CJK, punctuation, length, reserved names, surrogates", () => {
  assert.equal(deriveSlug("# 部署計畫：第 2 版\n內文"), "部署計畫-第-2-版");
  assert.equal(deriveSlug("intro line\n\n## Hello, World!!  "), "hello-world"); // heading wins over earlier lines
  assert.equal(deriveSlug("\n\n  Plain First Line\nsecond"), "plain-first-line");
  assert.equal(deriveSlug("# ...\n## Real Title"), "real-title");
  assert.equal(deriveSlug("# ---***---\n!!!"), "");
  assert.equal(deriveSlug("# 😀😀\n"), "");
  for (const reserved of ["CON", "nul", "Com1", "LPT9", "aux", "PRN"]) assert.equal(deriveSlug(`# ${reserved}`), "", reserved);
  assert.equal(deriveSlug("# console"), "console");
  assert.equal(deriveSlug("# ../../etc/passwd"), "etc-passwd");
  assert.equal(deriveSlug('# a\\b/c:d*e?f"g<h>i|j. '), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(Array.from(deriveSlug(`# ${"長".repeat(100)}`)).length, 40);
  const words = deriveSlug(`# ${"word ".repeat(30)}`);
  assert.ok(Array.from(words).length <= 40);
  assert.doesNotMatch(words, /^-|-$/);
  const astral = deriveSlug(`# ${"\u{20000}".repeat(60)}`); // supplementary-plane CJK
  assert.equal(astral, "\u{20000}".repeat(40));
  assert.doesNotMatch(astral, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("generated file names carry the slug, fall back to timestamp only, and stay safe", async t => {
  const cwd = await workspace(t);
  const cases: [string, string][] = [
    ["# 中文 Title!\nbody", "-中文-title"],
    ["!!! ???", ""],
    ["# CON\nx", ""],
    ["# \u{20000}x", "-\u{20000}x"],
  ];
  for (const [i, [content, suffix]] of cases.entries()) {
    t.mock.method(Date, "now", () => timestamp + i * 10);
    const result = await execute(cwd, { type: "plan", content });
    assert.equal(basename(result.details.path), `PLAN-20260102T030405${String(6 + i * 10).padStart(3, "0")}Z${suffix}.md`);
    assert.equal(await readFile(result.details.path, "utf8"), content);
  }
});

test("uses invocation cwd, not process cwd or extension installation directory", async t => {
  const root = await workspace(t);
  const a = join(root, "a"), b = join(root, "b");
  await mkdir(a); await mkdir(b);
  t.mock.method(Date, "now", () => timestamp);
  const first = await execute(a, { type: "plan", content: "A" });
  const second = await execute(b, { type: "plan", content: "B" });
  assert.equal(first.details.path, join(a, "plan", "PLAN-20260102T030405006Z-a.md"));
  assert.equal(second.details.path, join(b, "plan", "PLAN-20260102T030405006Z-b.md"));
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

test("directory symlink/junction escaping the workspace is refused", async t => {
  const cwd = await workspace(t), outside = await workspace(t);
  const { symlink } = await import("node:fs/promises");
  try { await symlink(outside, join(cwd, "plan"), "junction"); } catch { t.skip("cannot create symlink/junction here"); return; }
  await assert.rejects(execute(cwd, { type: "plan", content: "x" }), /NOTE_DIRECTORY_ESCAPE/);
  assert.deepEqual(await readdir(outside), []);
});

test("content over the size cap is rejected before any directory is created", async t => {
  const cwd = await workspace(t);
  await assert.rejects(execute(cwd, { type: "plan", content: "x".repeat(MAX_NOTE_BYTES + 1) }), /NOTE_TOO_LARGE/);
  assert.deepEqual(await readdir(cwd), []);
});
