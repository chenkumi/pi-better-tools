// Behaviour added to `edit` after the port: hints on a miss, candidate context, regex lineRange fallback, insert, dryRun, the
// ^/$ notice, the head-and-tail diff and the null/whitelist handling of the new fields.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatEditSuccessFeedback, prepareEditArguments } from "../extensions/file-tools.ts";
import { FileToolError } from "../src/errors.ts";
import { changedLineRange, compactPatch, editTextFile, usesLineAnchors } from "../src/file-operations.ts";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "pi-edit-improvements-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const lit = (oldText: string, newText: string, extra: Record<string, unknown> = {}) => ({ oldText, newText, replaceAll: false, replacementMode: "literal" as const, ...extra });
const rx = (regex: string, newText: string, extra: Record<string, unknown> = {}) => ({ regex, newText, replaceAll: false, replacementMode: "literal" as const, ...extra });

async function fileWith(text: string): Promise<string> {
  const path = join(directory, "f.txt");
  await writeFile(path, text);
  return path;
}

async function failure(action: () => Promise<unknown>, code: string): Promise<FileToolError["payload"]> {
  try { await action(); } catch (error) {
    assert.ok(error instanceof FileToolError, String(error));
    assert.equal(error.payload.code, code);
    return error.payload;
  }
  return assert.fail(`Expected ${code}`);
}

describe("hints on a failed match", () => {
  it("names the closest line when a literal differs only in whitespace", async () => {
    const path = await fileWith("function a() {\n\treturn   compute(x, y);\n}\n");
    const payload = await failure(() => editTextFile(path, "f.txt", [lit("return compute(x, y);", "return 1;")]), "TEXT_NOT_FOUND");
    assert.deepEqual(payload.closestLine, { line: 2, text: "\treturn   compute(x, y);" });
  });

  it("finds the file line when the literal carries a line-number prefix copied from read", async () => {
    const path = await fileWith("alpha\nconst value = 42;\nomega\n");
    const payload = await failure(() => editTextFile(path, "f.txt", [lit("2│const value = 42;", "x")]), "TEXT_NOT_FOUND");
    assert.equal(payload.closestLine?.line, 2);
  });

  it("gives no hint when nothing is close, and none for a regex", async () => {
    const path = await fileWith("one\ntwo\nthree\n");
    const none = await failure(() => editTextFile(path, "f.txt", [lit("completely unrelated sentence here", "x")]), "TEXT_NOT_FOUND");
    assert.equal(none.closestLine, undefined);
    const regex = await failure(() => editTextFile(path, "f.txt", [rx("^zzz$", "x")]), "TEXT_NOT_FOUND");
    assert.equal(regex.closestLine, undefined);
  });

  it("shows each ambiguous candidate with a line of context on both sides", async () => {
    const path = await fileWith("a\nb\ntarget\nc\nd\ntarget\ne\n");
    const payload = await failure(() => editTextFile(path, "f.txt", [lit("target", "x")]), "AMBIGUOUS_MATCH");
    assert.deepEqual(payload.candidateRanges, [{ start: 3, end: 3 }, { start: 6, end: 6 }]);
    assert.deepEqual(payload.candidateContext, [
      { start: 3, end: 3, preview: "2│b\n3│target\n4│c" },
      { start: 6, end: 6, preview: "5│d\n6│target\n7│e" },
    ]);
  });
});

describe("lineRange fallback", () => {
  it("applies a unique match outside the range for oldText and for regex, and reports it", async () => {
    const path = await fileWith("one\ntwo\nthree\nfour\n");
    const literal = await editTextFile(path, "f.txt", [lit("four", "4", { lineRange: { start: 1, end: 2 } })]);
    assert.deepEqual(literal.fallbackEdits, [0]);
    const regex = await editTextFile(path, "f.txt", [rx("^three$", "3", { regexFlags: "m", lineRange: { start: 1, end: 2 } })]);
    assert.deepEqual(regex.fallbackEdits, [0]);
    assert.equal(await readFile(path, "utf8"), "one\ntwo\n3\n4\n");
  });

  it("does not fall back when the match is not unique in the file, and says nothing when the range matched", async () => {
    const path = await fileWith("x\ny\nx\nx\n");
    const miss = await failure(() => editTextFile(path, "f.txt", [rx("^x$", "z", { regexFlags: "m", lineRange: { start: 2, end: 2 } })]), "TEXT_NOT_FOUND_IN_RANGE");
    assert.deepEqual(miss.candidateRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 4, end: 4 }]);
    assert.equal(await readFile(path, "utf8"), "x\ny\nx\nx\n");
    const inRange = await editTextFile(await fileWith("a\nb\n"), "f.txt", [lit("b", "c", { lineRange: { start: 2, end: 2 } })]);
    assert.equal(inRange.fallbackEdits, undefined);
  });
});

