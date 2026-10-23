import assert from "node:assert/strict";
import fsPromises, { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import noteExtension, { MAX_NOTE_BYTES, noteTool } from "../extensions/note.ts";

const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
const firstName = "PLAN-20260102T030405006Z.md";
const types = ["plan", "design", "issue", "research", "report", "task"] as const;
const dirOf = { plan: "plans", design: "designs", issue: "issues", research: "research", report: "reports", task: "tasks" } as const;
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

test("call renderer updates streaming UTF-8 counts without changing arguments or preview", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const render = noteTool.renderCall!;
  const context: Parameters<typeof render>[2] = {
    args: undefined, toolCallId: "test-note", invalidate: () => {}, lastComponent: undefined, state: {},
    cwd: process.cwd(), executionStarted: false, argsComplete: false, expanded: false, isPartial: true,
    showImages: false, isError: false, durationMs: undefined, outputPad: 0,
  };
  const colors = theme as Parameters<typeof render>[1];
  const args = Object.freeze({ type: "plan" as const, content: "# 中文😀\nPRIVATE_BODY" });
  const component = render(args, colors, context);
  const text = () => component.render(400).join("\n");
  assert.match(text(), /note plan · 中文😀/);
  assert.match(text(), /^receiving 25 bytes\s*$/m);
  assert.doesNotMatch(text(), /PRIVATE_BODY/);
  assert.equal(render({ type: "plan", content: "a".repeat(2257) + "中文測" }, colors,
    { ...context, argsComplete: true, lastComponent: component }), component);
  assert.match(text(), /^received 2,266 bytes\s*$/m);
  assert.doesNotMatch(text(), /receiving|written|Saved/);
  assert.deepEqual(args, { type: "plan", content: "# 中文😀\nPRIVATE_BODY" });
  for (const partial of [undefined, null, {}, { content: "" }, { content: null }, { content: 42 }]) {
    render(partial as unknown as Parameters<typeof render>[0], colors, { ...context, lastComponent: component });
    assert.match(text(), /^receiving 0 bytes\s*$/m);
  }
  for (const width of [12, 40]) assert.ok(component.render(width).length > 0);
});

