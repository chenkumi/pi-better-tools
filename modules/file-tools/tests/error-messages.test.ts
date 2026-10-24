import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareEditArguments, prepareReadArguments, prepareWriteArguments } from "../extensions/file-tools.js";
import { FileToolError, classifyFsError } from "../src/errors.js";
import { assertInputSize, editTextFile, readTextFile, writeTextFile } from "../src/file-operations.js";
import { registerLsTool } from "../src/search-tools.js";

function failure(run: () => unknown): FileToolError["payload"] {
  try { run(); } catch (error) {
    assert.ok(error instanceof FileToolError, String(error));
    return error.payload;
  }
  assert.fail("expected a FileToolError");
}
async function asyncFailure(run: () => Promise<unknown>): Promise<FileToolError["payload"]> {
  try { await run(); } catch (error) {
    assert.ok(error instanceof FileToolError, String(error));
    return error.payload;
  }
  assert.fail("expected a FileToolError");
}
const edit = (item: Record<string, unknown>) => () => prepareEditArguments({ path: "f.txt", edits: [{ oldText: "a", newText: "b", ...item }] });
const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

test("replacementMode lists the allowed values and the received value", () => {
  const payload = failure(edit({ replacementMode: "regex" }));
  assert.equal(payload.code, "INVALID_ARGUMENT");
  assert.match(payload.message, /edit\.edits\[0\]\.replacementMode must be "literal" or "template" \(received "regex"\)/);
  assert.ok(payload.recovery);
});

test("positive-integer fields echo the received value and type", () => {
  const payload = failure(() => prepareReadArguments({ path: "f", offset: "10" }));
  assert.match(payload.message, /read\.offset must be an integer >= 1 \(received "10" \(string\)\)/);
  assert.match(payload.recovery!, /JSON number/);
  assert.match(failure(() => prepareReadArguments({ path: "f", limit: 0 })).message, /read\.limit.*received 0/);
  assert.match(failure(edit({ lineRange: { start: -2, end: 3 } })).message, /lineRange\.start must be an integer >= 1 \(received -2\)/);
});

test("object, unknown-field, path and content errors say what was received and what is allowed", () => {
  assert.match(failure(() => prepareReadArguments("x")).message, /read input must be an object \(received string\)/);
  assert.match(failure(() => prepareReadArguments(null)).message, /received null/);
  assert.match(failure(() => prepareReadArguments([])).message, /received array/);
  const unknown = failure(() => prepareReadArguments({ path: "f", foo: 1 }));
  assert.match(unknown.message, /unsupported field\(s\): foo/);
  assert.match(unknown.message, /allowed: path, offset, limit/);
  assert.match(failure(() => prepareReadArguments({ path: 5 })).message, /read\.path must be a non-empty string \(received 5\)/);
  assert.match(failure(() => prepareReadArguments({ path: "" })).message, /received empty string/);
  assert.match(failure(() => prepareWriteArguments({ path: "f", content: 5 })).message, /write\.content must be a string \(received 5\)/);
});

test("expectedHash errors echo the received value and list accepted forms", () => {
  const write = failure(() => prepareWriteArguments({ path: "f", content: "x", expectedHash: "abc123" }));
  assert.match(write.message, /write\.expectedHash must be/);
  assert.match(write.message, /received "abc123" \(6 chars\)/);
  assert.match(write.message, /32 or 64 hex/);
  assert.match(write.message, /'missing'/);
  const editMissing = failure(() => prepareEditArguments({ path: "f", expectedHash: "missing", edits: [{ oldText: "a", newText: "b" }] }));
  assert.match(editMissing.message, /received "missing"/);
  assert.match(editMissing.recovery!, /not valid for edit/);
});