describe("insert", () => {
  it("puts newText before or after the match, for text and for regex", async () => {
    const path = await fileWith("head\nbody\ntail\n");
    await editTextFile(path, "f.txt", [lit("body", "before\n", { insert: "before" }), rx("^tail$", "\nafter", { regexFlags: "m", insert: "after" })]);
    assert.equal(await readFile(path, "utf8"), "head\nbefore\nbody\ntail\nafter\n");
  });

  it("inserts at every match with replaceAll and expands capture templates", async () => {
    const path = await fileWith("a1\na2\n");
    await editTextFile(path, "f.txt", [rx("a(\\d)", "<$1>", { replaceAll: true, replacementMode: "template", insert: "after" })]);
    assert.equal(await readFile(path, "utf8"), "a1<1>\na2<2>\n");
  });

  it("allows an insertion at the boundary of another edit and refuses one inside it or at the same place", async () => {
    const path = await fileWith("abcdef");
    await editTextFile(path, "f.txt", [lit("cd", "XX"), lit("ab", "-", { insert: "after" })]);
    assert.equal(await readFile(path, "utf8"), "ab-XXef");
    const again = await fileWith("abcdef");
    await failure(() => editTextFile(again, "f.txt", [lit("abcd", "X"), lit("bc", "-", { insert: "after" })]), "OVERLAPPING_EDITS");
    await failure(() => editTextFile(again, "f.txt", [lit("cd", "-", { insert: "before" }), lit("ab", "+", { insert: "after" })]), "OVERLAPPING_EDITS");
  });

  it("refuses an empty newText and an unknown insert value", async () => {
    const path = await fileWith("abc");
    await failure(() => editTextFile(path, "f.txt", [lit("b", "", { insert: "after" })]), "INVALID_ARGUMENT");
    await failure(() => editTextFile(path, "f.txt", [lit("b", "x", { insert: "around" as never })]), "INVALID_ARGUMENT");
    assert.throws(() => prepareEditArguments({ path: "f", edits: [{ oldText: "b", newText: "x", insert: "around" }] }), FileToolError);
    assert.throws(() => prepareEditArguments({ path: "f", edits: [{ oldText: "b", newText: "", insert: "after" }] }), FileToolError);
  });
});