test("schema accepts exactly type/content and the six categories", () => {
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
    const file = join(cwd, saved.relativePath);
    assert.equal(file, resolve(cwd, dirOf[type], `${type.toUpperCase()}-20260102T030405006Z.md`));
    assert.equal(saved.relativePath, `${dirOf[type]}/${type.toUpperCase()}-20260102T030405006Z.md`);
    assert.deepEqual(saved, { relativePath: `${dirOf[type]}/${type.toUpperCase()}-20260102T030405006Z.md` }, "details expose only the relative path");
    assert.deepEqual(Object.keys((noteTool.outputSchema as unknown as { properties: object }).properties), ["relativePath"]);
    assert.equal(Check(noteTool.outputSchema!, { ...saved, type }), false, "output rejects extra metadata");
    assert.equal(Object.hasOwn((noteTool.outputSchema as unknown as { properties: object }).properties, "path"), false);
    assert.equal(JSON.stringify(result).includes(cwd), false, "result never exposes the absolute workspace path");
    assert.deepEqual(result.structuredContent, saved);
    assert.equal(Check(noteTool.outputSchema!, result.structuredContent), true);
    const text = result.content[0];
    assert.equal(text.type, "text");
    if (text.type !== "text") throw new Error("Expected text output");
    assert.match(text.text, /Saved note:/);
    assert.ok(text.text.includes(saved.relativePath));
    assert.equal(await readFile(file, "utf8"), content);
    assert.deepEqual(await readdir(cwd), [dirOf[type]]);
    assert.deepEqual(await readdir(join(cwd, dirOf[type])), [basename(file)]);
    assert.doesNotMatch(basename(file), /[:<>"/\\|?*]/);
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
  await mkdir(join(cwd, "plans"));
  await writeFile(join(cwd, "plans", firstName), "KEEP");
  await writeFile(join(cwd, "plans", "PLAN-20260102T030405006Z-new.md"), "KEEP SLUG");
  await writeFile(join(cwd, "plans", "PLAN.md"), "KEEP BASELINE");
  const result = await execute(cwd, { type: "plan", content: "NEW" });
  assert.equal(basename(join(cwd, result.details.relativePath)), "PLAN-20260102T030405007Z.md");
  assert.equal(await readFile(join(cwd, "plans", firstName), "utf8"), "KEEP");
  assert.equal(await readFile(join(cwd, "plans", "PLAN-20260102T030405006Z-new.md"), "utf8"), "KEEP SLUG");
  assert.equal(await readFile(join(cwd, "plans", "PLAN.md"), "utf8"), "KEEP BASELINE");
  assert.equal(await readFile(join(cwd, result.details.relativePath), "utf8"), "NEW");
});

test("compact timestamps keep UTC milliseconds, lexical ordering and rollover collision semantics", async t => {
  const cwd = await workspace(t);
  const rollover = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
  t.mock.method(Date, "now", () => rollover);
  await mkdir(join(cwd, "reports"));
  const oldName = "REPORT-2026-12-31T23-59-59-999Z.md";
  await writeFile(join(cwd, "reports", oldName), "OLD FORMAT KEEP");
  const a = await execute(cwd, { type: "report", content: "first" });
  const b = await execute(cwd, { type: "report", content: "first" });
  assert.equal(basename(join(cwd, a.details.relativePath)), "REPORT-20261231T235959999Z.md");
  assert.equal(basename(join(cwd, b.details.relativePath)), "REPORT-20270101T000000000Z.md");
  assert.ok(basename(join(cwd, a.details.relativePath)) < basename(join(cwd, b.details.relativePath)));
  assert.match(basename(join(cwd, a.details.relativePath)), /^REPORT-\d{8}T\d{9}Z\.md$/);
  assert.equal(await readFile(join(cwd, "reports", oldName), "utf8"), "OLD FORMAT KEEP");
});

test("parallel calls with identical timestamp each create a unique complete file", async t => {
  const cwd = await workspace(t);
  t.mock.method(Date, "now", () => timestamp);
  const contents = Array.from({ length: 32 }, (_, i) => `note ${i}\n${"文".repeat(100)}`);
  const results = await Promise.all(contents.map(content => execute(cwd, { type: "plan", content })));
  assert.equal(new Set(results.map(r => r.details.relativePath)).size, contents.length);
  assert.equal((await readdir(join(cwd, "plans"))).length, contents.length);
  for (const [i, result] of results.entries()) assert.equal(await readFile(join(cwd, result.details.relativePath), "utf8"), contents[i]);
});

test("1000 compact timestamp collisions fail without overwriting or creating a 1001st file", async t => {
  const cwd = await workspace(t);
  t.mock.method(Date, "now", () => timestamp);
  const dir = join(cwd, "plans");
  await mkdir(dir);
  for (let i = 0; i < 1000; i++) {
    const name = `PLAN-${new Date(timestamp + i).toISOString().replace(/[-:.]/g, "")}.md`;
    await writeFile(join(dir, name), "KEEP");
  }
  await assert.rejects(execute(cwd, { type: "plan", content: "# x\nMUST NOT WRITE" }), /NOTE_FILENAME_COLLISION/);
  assert.equal((await readdir(dir)).length, 1000);
  for (const name of await readdir(dir)) assert.equal(await readFile(join(dir, name), "utf8"), "KEEP");
});

test("generated file names never include a title or content suffix", async t => {
  const cwd = await workspace(t);
  const cases = ["# 中文 Title!\nbody", "!!! ???", "# CON\nx", "# \u{20000}x", "```sh\n# hidden\n```\n# Title", "../../unsafe/path"];
  for (const [i, content] of cases.entries()) {
    t.mock.method(Date, "now", () => timestamp + i * 10);
    const result = await execute(cwd, { type: "plan", content });
    assert.equal(basename(join(cwd, result.details.relativePath)), `PLAN-20260102T030405${String(6 + i * 10).padStart(3, "0")}Z.md`);
    assert.equal(await readFile(join(cwd, result.details.relativePath), "utf8"), content);
  }
});

test("uses invocation cwd, not process cwd or extension installation directory", async t => {
  const root = await workspace(t);
  const a = join(root, "a"), b = join(root, "b");
  await mkdir(a); await mkdir(b);
  t.mock.method(Date, "now", () => timestamp);
  const first = await execute(a, { type: "plan", content: "A" });
  const second = await execute(b, { type: "plan", content: "B" });
  assert.equal(join(a, first.details.relativePath), join(a, "plans", "PLAN-20260102T030405006Z.md"));
  assert.equal(join(b, second.details.relativePath), join(b, "plans", "PLAN-20260102T030405006Z.md"));
  assert.equal(await readFile(join(a, first.details.relativePath), "utf8"), "A");
  assert.equal(await readFile(join(b, second.details.relativePath), "utf8"), "B");
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

/** Swap one node:fs/promises function for this test; the extension's named imports follow via syncBuiltinESMExports. */
function replaceFs<K extends "open" | "realpath">(t: TestContext, name: K, replacement: (typeof fsPromises)[K]) {
  const original = fsPromises[name];
  (fsPromises as Record<K, unknown>)[name] = replacement;
  syncBuiltinESMExports();
  t.after(() => { (fsPromises as Record<K, unknown>)[name] = original; syncBuiltinESMExports(); });
  return original;
}

test("a filesystem error that merely starts with NOTE_DIRECTORY_ESCAPE still removes the partial file", async t => {
  const cwd = await workspace(t);
  const realOpen = fsPromises.open;
  replaceFs(t, "open", (async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await realOpen(...args);
    return new Proxy(handle, {
      get(target, key) {
        if (key === "writeFile") return async () => { throw new Error("NOTE_DIRECTORY_ESCAPE lookalike raised by the filesystem"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof fsPromises.open);
  await assert.rejects(execute(cwd, { type: "plan", content: "# x" }), /lookalike/);
  assert.deepEqual(await readdir(join(cwd, "plans")), []);
});

test("a created file whose location cannot be re-verified is removed and reported as a directory escape", async t => {
  const cwd = await workspace(t);
  const realRealpath = fsPromises.realpath;
  replaceFs(t, "realpath", (async (path: Parameters<typeof fsPromises.realpath>[0], ...rest: unknown[]) => {
    if (String(path).endsWith(".md")) throw Object.assign(new Error("ENOENT: raced away"), { code: "ENOENT" });
    return (realRealpath as (...args: unknown[]) => Promise<string>)(path, ...rest);
  }) as typeof fsPromises.realpath);
  await assert.rejects(execute(cwd, { type: "plan", content: "# x" }), /NOTE_DIRECTORY_ESCAPE/);
  assert.deepEqual(await readdir(join(cwd, "plans")), []);
});

test("filesystem failure is reported, not a success path", async t => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "plans"), "existing regular file");
  await assert.rejects(execute(cwd, { type: "plan", content: "x" }));
  assert.equal(await readFile(join(cwd, "plans"), "utf8"), "existing regular file");
  assert.deepEqual(await readdir(cwd), ["plans"]);
});

test("directory symlink/junction escaping the workspace is refused", async t => {
  const cwd = await workspace(t), outside = await workspace(t);
  const { symlink } = await import("node:fs/promises");
  try { await symlink(outside, join(cwd, "plans"), "junction"); } catch { t.skip("cannot create symlink/junction here"); return; }
  await assert.rejects(execute(cwd, { type: "plan", content: "x" }), /NOTE_DIRECTORY_ESCAPE/);
  assert.deepEqual(await readdir(outside), []);
});

test("D18: a junction to an in-workspace directory whose name starts with '..' is accepted", async t => {
  const cwd = await workspace(t);
  const { symlink } = await import("node:fs/promises");
  const archive = join(cwd, "..archive");
  await mkdir(archive);
  try { await symlink(archive, join(cwd, "plans"), process.platform === "win32" ? "junction" : "dir"); } catch { t.skip("cannot create symlink/junction here"); return; }
  const result = await execute(cwd, { type: "plan", content: "# Plan\n" });
  assert.match(result.details.relativePath, /^plans\/PLAN-/);
  const files = await readdir(archive);
  assert.equal(files.length, 1);
  assert.equal(await readFile(join(archive, files[0]), "utf8"), "# Plan\n");
});

test("content over the size cap is rejected before any directory is created", async t => {
  const cwd = await workspace(t);
  await assert.rejects(execute(cwd, { type: "plan", content: "x".repeat(MAX_NOTE_BYTES + 1) }), /NOTE_TOO_LARGE/);
  assert.deepEqual(await readdir(cwd), []);
});

