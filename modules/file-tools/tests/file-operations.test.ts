import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyPatch } from "diff";
import fileToolsExtension, {
  formatEditCallPreview,
  formatEditSuccessFeedback,
  prepareEditArguments,
  prepareReadArguments,
  prepareWriteArguments,
} from "../extensions/file-tools.js";
import { FileToolError, formatFileToolErrorForDisplay } from "../src/errors.js";
import { findUniqueSkillFallbackPath } from "../src/skill-paths.js";
import {
  compactPatch,
  editTextFile,
  MAX_EDIT_OPERATIONS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  normalizeLf,
  readTextBuffer,
  readTextFile,
  sha256,
  sha256Token,
  writeTextFile,
} from "../src/file-operations.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-file-tools-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function expectFileError(action: () => Promise<unknown>, code: string): Promise<FileToolError> {
  try {
    await action();
    assert.fail(`Expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof FileToolError);
    assert.equal(error.payload.code, code);
    return error;
  }
}

describe("SHA-256 version tokens", () => {
  it("accepts compact tokens and legacy full SHA-256 values for write and edit", () => {
    const token = sha256Token("content");
    const fullHash = sha256("content");
    const edit = [{ oldText: "before", newText: "after" }];

    assert.equal(token.length, 32);
    assert.equal(prepareWriteArguments({ path: "x", content: "content", expectedHash: token }).expectedHash, token);
    assert.equal(prepareEditArguments({ path: "x", expectedHash: token, edits: edit }).expectedHash, token);
    assert.equal(prepareWriteArguments({ path: "x", content: "content", expectedHash: fullHash }).expectedHash, fullHash);
    assert.equal(prepareEditArguments({ path: "x", expectedHash: fullHash, edits: edit }).expectedHash, fullHash);
  });
});

describe("checklist atomic commit regressions", () => {
  it("M10 writes and replaces a long basename without leaking temporary files", async () => {
    const name = `${"x".repeat(220)}.txt`;
    const path = join(directory, name);
    const created = await writeTextFile(path, name, "before", "missing");
    assert.equal(created.created, true);
    await writeTextFile(path, name, "after", created.sha256);
    assert.equal(await readFile(path, "utf8"), "after");
    assert.deepEqual(await readdir(directory), [name]);
  });

  it("L7 rejects different full hashes even when their compact prefix matches", async () => {
    const path = join(directory, "hash.txt");
    await writeFile(path, "before");
    const hash = sha256("before");
    const wrongFullHash = hash.slice(0, 63) + (hash[63] === "0" ? "1" : "0");
    await expectFileError(() => writeTextFile(path, "hash.txt", "after", wrongFullHash), "STALE_FILE");
    await expectFileError(() => editTextFile(path, "hash.txt", [{ oldText: "before", newText: "after" }], wrongFullHash), "STALE_FILE");
    assert.equal(await readFile(path, "utf8"), "before");
  });

  it("L5 rejects a change between the final hash read and rename", async t => {
    const path = join(directory, "race.txt");
    await writeFile(path, "before");
    const originalLstat = fsPromises.lstat;
    let checks = 0;
    t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof originalLstat>) => {
      if (++checks === 3) await writeFile(path, "external change");
      return originalLstat(...args);
    });
    syncBuiltinESMExports();
    try {
      await expectFileError(() => writeTextFile(path, "race.txt", "after"), "STALE_FILE");
      assert.equal(await readFile(path, "utf8"), "external change");
      assert.deepEqual(await readdir(directory), ["race.txt"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("L5 honors cancellation during the last stat check before commit", async t => {
    const path = join(directory, "abort-commit.txt");
    await writeFile(path, "before");
    const controller = new AbortController();
    const originalLstat = fsPromises.lstat;
    let checks = 0;
    t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof originalLstat>) => {
      const result = await originalLstat(...args);
      if (++checks === 3) controller.abort();
      return result;
    });
    syncBuiltinESMExports();
    try {
      await expectFileError(() => writeTextFile(path, "abort-commit.txt", "after", undefined, controller.signal), "OPERATION_ABORTED");
      assert.equal(await readFile(path, "utf8"), "before");
      assert.deepEqual(await readdir(directory), ["abort-commit.txt"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  if (process.platform === "win32") {
    it("M10 retries sharing violations including EACCES without weakening stale detection", async t => {
      const path = join(directory, "retry.txt");
      await writeFile(path, "before");
      const originalRename = fsPromises.rename;
      const originalStat = await fsPromises.stat(path);
      let attempts = 0;
      t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof originalRename>) => {
        attempts++;
        // Same size and restored mtime: only a full hash can detect this external write.
        await writeFile(path, "OTHERS");
        await utimes(path, originalStat.atime, originalStat.mtime);
        throw Object.assign(new Error("sharing violation"), { code: "EACCES" });
      });
      syncBuiltinESMExports();
      try {
        await expectFileError(() => writeTextFile(path, "retry.txt", "after"), "STALE_FILE");
        assert.equal(attempts, 1, "must refuse before attempting another rename");
        assert.equal(await readFile(path, "utf8"), "OTHERS");
        assert.deepEqual(await readdir(directory), ["retry.txt"]);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });

    it("M10 succeeds after transient sharing violations and L5 checks every retry", async t => {
      const path = join(directory, "retry-success.txt");
      await writeFile(path, "before");
      const originalRename = fsPromises.rename;
      const originalLstat = fsPromises.lstat;
      let attempts = 0;
      let checks = 0;
      t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof originalRename>) => {
        if (++attempts < 3) throw Object.assign(new Error("sharing violation"), { code: attempts === 1 ? "EBUSY" : "EACCES" });
        return originalRename(...args);
      });
      t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof originalLstat>) => {
        checks++;
        return originalLstat(...args);
      });
      syncBuiltinESMExports();
      try {
        await writeTextFile(path, "retry-success.txt", "after");
        assert.equal(attempts, 3);
        assert.equal(checks, 7, "initial snapshot plus hash/fingerprint checks for all three attempts");
        assert.equal(await readFile(path, "utf8"), "after");
        assert.deepEqual(await readdir(directory), ["retry-success.txt"]);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});

describe("checklist diff commit policy", () => {
  it("M11 refuses to commit when the diff worker reports a timeout", async t => {
    const path = join(directory, "diff-timeout.txt");
    await writeFile(path, "before");
    const originalOn = Worker.prototype.on;
    t.mock.method(Worker.prototype, "on", function(this: Worker, event: string, listener: (...args: unknown[]) => void) {
      const result = originalOn.call(this, event, listener);
      if (event === "message") queueMicrotask(() => this.emit("message", { type: "error", code: "OPERATION_TIMEOUT" }));
      return result;
    });
    try {
      const error = await expectFileError(() => editTextFile(path, "diff-timeout.txt", [{ oldText: "before", newText: "after" }]), "OPERATION_TIMEOUT");
      assert.match(error.payload.message, /no edit was committed/);
      assert.equal(await readFile(path, "utf8"), "before");
      assert.deepEqual(await readdir(directory), ["diff-timeout.txt"]);
    } finally { t.mock.restoreAll(); }
  });
});

describe("checklist regex session regressions", () => {
  it("L6 reuses one worker and one text clone for successive whole-file regex edits", async t => {
    const path = join(directory, "reuse.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n");
    const original = Worker.prototype.postMessage;
    const requests: Array<{ id: number; hasText: boolean }> = [];
    t.mock.method(Worker.prototype, "postMessage", function(this: Worker, value: unknown) {
      const request = value as { pattern?: string; text?: string };
      if (request.pattern !== undefined) requests.push({ id: this.threadId, hasText: Object.hasOwn(request, "text") });
      return original.call(this, value);
    });
    try {
      await editTextFile(path, "reuse.txt", [
        { regex: "^alpha$", regexFlags: "m", newText: "A" },
        { regex: "^beta$", regexFlags: "m", newText: "B" },
        { regex: "^gamma$", regexFlags: "m", newText: "G" },
      ]);
      assert.equal(await readFile(path, "utf8"), "A\nB\nG\n");
      assert.equal(requests.length, 3);
      assert.equal(new Set(requests.map(request => request.id)).size, 1);
      assert.deepEqual(requests.map(request => request.hasText), [true, false, false]);
    } finally { t.mock.restoreAll(); }
  });

  it("L6 tears down an aborted reused worker without committing partial replacements", async t => {
    const path = join(directory, "abort-reuse.txt");
    await writeFile(path, "alpha beta");
    const controller = new AbortController();
    const original = Worker.prototype.postMessage;
    let requests = 0;
    let reused: Worker | undefined;
    t.mock.method(Worker.prototype, "postMessage", function(this: Worker, value: unknown) {
      if ((value as { pattern?: string }).pattern !== undefined && ++requests === 2) {
        reused = this;
        queueMicrotask(() => controller.abort());
      }
      return original.call(this, value);
    });
    try {
      await expectFileError(() => editTextFile(path, "abort-reuse.txt", [
        { regex: "alpha", newText: "A" }, { regex: "beta", newText: "B" },
      ], undefined, controller.signal), "OPERATION_ABORTED");
      assert.equal(requests, 2);
      assert.equal(reused?.threadId, -1, "the reused worker must finish termination before returning");
      assert.equal(await readFile(path, "utf8"), "alpha beta");
    } finally { t.mock.restoreAll(); }
    await editTextFile(path, "abort-reuse.txt", [{ regex: "beta", newText: "B" }]);
    assert.equal(await readFile(path, "utf8"), "alpha B");
  });

  it("L6 refreshes changed scopes without sharing anchors, lastIndex or captures", async () => {
    const path = join(directory, "scope.txt");
    await writeFile(path, "outside\nalpha\nbeta\n");
    await editTextFile(path, "scope.txt", [
      { regex: "^(alpha)$", newText: "$1-A", replacementMode: "template", lineRange: { start: 2, end: 2 } },
      { regex: "^(beta)$", newText: "$1-B", replacementMode: "template", lineRange: { start: 3, end: 3 } },
      { regex: "^outside", newText: "O" },
    ]);
    assert.equal(await readFile(path, "utf8"), "O\nalpha-A\nbeta-B\n");
    const before = await readFile(path, "utf8");
    const failure = await expectFileError(() => editTextFile(path, "scope.txt", [
      { regex: "^alpha-A$", newText: "wrong", lineRange: { start: 1, end: 1 }, regexFlags: "m" },
    ]), "TEXT_NOT_FOUND_IN_RANGE");
    assert.deepEqual(failure.payload.candidateRanges, [{ start: 2, end: 2 }]);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

describe("readTextFile", () => {
  it("returns absolute line prefixes, range metadata, and a hash", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "alpha\nbeta\ngamma\ndelta", "utf8");

    const result = await readTextFile(path, "sample.txt", 2, 2);
    assert.match(result.text, /^\[FILE_METADATA\] \{"path":"sample\.txt","sha256":"[0-9a-f]{32}","lines":"2-3","total":4\}\n2│beta/);
    assert.doesNotMatch(result.text, /LINE_PREFIX|lineStart|lineEnd/);
    assert.match(result.text, /2│beta\n3│gamma/);
    assert.equal(result.details.lineStart, 2);
    assert.equal(result.details.lineEnd, 3);
    assert.equal(result.details.sha256, sha256Token("alpha\nbeta\ngamma\ndelta"));
    assert.equal(result.details.sha256.length, 32);
    assert.match(result.text, /nextOffset=4/);
  });

  it("BUG-001 preserves empty lines, BOM, normalized endings, requested width, and offset/limit pages", () => {
    for (const original of ["", "\ufeff", "\n", "\n\n", "single", "\ufeff😀\r\n�\rfinal\n", "x\n".repeat(10)]) {
      const buffer = Buffer.from(original);
      const lines = original.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split("\n");
      for (let offset = 1; offset <= lines.length; offset++) {
        for (const limit of [undefined, 1, 2, 20]) {
          const result = readTextBuffer(buffer, "reference.txt", offset, limit);
          const end = Math.min(lines.length, limit === undefined ? lines.length : offset + limit - 1);
          const expectedBody = lines.slice(offset - 1, end).map((body, index) => `${String(offset + index).padStart(String(end).length)}│${body}`).join("\n");
          assert.equal(result.text.split("\n").slice(1).join("\n"), expectedBody + (end < lines.length ? `\n[READ_CONTINUATION] nextOffset=${end + 1}; totalLines=${lines.length}; reason=limit` : ""));
          assert.equal(result.text.split(String.fromCharCode(10))[0].includes("\"lines\""), !(offset === 1 && end === lines.length));
          assert.deepEqual(result.details, { path: "reference.txt", sha256: sha256Token(buffer), totalLines: lines.length, lineStart: offset, lineEnd: end });
        }
      }
    }
  });

  it("BUG-001 counts truncation totals for the requested span, not merely the displayed page", () => {
    const lines = Array.from({ length: 2055 }, (_, index) => `x${index % 3}`);
    const buffer = Buffer.from(lines.join("\r\n"));
    for (const limit of [undefined, 2001]) {
      const offset = 9;
      const end = limit === undefined ? lines.length : offset + limit - 1;
      // Small independent, eager reference is intentional; the resource probe tests
      // that the production implementation no longer does this for an entire file.
      const requested = lines.slice(offset - 1, end).map((body, index) => `${String(offset + index).padStart(String(end).length)}│${body}`);
      const full = requested.join("\n");
      const page = requested.slice(0, MAX_OUTPUT_LINES).join("\n");
      const result = readTextBuffer(buffer, "stats.txt", offset, limit);
      assert.deepEqual(result.details.truncation, {
        content: page, truncated: true, truncatedBy: "lines", totalLines: requested.length,
        totalBytes: Buffer.byteLength(full), outputLines: MAX_OUTPUT_LINES, outputBytes: Buffer.byteLength(page),
        lastLinePartial: false, firstLineExceedsLimit: false, maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES,
      });
      assert.equal(result.details.lineEnd, 2008);
      assert.match(result.text, /nextOffset=2009; totalLines=2055; reason=lines/);
    }
  });

  it("BUG-001 preserves exact byte boundaries, multibyte accounting, and complete-line truncation", () => {
    const exact = "x".repeat(MAX_OUTPUT_BYTES - 4); // one digit plus UTF-8 │ = 4 bytes
    for (const first of [exact, "é".repeat(24000)]) {
      const original = `${first}\n${"中".repeat(2000)}\nlast`;
      const result = readTextBuffer(Buffer.from(original), "bytes.txt");
      assert.equal(result.details.lineEnd, 1);
      const truncation = result.details.truncation!;
      assert.equal(truncation.truncatedBy, "bytes");
      assert.equal(truncation.outputBytes, Buffer.byteLength(first) + 4);
      assert.equal(truncation.outputLines, 1);
      assert.equal(truncation.totalLines, 3);
      assert.equal(truncation.totalBytes, Buffer.byteLength(original) + 3 * 4);
      assert.equal(truncation.firstLineExceedsLimit, false);
      assert.match(result.text, /nextOffset=2/);
      const next = readTextBuffer(Buffer.from(original), "bytes.txt", 2);
      assert.equal(next.details.lineEnd, 3);
      assert.doesNotMatch(next.text, /READ_CONTINUATION/);
    }
    assert.equal(readTextBuffer(Buffer.from(exact), "exact.txt").details.truncation, undefined);
  });

  it("BUG-001 pagination advances without omissions or duplicates under line, byte, and user limits", () => {
    const expected = Array.from({ length: 4011 }, (_, index) => `中${index}😀${"z".repeat(index % 71)}`).concat("");
    const buffer = Buffer.from("\ufeff" + expected.join("\r\n"));
    for (const limit of [undefined, 1371]) {
      const seen: string[] = [];
      let offset = 1;
      for (let pages = 0; ; pages++) {
        assert.ok(pages < 20, "continuation must make progress");
        const result = readTextBuffer(buffer, "pages.txt", offset, limit);
        const displayed = [...result.text.matchAll(/^ *(\d+)│(.*)$/gm)];
        for (const line of displayed) {
          assert.equal(Number(line[1]), seen.length + 1);
          seen.push(line[2]);
        }
        const next = result.text.match(/\[READ_CONTINUATION\] nextOffset=(\d+)/);
        if (!next) break;
        assert.equal(Number(next[1]), offset + displayed.length);
        assert.ok(Number(next[1]) > offset);
        offset = Number(next[1]);
      }
      assert.deepEqual(seen, expected);
    }
  });

  it("BUG-001 skips only an oversized current line and then resumes later data", () => {
    const buffer = Buffer.from(`first\n${"x".repeat(MAX_OUTPUT_BYTES)}\nlast\n`);
    const first = readTextBuffer(buffer, "oversized.txt");
    assert.equal(first.details.lineEnd, 1);
    assert.match(first.text, /nextOffset=2;.*reason=bytes/);
    const oversized = readTextBuffer(buffer, "oversized.txt", 2);
    assert.equal(oversized.details.lineEnd, 1);
    assert.equal(oversized.details.truncation?.outputBytes, 0);
    assert.match(oversized.text, /LINE_TOO_LARGE/);
    assert.match(oversized.text, /nextOffset=3;.*reason=oversized_line_skipped/);
    const last = readTextBuffer(buffer, "oversized.txt", 3);
    assert.match(last.text, /3│last\n4│$/);
    assert.doesNotMatch(last.text, /READ_CONTINUATION/);
  });

  it("BUG-001 still validates UTF-8 beyond a user-limited output page", () => {
    assert.throws(() => readTextBuffer(Buffer.concat([Buffer.from("valid\n"), Buffer.from([0x80])]), "invalid.txt", 1, 1),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_ENCODING");
  });

  it("classifies an offset beyond the file", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "one\ntwo", "utf8");
    await expectFileError(() => readTextFile(path, "sample.txt", 3), "RANGE_OUT_OF_BOUNDS");
  });

  it("rejects files larger than the processing limit before loading them", async () => {
    const path = join(directory, "too-large.txt");
    await writeFile(path, "", "utf8");
    await truncate(path, MAX_INPUT_BYTES + 1);

    await expectFileError(() => readTextFile(path, "too-large.txt"), "FILE_TOO_LARGE");
  });

  it("does not advertise a non-progressing continuation for one oversized line", async () => {
    const path = join(directory, "large-line.txt");
    await writeFile(path, "x".repeat(60 * 1024), "utf8");
    const result = await readTextFile(path, "large-line.txt");
    assert.match(result.text, /LINE_TOO_LARGE/);
    assert.doesNotMatch(result.text, /READ_CONTINUATION/);
  });

  it("can continue after skipping an oversized line when later lines exist", async () => {
    const path = join(directory, "large-line.txt");
    await writeFile(path, `${"x".repeat(60 * 1024)}\nsecond`, "utf8");
    const result = await readTextFile(path, "large-line.txt");
    assert.match(result.text, /reason=oversized_line_skipped/);
    assert.match(result.text, /nextOffset=2/);
  });
});

describe("writeTextFile", () => {
  it("creates a file when expectedHash is missing", async () => {
    const path = join(directory, "nested", "new.txt");
    const result = await writeTextFile(path, "nested/new.txt", "created", "missing");

    assert.equal(result.created, true);
    assert.equal(await readFile(path, "utf8"), "created");
  });

  it("accepts the compact read token and returns a compact token after writing", async () => {
    const path = join(directory, "compact-token.txt");
    await writeFile(path, "before", "utf8");
    const read = await readTextFile(path, "compact-token.txt");

    const result = await writeTextFile(path, "compact-token.txt", "after", read.details.sha256);

    assert.equal(await readFile(path, "utf8"), "after");
    assert.equal(result.sha256, sha256Token("after"));
    assert.equal(result.sha256.length, 32);
  });

  it("rejects lone UTF-16 surrogates instead of writing replacement characters", async () => {
    const path = join(directory, "surrogate.txt");

    await expectFileError(() => writeTextFile(path, "surrogate.txt", "\ud800"), "INVALID_ARGUMENT");
  });

  it("rejects write content larger than the processing limit", async () => {
    const path = join(directory, "large-write.txt");
    const content = "x".repeat(MAX_INPUT_BYTES + 1);

    await expectFileError(() => writeTextFile(path, "large-write.txt", content), "FILE_TOO_LARGE");
  });

  it("rejects stale overwrites using the compact token", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "first", "utf8");
    const oldToken = sha256Token("first");
    await writeFile(path, "changed externally", "utf8");

    const error = await expectFileError(() => writeTextFile(path, "sample.txt", "replacement", oldToken), "STALE_FILE");
    assert.equal(error.payload.expectedHash, oldToken);
    assert.equal(error.payload.actualHash?.length, 32);
    assert.equal(await readFile(path, "utf8"), "changed externally");
  });

  it("continues to accept a legacy full SHA-256 expectedHash", async () => {
    const path = join(directory, "legacy-hash.txt");
    await writeFile(path, "before", "utf8");

    const result = await writeTextFile(path, "legacy-hash.txt", "after", sha256("before"));

    assert.equal(await readFile(path, "utf8"), "after");
    assert.equal(result.sha256, sha256Token("after"));
  });

  it("refuses to replace a symbolic link", async (t) => {
    const target = join(directory, "target.txt");
    const linkPath = join(directory, "link.txt");
    await writeFile(target, "target", "utf8");
    try {
      await symlink(target, linkPath, "file");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
        t.skip("Creating symlinks requires additional Windows privileges");
        return;
      }
      throw error;
    }

    await expectFileError(() => writeTextFile(linkPath, "link.txt", "replacement"), "SYMLINK_UNSUPPORTED");
    assert.equal(await readFile(target, "utf8"), "target");
  });

  it("does not replace a path won by a concurrent creator", async () => {
    const path = join(directory, "race.txt");
    const results = await Promise.allSettled([
      writeTextFile(path, "race.txt", "first", "missing"),
      writeTextFile(path, "race.txt", "second", "missing"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.ok(["first", "second"].includes(await readFile(path, "utf8")));
  });
});

describe("editTextFile", () => {
  it("uses the line range as a search window rather than a whole-line replacement", async () => {
    const path = join(directory, "sample.ts");
    const original = [
      "const duplicate = false;",
      "function configure() {",
      "  const duplicate = false;",
      "  return duplicate;",
      "}",
    ].join("\n");
    await writeFile(path, original, "utf8");

    const result = await editTextFile(
      path,
      "sample.ts",
      [{ lineRange: { start: 2, end: 4 }, oldText: "const duplicate = false;", newText: "const duplicate = true;" }],
      sha256Token(original),
    );

    const updated = await readFile(path, "utf8");
    assert.match(updated, /^const duplicate = false;/);
    assert.match(updated, /  const duplicate = true;/);
    assert.equal(result.sha256Before, sha256Token(original));
    assert.equal(result.sha256Before.length, 32);
    assert.equal(result.sha256After, sha256Token(updated));
    assert.equal(result.changedRanges[0].matchedLineStart, 3);
    assert.match(result.patch, /-  const duplicate = false;/);
    assert.match(result.patch, /\+  const duplicate = true;/);
  });

  it("rejects duplicate matches inside one range", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "target\nignore\ntarget", "utf8");

    const error = await expectFileError(
      () => editTextFile(path, "sample.txt", [{ lineRange: { start: 1, end: 3 }, oldText: "target", newText: "done" }]),
      "AMBIGUOUS_MATCH",
    );
    assert.equal(error.payload.occurrences, 2);
  });

  it("counts overlapping occurrences as ambiguous", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "aaa", "utf8");
    await expectFileError(
      () => editTextFile(path, "sample.txt", [{ lineRange: { start: 1, end: 1 }, oldText: "aa", newText: "b" }]),
      "AMBIGUOUS_MATCH",
    );
  });

  it("falls back to a unique literal that crosses the lineRange boundary", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    await editTextFile(path, "sample.txt", [{ lineRange: { start: 1, end: 1 }, oldText: "alpha\nbeta", newText: "changed" }]);
    assert.equal(await readFile(path, "utf8"), "changed\ngamma");
  });

  it("rejects overlapping edits without partially writing", async () => {
    const path = join(directory, "sample.txt");
    const original = "abcdef";
    await writeFile(path, original, "utf8");

    await expectFileError(
      () =>
        editTextFile(path, "sample.txt", [
          { lineRange: { start: 1, end: 1 }, oldText: "abcd", newText: "ABCD" },
          { lineRange: { start: 1, end: 1 }, oldText: "cdef", newText: "CDEF" },
        ]),
      "OVERLAPPING_EDITS",
    );
    assert.equal(await readFile(path, "utf8"), original);
  });

  it("preserves BOM and CRLF line endings", async () => {
    const path = join(directory, "sample.txt");
    const original = "\uFEFFone\r\ntwo\r\nthree";
    await writeFile(path, original, "utf8");

    await editTextFile(path, "sample.txt", [{ lineRange: { start: 2, end: 2 }, oldText: "two", newText: "TWO" }]);
    assert.equal(await readFile(path, "utf8"), "\uFEFFone\r\nTWO\r\nthree");
  });

  it("preserves CR-only line endings for inserted newlines", async () => {
    const path = join(directory, "cr-only.txt");
    await writeFile(path, "a\rb", "utf8");

    await editTextFile(path, "cr-only.txt", [{ oldText: "a", newText: "a\ninsert" }]);

    assert.equal(await readFile(path, "utf8"), "a\rinsert\rb");
  });

  it("preserves mixed line endings outside the changed text", async () => {
    const path = join(directory, "mixed.txt");
    const original = "one\r\ntwo\nthree\r\nfour";
    await writeFile(path, original, "utf8");

    await editTextFile(path, "mixed.txt", [{ lineRange: { start: 2, end: 2 }, oldText: "two", newText: "TWO" }]);
    assert.equal(await readFile(path, "utf8"), "one\r\nTWO\nthree\r\nfour");
  });

  it("maps match offsets across CRLF, lone CR, and LF endings", async () => {
    const path = join(directory, "mixed-offsets.txt");
    await writeFile(path, "a\r\nb\rc\nd\r\n\r\ne", "utf8");

    await editTextFile(path, "mixed-offsets.txt", [
      { oldText: "a\nb", newText: "A\nB" },
      { oldText: "c\nd\n", newText: "C" },
      { regex: "^e", regexFlags: "m", newText: "E" },
    ]);
    assert.equal(await readFile(path, "utf8"), "A\r\nB\rC\r\nE");

    const insertPath = join(directory, "mixed-insert.txt");
    await writeFile(insertPath, "x\r\ny\rz\n", "utf8");
    await editTextFile(insertPath, "mixed-insert.txt", [{ regex: "^", regexFlags: "m", newText: ">", replaceAll: true }]);
    assert.equal(await readFile(insertPath, "utf8"), ">x\r\n>y\r>z\n>");
  });

  it("reports a diff consistent with the written file when a replacement fuses CR and LF", async () => {
    for (const [original, edit] of [
      // CR-dominant file: an inserted newline renders as CR and fuses with the following LF.
      ["a\rb\rc\nd", { oldText: "c", newText: "c\n" }],
      // Deleting text between a lone CR and an LF fuses them into one CRLF line break.
      ["a\rX\nb\r\nc\r\n", { oldText: "X", newText: "" }],
      // No fusion: the spliced normalized text path.
      ["one\r\ntwo\rthree\nfour\r\n", { oldText: "two\nthree", newText: "2\n3\n3.5" }],
    ] as const) {
      const path = join(directory, "fusion.txt");
      await writeFile(path, original, "utf8");
      const result = await editTextFile(path, "fusion.txt", [edit]);
      const written = await readFile(path, "utf8");
      assert.equal(applyPatch(normalizeLf(original), result.patch), normalizeLf(written), JSON.stringify(original));
    }
  });

  it("rejects lone UTF-16 surrogates in edit replacements", async () => {
    const path = join(directory, "edit-surrogate.txt");
    await writeFile(path, "old", "utf8");

    await expectFileError(
      () => editTextFile(path, "edit-surrogate.txt", [{ oldText: "old", newText: "\ud800" }]),
      "INVALID_ARGUMENT",
    );
    assert.equal(await readFile(path, "utf8"), "old");
  });

  it("BUG-002 rejects invalid final Unicode from matches and captures without changing bytes", async () => {
    const path = join(directory, "final-unicode.txt");
    const original = Buffer.from("😀", "utf8");
    for (const edit of [
      { regex: "^.", newText: "X" },
      { regex: "^(.).$", newText: "$1", replacementMode: "template" },
      { oldText: "\ud83d", newText: "X" },
    ]) {
      await writeFile(path, original);
      const args = prepareEditArguments({ path, edits: [edit] });
      await expectFileError(() => editTextFile(path, path, args.edits), "INVALID_ARGUMENT");
      assert.deepEqual(await readFile(path), original);
    }
  });

  it("BUG-002 preserves valid emoji and existing replacement characters without forcing unicode flags", async () => {
    const path = join(directory, "valid-unicode.txt");
    await writeFile(path, "😀�", "utf8");
    await editTextFile(path, path, [{ regex: "^.", regexFlags: "u", newText: "🐱" }]);
    assert.equal(await readFile(path, "utf8"), "🐱�");
    await writeFile(path, "😀", "utf8");
    await editTextFile(path, path, [{ regex: ".", newText: "X", replaceAll: true }]);
    assert.equal(await readFile(path, "utf8"), "XX");
  });

  it("BUG-008 only resolves own named captures and follows native replacement semantics", async () => {
    const path = join(directory, "named-captures.txt");
    for (const pattern of ["(?<x>a)", "(?<toString>a)", "(?<constructor>a)", "(?<__proto__>a)", "a"]) {
      for (const name of ["missing", "x", "toString", "constructor", "__proto__"]) {
        const newText = `$<${name}>!`;
        await writeFile(path, "a", "utf8");
        const args = prepareEditArguments({ path, edits: [{ regex: pattern, newText, replacementMode: "template" }] });
        await editTextFile(path, path, args.edits);
        assert.equal(await readFile(path, "utf8"), "a".replace(new RegExp(pattern), newText));
      }
    }
    await writeFile(path, "a", "utf8");
    await editTextFile(path, path, [{ regex: "(?<x>a)", newText: "$<toString>", replacementMode: "template" }]);
    assert.equal(await readFile(path, "utf8"), "");
  });

  it("rejects malformed UTF-8 instead of rewriting replacement characters", async () => {
    const path = join(directory, "binary.txt");
    await writeFile(path, Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
    await expectFileError(
      () => editTextFile(path, "binary.txt", [{ lineRange: { start: 1, end: 1 }, oldText: "foo", newText: "bar" }]),
      "INVALID_ENCODING",
    );
    assert.deepEqual(await readFile(path), Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
  });

  it("validates all edits against the original snapshot", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "first\nsecond\nthird", "utf8");

    await editTextFile(path, "sample.txt", [
      { lineRange: { start: 1, end: 1 }, oldText: "first", newText: "FIRST\ninserted" },
      { lineRange: { start: 3, end: 3 }, oldText: "third", newText: "THIRD" },
    ]);

    assert.equal(await readFile(path, "utf8"), "FIRST\ninserted\nsecond\nTHIRD");
  });

  it("edits a whole-file unique literal without lineRange", async () => {
    const path = join(directory, "large.ts");
    await writeFile(path, "before\nconst unique = false;\nafter", "utf8");

    const result = await editTextFile(path, "large.ts", [
      { oldText: "const unique = false;", newText: "const unique = true;" },
    ]);

    assert.equal(await readFile(path, "utf8"), "before\nconst unique = true;\nafter");
    assert.equal(result.matchedCount, 1);
    assert.equal(result.changedCount, 1);
    assert.equal(result.changedRanges[0].requestedLineRange, undefined);
  });

  it("returns candidate ranges for ambiguous whole-file literals", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "target\nignore\ntarget", "utf8");

    const error = await expectFileError(
      () => editTextFile(path, "sample.txt", [{ oldText: "target", newText: "done" }]),
      "AMBIGUOUS_MATCH",
    );
    assert.deepEqual(error.payload.candidateRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  });

  it("replaces every literal match in the selected scope", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "target\ntarget\noutside target", "utf8");

    const result = await editTextFile(path, "sample.txt", [
      { oldText: "target", newText: "done", lineRange: { start: 1, end: 2 }, replaceAll: true },
    ]);

    assert.equal(await readFile(path, "utf8"), "done\ndone\noutside target");
    assert.equal(result.matchedCount, 2);
    assert.equal(result.changedCount, 2);
  });

  it("falls back to a unique literal outside a failed lineRange", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "target\nignore\nother", "utf8");

    const result = await editTextFile(path, "sample.txt", [
      { oldText: "target", newText: "done", lineRange: { start: 2, end: 3 } },
    ]);
    assert.equal(await readFile(path, "utf8"), "done\nignore\nother");
    assert.equal(result.matchedCount, 1);
    assert.equal(result.changedRanges[0].requestedLineRange?.start, 2);
  });

  it("does not fall back when a literal is ambiguous outside a failed lineRange", async () => {
    const path = join(directory, "sample.txt");
    const original = "target\nignore\ntarget";
    await writeFile(path, original, "utf8");

    const error = await expectFileError(
      () => editTextFile(path, "sample.txt", [{ oldText: "target", newText: "done", lineRange: { start: 2, end: 2 } }]),
      "TEXT_NOT_FOUND_IN_RANGE",
    );
    assert.equal(error.payload.occurrences, 2);
    assert.deepEqual(error.payload.candidateRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
    assert.equal(await readFile(path, "utf8"), original);
  });

  it("supports regex capture templates", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "item-12 item-34", "utf8");

    const result = await editTextFile(path, "sample.txt", [
      {
        regex: "item-(\\d+)",
        newText: "value:$1",
        replacementMode: "template",
        replaceAll: true,
      },
    ]);

    assert.equal(await readFile(path, "utf8"), "value:12 value:34");
    assert.equal(result.changedCount, 2);
  });

  it("keeps dollar references literal by default for regex replacements", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "item-12", "utf8");

    await editTextFile(path, "sample.txt", [
      { regex: "item-(\\d+)", newText: "value:$1" },
    ]);

    assert.equal(await readFile(path, "utf8"), "value:$1");
  });

  it("does not rewrite raw line endings for normalized no-op matches", async () => {
    const path = join(directory, "mixed.txt");
    const original = "A\r\nB\nC\nX";
    await writeFile(path, original, "utf8");

    const result = await editTextFile(path, "mixed.txt", [
      {
        regex: "(A\\nB\\nC)|X",
        newText: "$1",
        replacementMode: "template",
        replaceAll: true,
      },
    ]);

    assert.equal(await readFile(path, "utf8"), "A\r\nB\nC\n");
    assert.equal(result.matchedCount, 2);
    assert.equal(result.changedCount, 1);
    assert.equal(result.changedRanges.length, 1);
  });

  it("allows zero-width insertions at another edit boundary", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "a", "utf8");

    await editTextFile(path, "sample.txt", [
      { oldText: "a", newText: "A" },
      { regex: "$", newText: "!" },
    ]);

    assert.equal(await readFile(path, "utf8"), "A!");
  });

  it("supports zero-width regex replaceAll without looping", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "one\ntwo", "utf8");

    await editTextFile(path, "sample.txt", [
      { regex: "^", regexFlags: "m", newText: "> ", replaceAll: true },
    ]);

    assert.equal(await readFile(path, "utf8"), "> one\n> two");
  });

  it("advances zero-width unicode regex matches by code point", async () => {
    const path = join(directory, "unicode.txt");
    await writeFile(path, "😀x", "utf8");

    await editTextFile(path, "unicode.txt", [
      { regex: "(?=.)", regexFlags: "u", newText: ">", replaceAll: true },
    ]);

    assert.equal(await readFile(path, "utf8"), ">😀>x");
  });

  it("rejects invalid regex flags and preserves the file", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "unchanged", "utf8");

    await expectFileError(
      () => editTextFile(path, "sample.txt", [{ regex: "unchanged", regexFlags: "g", newText: "changed" }]),
      "INVALID_REGEX",
    );
    assert.equal(await readFile(path, "utf8"), "unchanged");
  });

  it("rejects overlapping literal replaceAll matches", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "aaa", "utf8");

    await expectFileError(
      () => editTextFile(path, "sample.txt", [{ oldText: "aa", newText: "b", replaceAll: true }]),
      "OVERLAPPING_EDITS",
    );
    assert.equal(await readFile(path, "utf8"), "aaa");
  });

  it("enforces the per-operation match limit", async () => {
    const path = join(directory, "sample.txt");
    const original = "a".repeat(10_001);
    await writeFile(path, original, "utf8");

    await expectFileError(
      () => editTextFile(path, "sample.txt", [{ oldText: "a", newText: "b", replaceAll: true }]),
      "TOO_MANY_MATCHES",
    );
    assert.equal(await readFile(path, "utf8"), original);
  });

  it("terminates catastrophic regex evaluation", async () => {
    const path = join(directory, "sample.txt");
    const original = `${"a".repeat(30_000)}!`;
    await writeFile(path, original, "utf8");

    await expectFileError(
      () => editTextFile(path, "sample.txt", [{ regex: "(a+)+$", newText: "done" }]),
      "REGEX_TIMEOUT",
    );
    assert.equal(await readFile(path, "utf8"), original);
  });

  it("aborts and terminates an active regex worker", async () => {
    const path = join(directory, "sample.txt");
    const original = `${"a".repeat(30_000)}!`;
    await writeFile(path, original, "utf8");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    await expectFileError(
      () => editTextFile(path, "sample.txt", [{ regex: "(a+)+$", newText: "done" }], undefined, controller.signal),
      "OPERATION_ABORTED",
    );
    assert.equal(await readFile(path, "utf8"), original);
  });

  it("rejects same-position zero-width edits", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "a", "utf8");

    await expectFileError(
      () => editTextFile(path, "sample.txt", [
        { regex: "^", newText: "first" },
        { regex: "^", newText: "second" },
      ]),
      "OVERLAPPING_EDITS",
    );
    assert.equal(await readFile(path, "utf8"), "a");
  });

  it("rejects edit batches larger than the operation limit", async () => {
    const path = join(directory, "too-many-edits.txt");
    const original = "unchanged";
    await writeFile(path, original, "utf8");
    const edits = Array.from({ length: MAX_EDIT_OPERATIONS + 1 }, (_, index) => ({
      oldText: `missing-${index}`,
      newText: `replacement-${index}`,
    }));

    await expectFileError(() => editTextFile(path, "too-many-edits.txt", edits), "INVALID_ARGUMENT");
    assert.equal(await readFile(path, "utf8"), original);
  });

  it("rejects empty core edit batches as invalid arguments", async () => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "unchanged", "utf8");
    await expectFileError(() => editTextFile(path, "sample.txt", []), "INVALID_ARGUMENT");
  });

  it("rejects non-regular mutation targets", async () => {
    const path = join(directory, "folder");
    await mkdir(path);
    await expectFileError(
      () => editTextFile(path, "folder", [{ oldText: "a", newText: "b" }]),
      "FILE_NOT_WRITABLE",
    );
  });
});

function registerFileToolsForTest() {
  const tools: Array<Record<string, unknown>> = [];
  let beforeAgentStart: ((event: unknown) => unknown) | undefined;
  fileToolsExtension({
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
    on: (event: string, handler: (event: unknown) => unknown) => {
      if (event === "before_agent_start") beforeAgentStart = handler;
      return () => {};
    },
  } as never);
  return {
    tools,
    startAgent(skills: Array<{ filePath: string; disableModelInvocation?: boolean }> = []) {
      if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");
      beforeAgentStart({ systemPromptOptions: { skills } });
    },
  };
}

async function executeRegisteredRead(
  tool: Record<string, unknown>,
  path: string,
  cwd: string,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }> {
  const execute = tool.execute as unknown as (
    toolCallId: string,
    params: { path: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
  return execute("test-read", { path }, undefined, undefined, { cwd });
}

describe("skill path fallback matching", () => {
  const requested = String.raw`C:\Users\user\.agents\skills\test-case-creator\SKILL.md`;
  const candidate = String.raw`C:\Users\user\.agents\skills\software-skills\test-case-creator\SKILL.md`;

  it("returns the sole suffix match across slash styles", () => {
    assert.equal(findUniqueSkillFallbackPath(requested, [candidate]), candidate);
    assert.equal(findUniqueSkillFallbackPath(requested.replaceAll("\\", "/"), [candidate]), candidate);
  });

  it("rejects missing, ambiguous, same-path, and non-SKILL.md matches", () => {
    assert.equal(findUniqueSkillFallbackPath(requested, []), undefined);
    assert.equal(findUniqueSkillFallbackPath(requested, [candidate, String.raw`D:\other\test-case-creator\SKILL.md`]), undefined);
    assert.equal(findUniqueSkillFallbackPath(requested, [requested]), undefined);
    assert.equal(findUniqueSkillFallbackPath(requested.replace("SKILL.md", "README.md"), [candidate]), undefined);
  });
});

describe("read skill path fallback", () => {
  it("reads a unique loaded skill path, annotates the correction, and refreshes the skill snapshot", async () => {
    const actualDirectory = join(directory, ".agents", "skills", "software-skills", "test-case-creator");
    await mkdir(actualDirectory, { recursive: true });
    const actualPath = join(actualDirectory, "SKILL.md");
    await writeFile(actualPath, ["---", "name: test-case-creator", "description: fixture", "---", "Skill body", ""].join("\n"), "utf8");
    const requestedPath = join(directory, ".agents", "skills", "test-case-creator", "SKILL.md");
    const { tools, startAgent } = registerFileToolsForTest();
    const read = tools.find((tool) => tool.name === "read");
    assert.ok(read);

    startAgent([{ filePath: actualPath, disableModelInvocation: true }]);
    const result = await executeRegisteredRead(read, requestedPath, directory);
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    assert.ok(text.includes("[FILE_METADATA]"));
    assert.ok(text.includes("[SKILL_PATH_AUTO_CORRECTED]"));
    assert.ok(!text.includes("[LINE_PREFIX]"));
    assert.ok(text.indexOf("[FILE_METADATA]") < text.indexOf("[SKILL_PATH_AUTO_CORRECTED]"));
    assert.ok(text.indexOf("[SKILL_PATH_AUTO_CORRECTED]") < text.indexOf("1│"));
    const correctionPrefix = "[SKILL_PATH_AUTO_CORRECTED] ";
    const correctionLine = text.split("\n").find((line) => line.startsWith(correctionPrefix));
    assert.ok(correctionLine);
    assert.deepEqual(JSON.parse(correctionLine.slice(correctionPrefix.length)), { requestedPath, actualPath });
    assert.match(text, /Skill body/);
    assert.equal(result.details?.path, actualPath);
    assert.deepEqual(
      { pathAutoCorrected: result.details?.pathAutoCorrected, requestedPath: result.details?.requestedPath },
      { pathAutoCorrected: true, requestedPath },
    );

    startAgent([]);
    await assert.rejects(
      executeRegisteredRead(read, requestedPath, directory),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "FILE_NOT_FOUND",
    );
  });

  it("keeps the original not-found error for ambiguous and non-SKILL.md requests", async () => {
    const { tools, startAgent } = registerFileToolsForTest();
    const read = tools.find((tool) => tool.name === "read");
    assert.ok(read);
    const skillPaths = [
      join(directory, "one", "test-case-creator", "SKILL.md"),
      join(directory, "two", "test-case-creator", "SKILL.md"),
    ];
    startAgent(skillPaths.map((filePath) => ({ filePath })));

    const missingSkillPath = join(directory, "test-case-creator", "SKILL.md");
    await assert.rejects(
      executeRegisteredRead(read, missingSkillPath, directory),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "FILE_NOT_FOUND" && error.payload.path === missingSkillPath,
    );
    await assert.rejects(
      executeRegisteredRead(read, join(directory, "test-case-creator", "README.md"), directory),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "FILE_NOT_FOUND",
    );
  });

  it("does not fall back for filesystem errors other than FILE_NOT_FOUND", async () => {
    const requestedPath = join(directory, "test-case-creator", "SKILL.md");
    await mkdir(requestedPath, { recursive: true });
    const actualPath = join(directory, "software-skills", "test-case-creator", "SKILL.md");
    await mkdir(join(directory, "software-skills", "test-case-creator"), { recursive: true });
    await writeFile(actualPath, "Skill body", "utf8");
    const { tools, startAgent } = registerFileToolsForTest();
    const read = tools.find((tool) => tool.name === "read");
    assert.ok(read);
    startAgent([{ filePath: actualPath }]);

    await assert.rejects(
      executeRegisteredRead(read, requestedPath, directory),
      (error: unknown) => error instanceof FileToolError && error.payload.code !== "FILE_NOT_FOUND",
    );
  });
});

describe("extension registration and argument preparation", () => {
  it("registers read, write, and edit overrides with custom edit rendering", () => {
    const { tools } = registerFileToolsForTest();
    assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "grep", "find", "ls"]);
    const edit = tools.find((tool) => tool.name === "edit");
    assert.equal(typeof edit?.prepareArguments, "function");
    assert.equal(typeof edit?.renderCall, "function");
    assert.equal(typeof edit?.renderResult, "function");
    const guidelines = (edit?.promptGuidelines as string[]).join("\n");
    const readGuidelines = (tools.find((tool) => tool.name === "read")?.promptGuidelines as string[]).join("\n");
    // Full regex rules live only in promptGuidelines; the description stays a one-line purpose.
    assert.doesNotMatch(String(edit?.description), /RegExp|regexFlags|\(\?m\)/);
    assert.match(guidelines, /JavaScript ECMAScript RegExp syntax[^.]*not Python\/PCRE/);
    assert.match(guidelines, /regexFlags='m'.*bare inline flag.*\(\?m\)/);
    assert.match(guidelines, /replaceAll=true/);
    assert.match(guidelines, /sha256After[^.]*expectedHash/);
    assert.doesNotMatch(readGuidelines, /shell rg|fffind|ffgrep/);
    assert.match(readGuidelines, /Use read before edit/);
    assert.match(readGuidelines, /READ_CONTINUATION.*nextOffset/);
    assert.ok((edit?.promptGuidelines as string[]).some((guideline) => guideline.includes("regexFlags") && guideline.includes("never pass g")));
    assert.ok((edit?.promptGuidelines as string[]).some((guideline) => guideline.includes("unique whole-file literal match") && guideline.includes("do not use this fallback")));
  });

  it("renders incomplete streaming edit arguments without undefined or false errors", () => {
    assert.deepEqual(formatEditCallPreview({}), { path: "...", ranges: "..." });
    assert.deepEqual(formatEditCallPreview({ path: "sample.txt" }), { path: "sample.txt", ranges: "..." });
    assert.deepEqual(formatEditCallPreview({ path: "sample.txt", edits: [{}] }), {
      path: "sample.txt",
      ranges: "...",
    });
    assert.deepEqual(formatEditCallPreview({ path: "sample.txt", edits: [{ oldText: "a" }] }), {
      path: "sample.txt",
      ranges: "text:file",
    });
    assert.deepEqual(
      formatEditCallPreview({
        path: "sample.txt",
        edits: [
          { oldText: "a", lineRange: { start: 2, end: 2 } },
          { regex: "a+", lineRange: { start: 5 } },
        ],
      }),
      { path: "sample.txt", ranges: "text:2-2, ..." },
    );
    assert.deepEqual(formatEditCallPreview({ path: "sample.txt", edits: [{ regex: "a+", replaceAll: true }] }), {
      path: "sample.txt",
      ranges: "regex:file/all",
    });
    assert.deepEqual(formatEditCallPreview({ path: "sample.txt", edits: [{ regex: "a+", regexFlags: "im", replaceAll: true }] }), {
      path: "sample.txt",
      ranges: "regex:file/im/all",
    });
  });

  it("formats structured edit errors for TUI while preserving fallback text", () => {
    const errorText = new FileToolError("INVALID_REGEX", "edit.edits[0].regexFlags is invalid.", {
      path: "sample.ts",
      editIndex: 0,
      recovery: "Use each of i, m, s, and u at most once, and only with regex.",
    }).message;
    const display = formatFileToolErrorForDisplay(errorText, true);
    assert.match(display, /✗ Edit failed · INVALID_REGEX/);
    assert.match(display, /Hint: regexFlags accepts only i, m, s, u; omit g and use replaceAll=true/);
    assert.match(display, /Edit: edits\[0\]/);

    const { tools } = registerFileToolsForTest();
    const edit = tools.find((tool) => tool.name === "edit");
    const renderResult = edit?.renderResult as ((result: unknown, options: unknown, theme: unknown, context: unknown) => { render: (width: number) => string[] });
    const component = renderResult(
      { content: [{ type: "text", text: errorText }] },
      {},
      { fg: (_color: string, text: string) => text },
      { lastComponent: undefined, isError: true, expanded: true },
    );
    assert.match(component.render(200).join("\n"), /Edit failed · INVALID_REGEX/);
  });

  it("bounds large edit feedback with a one-line omission summary and keeps the full patch for details", () => {
    const changedRanges = Array.from({ length: 100 }, (_, index) => ({
      editIndex: 0,
      matchIndex: index,
      matchedLineStart: index + 1,
      matchedLineEnd: index + 1,
    }));
    const patch = `--- large.txt\n+++ large.txt\n@@ -1,0 +1,10000 @@\n${"+changed\n".repeat(10_000)}`;
    const feedback = formatEditSuccessFeedback({
      path: "large.txt",
      sha256Before: "a".repeat(64),
      sha256After: "b".repeat(64),
      appliedEdits: 1,
      matchedCount: 100,
      changedCount: 100,
      diff: "",
      patch,
      changedRanges,
    });

    assert.equal(feedback.truncated, false);
    assert.match(feedback.content, /^\[FILE_EDIT_SUCCESS\] \{"sha256After":"b{64}","edits":1,"replacements":100,"added":10000\}\n\[DIFF\]\n@@ /);
    assert.match(feedback.content, /… 9961 more diff line\(s\) omitted$/);
    assert.doesNotMatch(feedback.content, /changedRanges|sha256Before|--- large/);
    assert.ok(feedback.content.length < 1_000);
  });

  it("compacts a patch: trims context, drops headers, bounds line length and counts changes", () => {
    const patch = [
      "--- f.txt", "+++ f.txt", "@@ -1,9 +1,9 @@",
      " c1", " c2", " c3", " c4", "-old", "+new", " c5", " c6", " c7", " c8",
    ].join("\n") + "\n";
    const compact = compactPatch(patch);
    assert.deepEqual({ added: compact.added, removed: compact.removed, omittedLines: compact.omittedLines }, { added: 1, removed: 1, omittedLines: 0 });
    assert.equal(compact.text, ["@@ -4,3 +4,3 @@", " c4", "-old", "+new", " c5"].join("\n"));
    const long = compactPatch(`--- a\n+++ a\n@@ -1 +1 @@\n-x\n+${"y".repeat(500)}\n`);
    assert.match(long.text, /…\[\+301 chars\]/);
  });

  it("normalizes a JSON-string edits payload", () => {
    const prepared = prepareEditArguments({
      path: "sample.txt",
      edits: JSON.stringify([{ lineRange: { start: 1, end: 1 }, oldText: "a", newText: "b" }]),
    });
    assert.deepEqual(prepared.edits, [{ lineRange: { start: 1, end: 1 }, oldText: "a", newText: "b", replaceAll: false, replacementMode: "literal" }]);
  });

  it("normalizes a single edit object and clearly rejects top-level legacy fields", () => {
    const single = prepareEditArguments({
      path: "sample.txt",
      edits: { lineRange: { start: 1, end: 1 }, oldText: "a", newText: "b" },
    });
    assert.equal(single.edits.length, 1);

    assert.throws(
      () => prepareEditArguments({ path: "sample.txt", oldText: "a", newText: "b" }),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_ARGUMENT",
    );
  });

  it("classifies invalid and unknown arguments", () => {
    assert.throws(() => prepareReadArguments({ path: "x", offset: 0 }), FileToolError);
    assert.throws(() => prepareWriteArguments({ path: "x", content: "", extra: true }), FileToolError);
    assert.throws(
      () => prepareEditArguments({ path: "x", edits: [{ lineRange: { start: 2, end: 1 }, oldText: "a", newText: "b" }] }),
      FileToolError,
    );
    assert.throws(
      () => prepareEditArguments({ path: "x", edits: [{ oldText: "a", regex: "a", newText: "b" }] }),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => prepareEditArguments({ path: "x", edits: [{ regex: "a", regexFlags: "g", newText: "b" }] }),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_REGEX",
    );
    assert.throws(
      () => prepareEditArguments({ path: "x", edits: [{ regex: "a".repeat(4097), newText: "b" }] }),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_REGEX",
    );
    assert.throws(
      () => prepareEditArguments({ path: "x", edits: [{ lineStart: 1, lineEnd: 1, oldText: "a", newText: "b" }] }),
      (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => prepareEditArguments({ path: "known.txt", expectedHash: "bad", edits: [{ oldText: "a", newText: "b" }] }),
      (error: unknown) => error instanceof FileToolError && error.payload.path === "known.txt",
    );
  });
});