describe("dryRun", () => {
  it("returns the diff and the would-be token but leaves the file alone", async () => {
    const path = await fileWith("one\ntwo\n");
    const result = await editTextFile(path, "f.txt", [lit("two", "2")], undefined, undefined, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.match(result.patch, /\+2/);
    assert.equal(await readFile(path, "utf8"), "one\ntwo\n");
    const real = await editTextFile(path, "f.txt", [lit("two", "2")]);
    assert.equal(real.sha256After, result.sha256After);
  });

  it("is reported as a preview without a version token in the text", async () => {
    const path = await fileWith("one\ntwo\n");
    const result = await editTextFile(path, "f.txt", [lit("two", "2")], undefined, undefined, { dryRun: true });
    const text = formatEditSuccessFeedback(result).content;
    assert.match(text, /^\[FILE_EDIT_PREVIEW\] \{"edits":1,"added":1,"removed":1,"lines":"2","applied":false\}\n\[DIFF\]/);
    assert.doesNotMatch(text, /sha256After/);
  });

  it("still fails on a bad edit and on a stale token", async () => {
    const path = await fileWith("one\n");
    await failure(() => editTextFile(path, "f.txt", [lit("missing", "x")], undefined, undefined, { dryRun: true }), "TEXT_NOT_FOUND");
    await failure(() => editTextFile(path, "f.txt", [lit("one", "1")], "0".repeat(16), undefined, { dryRun: true }), "STALE_FILE");
  });
});

describe("^ and $ without the m flag", () => {
  it("recognises anchors outside escapes and character classes only", () => {
    assert.equal(usesLineAnchors("^foo"), true);
    assert.equal(usesLineAnchors("foo$"), true);
    assert.equal(usesLineAnchors("a\\$b"), false);
    assert.equal(usesLineAnchors("a\\^b"), false);
    assert.equal(usesLineAnchors("[$]x"), false);
    assert.equal(usesLineAnchors("[^abc]x"), false);
    assert.equal(usesLineAnchors("[a\\]$]x"), false);
    assert.equal(usesLineAnchors("(a|^)b"), true);
  });

  it("adds a notice when a successful regex edit used anchors without m, and not with m or without anchors", async () => {
    const path = await fileWith("foo\nbar\nfoo\n");
    const without = await editTextFile(path, "f.txt", [rx("^foo", "FOO")]);
    assert.match(without.notices?.[0] ?? "", /edits\[0\] uses \^ or \$ without regexFlags "m"/);
    assert.match(formatEditSuccessFeedback(without).content, /\n\[NOTICE\] edits\[0\] uses/);
    const withM = await editTextFile(path, "f.txt", [rx("^bar$", "BAR", { regexFlags: "m" })]);
    assert.equal(withM.notices, undefined);
    const plain = await editTextFile(path, "f.txt", [rx("BAR", "bar")]);
    assert.equal(plain.notices, undefined);
  });
});

describe("compact diff keeps the head and the tail", () => {
  it("returns a short patch whole and summarises the middle of a long one", () => {
    const short = compactPatch("--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n");
    assert.equal(short.omittedLines, 0);
    const lines = Array.from({ length: 100 }, (_, index) => `+line ${index}`).join("\n");
    const long = compactPatch(`--- a\n+++ a\n@@ -0,0 +1,100 @@\n${lines}\n`);
    const out = long.text.split("\n");
    assert.equal(out[0], "@@ -0,0 +1,100 @@");
    assert.equal(out[25], "+line 24");
    assert.equal(out[26], `… ${long.omittedLines} diff line(s) omitted …`);
    assert.equal(out.at(-1), "+line 99");
    assert.equal(out.length, 26 + 1 + 12);
    assert.equal(long.added, 100);
  });
});

describe("argument preparation of the new fields", () => {
  it("accepts dryRun and insert, normalises null, and rejects wrong types", () => {
    const prepared = prepareEditArguments({ path: "f", dryRun: true, edits: [{ oldText: "a", newText: "b", insert: "after" }] });
    assert.equal((prepared as { dryRun?: boolean }).dryRun, true);
    assert.equal(prepared.edits[0].insert, "after");
    const nulls = prepareEditArguments({ path: "f", dryRun: null, edits: [{ oldText: "a", newText: "b", insert: null }] });
    assert.equal((nulls as { dryRun?: boolean }).dryRun, undefined);
    assert.equal(nulls.edits[0].insert, undefined);
    assert.throws(() => prepareEditArguments({ path: "f", dryRun: "yes", edits: [{ oldText: "a", newText: "b" }] }), FileToolError);
  });
});

describe("changed line range", () => {
  it("names the lines of the edited file the patch touches, so a shortened diff can be read back", () => {
    assert.equal(changedLineRange("--- a\n+++ a\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"), "2");
    assert.equal(changedLineRange("--- a\n+++ a\n@@ -2,2 +2,3 @@\n x\n+y\n+z\n w\n@@ -40,2 +41,2 @@\n p\n-q\n+Q\n"), "3-42");
    // A deletion counts as the line that now follows it; a patch with no change names nothing.
    assert.equal(changedLineRange("--- a\n+++ a\n@@ -5,3 +5,2 @@\n a\n-b\n c\n"), "6");
    assert.equal(changedLineRange("--- a\n+++ a\n"), undefined);
    // Deleting the last lines: the next line does not exist, so the range ends at the file's new last line.
    assert.equal(changedLineRange("--- a\n+++ a\n@@ -8,3 +8,1 @@\n a\n-b\n-c\n"), "8");
    assert.equal(changedLineRange("--- a\n+++ a\n@@ -1,2 +1,0 @@\n-a\n-b\n"), undefined);
  });

  it("is in the success text of an edit that spans the file", async () => {
    const path = await fileWith(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
    const result = await editTextFile(path, "f.txt", [lit("line 3\n", "three\n"), lit("line 44\n", "forty-four\n")]);
    assert.match(formatEditSuccessFeedback(result).content, /"lines":"3-44"/);
  });
});