test("edit.edits problems are distinguished and named", () => {
  assert.match(failure(() => prepareEditArguments({ path: "f", edits: "[not json" })).message, /edit\.edits is a string but not valid JSON: .*; received "\[not json"/);
  const top = failure(() => prepareEditArguments({ path: "f", oldText: "a", newText: "b" }));
  assert.match(top.message, /found: oldText, newText/);
  assert.match(top.recovery!, /"edits":\[\{"oldText"/);
  assert.match(failure(() => prepareEditArguments({ path: "f" })).message, /edit\.edits is required \(received undefined\)/);
  assert.match(failure(() => prepareEditArguments({ path: "f", edits: 5 })).message, /edit\.edits must be an array \(received 5\)/);
  assert.match(failure(() => prepareEditArguments({ path: "f", edits: [] })).message, /edit\.edits must contain at least one replacement \(received an empty array\)/);
  const many = failure(() => prepareEditArguments({ path: "f", edits: Array.from({ length: 101 }, () => ({})) }));
  assert.match(many.message, /more than 100 operations \(received 101\)/);
});

test("edit item matching-mode errors say which case applies", () => {
  assert.match(failure(edit({ regex: "a" })).message, /both oldText and regex were given/);
  assert.match(failure(() => prepareEditArguments({ path: "f", edits: [{ newText: "b" }] })).message, /neither oldText nor regex was given/);
  assert.match(failure(edit({ oldText: "" })).message, /oldText is empty/);
  assert.match(failure(() => prepareEditArguments({ path: "f", edits: [{ oldText: "a", newText: 5 }] })).message, /newText must be a string \(received 5\)/);
  const flag = failure(edit({ replaceAll: "yes" }));
  assert.match(flag.message, /replaceAll must be a boolean \(received "yes"\)/);
  assert.match(flag.recovery!, /true\/false/);
});

test("regexFlags and regex errors give limits, allowed values and received values", () => {
  const flags = failure(edit({ oldText: undefined, regex: "a", regexFlags: "g" }));
  assert.equal(flags.code, "INVALID_REGEX");
  assert.match(flags.message, /regexFlags "g" is not allowed \(allowed: i, m, s, u, each at most once; use replaceAll:true instead of g\)/);
  const noRegex = failure(edit({ regexFlags: "i" }));
  assert.match(noRegex.message, /regexFlags requires regex/);
  const long = failure(edit({ oldText: undefined, regex: "a".repeat(4097) }));
  assert.match(long.message, /regex is 4097 UTF-16 code units; the limit is 4096/);
});

test("lineRange errors name the missing field or the inverted bounds", () => {
  assert.match(failure(edit({ lineRange: { start: 2 } })).message, /lineRange\.end is required/);
  assert.match(failure(edit({ lineRange: { end: 2 } })).message, /lineRange\.start is required/);
  assert.match(failure(edit({ lineRange: { start: 10, end: 3 } })).message, /lineRange\.end \(3\) is less than lineRange\.start \(10\)/);
});

test("filesystem errors carry operation, resolved path and a specific hint", () => {
  const errno = (code: string) => Object.assign(new Error(`${code}: raw node text`), { code });
  const missing = classifyFsError(errno("ENOENT"), "a/b.txt", "read", "C:\\ws\\a\\b.txt").payload;
  assert.equal(missing.code, "FILE_NOT_FOUND");
  assert.match(missing.message, /File not found: a\/b\.txt \(resolved to C:\\ws\\a\\b\.txt\)/);
  const notDir = classifyFsError(errno("ENOTDIR"), "a/b.txt", "write", "C:\\ws\\a\\b.txt").payload;
  assert.equal(notDir.code, "FILE_NOT_FOUND");
  assert.doesNotMatch(notDir.message, /does not exist/);
  assert.match(notDir.message, /ENOTDIR.*not a directory/);
  assert.match(notDir.recovery!, /regular file/);
  for (const [code, hint] of [["ENOSPC", /no space/i], ["EROFS", /read-only/i], ["ENAMETOOLONG", /too long/i], ["ELOOP", /symbolic link/i], ["EISDIR", /directory/i], ["EMFILE", /too many open files/i], ["EBUSY", /busy|locked/i]] as const) {
    const payload = classifyFsError(errno(code), "x.txt", "write", "C:\\ws\\x.txt").payload;
    assert.equal(payload.code, "IO_ERROR");
    assert.equal(payload.causeCode, code);
    assert.match(payload.message, hint, code);
    assert.match(payload.message, /writing x\.txt/);
    assert.doesNotMatch(payload.message, /raw node text/);
  }
  const unknown = classifyFsError(errno("EWEIRD"), "x.txt", "edit").payload;
  assert.match(unknown.message, /EWEIRD/);
});

test("real operations report the resolved path for missing targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-msg-"));
  try {
    const target = join(dir, "nope.txt");
    const read = await asyncFailure(() => readTextFile(target, "nope.txt"));
    assert.match(read.message, new RegExp(`resolved to ${escapeRegExp(target)}`));
    const edited = await asyncFailure(() => editTextFile(target, "nope.txt", [{ oldText: "a", newText: "b", replaceAll: false, replacementMode: "literal" }]));
    assert.equal(edited.code, "FILE_NOT_FOUND");
    assert.match(edited.message, /nope\.txt.*resolved to/);
    await writeFile(join(dir, "file"), "x");
    const written = await asyncFailure(() => writeTextFile(join(dir, "file", "child.txt"), "file/child.txt", "x"));
    assert.doesNotMatch(written.message, /does not exist/);
    assert.match(written.message, /already exists as a file|not a directory/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("TEXT_NOT_FOUND quotes the searched text and flags whitespace mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-msg-"));
  try {
    const target = join(dir, "crlf.txt");
    await writeFile(target, "alpha\r\nbeta\r\n");
    const miss = await asyncFailure(() => editTextFile(target, "crlf.txt", [{ oldText: "gamma delta", newText: "x", replaceAll: false, replacementMode: "literal" }]));
    assert.equal(miss.code, "TEXT_NOT_FOUND");
    assert.match(miss.message, /did not match inside the requested search scope \(searched for "gamma delta"\)/);
    assert.match(miss.recovery!, /whitespace|tabs|trailing/i);
    const ws = await asyncFailure(() => editTextFile(target, "crlf.txt", [{ oldText: "alpha  ", newText: "x", replaceAll: false, replacementMode: "literal" }]));
    assert.match(ws.message, /searched for "alpha  "/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("oversized input states the actual size and an alternative", () => {
  const payload = failure(() => assertInputSize(60 * 1024 * 1024, "big.bin"));
  assert.match(payload.message, /input is 62914560 bytes, which exceeds the 52428800-byte processing limit/);
  assert.match(payload.recovery!, /sed -n|head -c/);
});

test("ls input must be an object states the tool and an example", () => {
  let prepare: ((args: unknown) => unknown) | undefined;
  registerLsTool({ registerTool: (tool: { prepareArguments: (args: unknown) => unknown }) => { prepare = tool.prepareArguments; } } as never);
  assert.throws(() => prepare!("x"), /ls input must be an object like \{"path":"\.","limit":100\} \(received string\)/);
});
