import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch } from "diff";
import { createDiffFeedback, DIFF_TIMEOUT_MS, DIFF_WORKER_OLD_GENERATION_MB, MAX_DIFF_OUTPUT_BYTES } from "../src/diff-runner.js";
import { FileToolError } from "../src/errors.js";

const childScript = fileURLToPath(new URL("./fixtures/diff-watchdog-child.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

/** The watchdog lives OUTSIDE the process that might regress to synchronous diff. */
async function runIsolated(scenario: string): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), "pi diff watchdog "));
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsxLoader, childScript, scenario, directory], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      let stdout = "";
      let stderr = "";
      let failure: Error | undefined;
      const watchdog = setTimeout(() => {
        failure = new Error(`Independent watchdog expired for ${scenario}; child (and its worker threads) forcibly terminated.`);
        child.kill("SIGKILL");
      }, 15_000);
      const capture = (data: Buffer, stream: "stdout" | "stderr") => {
        if (stream === "stdout") stdout += data.toString();
        else stderr += data.toString();
        if (stdout.length + stderr.length > 64 * 1024) {
          failure ??= new Error("Diff fixture exceeded its diagnostic output budget");
          stdout = stdout.slice(-16 * 1024);
          stderr = stderr.slice(-16 * 1024);
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (data: Buffer) => capture(data, "stdout"));
      child.stderr.on("data", (data: Buffer) => capture(data, "stderr"));
      child.on("error", (error) => { failure ??= error; });
      // Await close, not just a result message: this proves natural process exit and
      // waits for forced termination before the parent removes its temp directory.
      child.on("close", (code, signal) => {
        clearTimeout(watchdog);
        if (failure) return reject(new Error(`${failure.message}\n${stdout}\n${stderr}`));
        try {
          assert.equal(signal, null, stderr);
          assert.equal(code, 0, `${stdout}\n${stderr}`);
          assert.equal(child.exitCode, 0, "child must have exited, not merely produced output");
          const result: Record<string, unknown> = JSON.parse(stdout.trim());
          assert.equal(result.scenario, scenario);
          assert.equal(result.ok, true);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectResourceLimit(action: () => Promise<unknown>) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof FileToolError);
    assert.equal(error.payload.code, "RESULT_TOO_LARGE");
    return true;
  });
}

describe("createDiffFeedback real worker", () => {
  it("exports the fixed production budgets", () => {
    assert.equal(DIFF_TIMEOUT_MS, 2_000);
    assert.equal(DIFF_WORKER_OLD_GENERATION_MB, 256);
    assert.equal(MAX_DIFF_OUTPUT_BYTES, 50 * 1024 * 1024);
  });

  const cases = [
    { name: "whole-file insertion", before: "", after: "one\ntwo\n", display: "+1 one\n+2 two", first: 1 },
    { name: "whole-file deletion", before: "one\ntwo\n", after: "", display: "-1 one\n-2 two", first: 1 },
    { name: "insertion without final newline", before: "", after: "one", display: "+1 one", first: 1 },
    { name: "deletion without final newline", before: "one", after: "", display: "-1 one", first: 1 },
    { name: "replacement with newline", before: "alpha\nbeta\n", after: "alpha\nBETA\n", display: " 1 alpha\n-2 beta\n+2 BETA", first: 2 },
    { name: "EOF replacement", before: "a\nb", after: "a\nB", display: " 1 a\n-2 b\n+2 B", first: 2 },
    { name: "adding an EOF newline", before: "tail", after: "tail\n", display: "-1 tail\n+1 tail", first: 1 },
    { name: "removing an EOF newline", before: "tail\n", after: "tail", display: "-1 tail\n+1 tail", first: 1 },
    { name: "middle insertion uses new numbers only on additions", before: "a\nc\nd\n", after: "a\nb\nc\nd\n", display: " 1 a\n+2 b\n 2 c\n 3 d", first: 2 },
    { name: "middle deletion preserves old context numbers", before: "a\nb\nc\nd\n", after: "a\nc\nd\n", display: " 1 a\n-2 b\n 3 c\n 4 d", first: 2 },
    { name: "tail deletion uses the new insertion point", before: "a\nb\n", after: "a\n", display: " 1 a\n-2 b", first: 2 },
    { name: "newline-only insertion", before: "\n", after: "\n\n", display: " 1 \n+2 ", first: 2 },
    { name: "blank lines and Unicode", before: "😀\n\nold", after: "😀\n\n新", display: " 1 😀\n 2 \n-3 old\n+3 新", first: 3 },
    { name: "unchanged contents", before: "same\n", after: "same\n", display: "", first: undefined },
    { name: "empty contents", before: "", after: "", display: "", first: undefined },
  ];
  for (const example of cases) {
    it(`applies an equivalent patch and preserves display for ${example.name}`, async () => {
      const result = await createDiffFeedback(example.before, example.after, "sample.txt");
      assert.equal(applyPatch(example.before, result.patch), example.after);
      assert.equal(result.diff, example.display);
      assert.equal(result.firstChangedLine, example.first);
      assert.ok(result.patch.startsWith("--- sample.txt\n+++ sample.txt\n"));
      assert.doesNotMatch(result.patch, /^Index:/m);
      assert.doesNotMatch(result.diff, /No newline at end of file/);
    });
  }

  it("keeps trailing-newline line-count width at a decimal boundary", async () => {
    const after = "x\n".repeat(9);
    const result = await createDiffFeedback("", after, "width.txt");
    assert.equal(result.diff, Array.from({ length: 9 }, (_, index) => `+ ${index + 1} x`).join("\n"));
    assert.equal(applyPatch("", result.patch), after);
  });

  it("formats zero-length hunk starts for patches without shifting display coordinates", async () => {
    const insert = await createDiffFeedback("", "x\n", "sample.txt");
    const remove = await createDiffFeedback("x\n", "", "sample.txt");
    assert.match(insert.patch, /@@ -0,0 \+1,1 @@/);
    assert.match(remove.patch, /@@ -1,1 \+0,0 @@/);
    assert.equal(insert.diff, "+1 x");
    assert.equal(remove.diff, "-1 x");
    assert.equal(insert.firstChangedLine, 1);
    assert.equal(remove.firstChangedLine, 1);
  });

  it("does not count EOF annotations when numbering removed and added lines", async () => {
    const result = await createDiffFeedback("a\nb", "a\nB\nC", "sample.txt");
    assert.equal(result.diff, " 1 a\n-2 b\n+2 B\n+3 C");
    assert.equal(result.firstChangedLine, 2);
    assert.equal((result.patch.match(/\\ No newline at end of file/g) ?? []).length, 2);
    assert.equal(applyPatch("a\nb", result.patch), "a\nB\nC");
  });

  it("preserves four context lines, gaps, width, and independent old/new positions across hunks", async () => {
    const oldLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines.splice(7, 1, "changed8", "extra9");
    newLines[22] = "changed23";
    const before = oldLines.join("\n") + "\n";
    const after = newLines.join("\n") + "\n";
    const result = await createDiffFeedback(before, after, "multiple.txt");
    assert.equal(applyPatch(before, result.patch), after);
    assert.equal(result.firstChangedLine, 8);
    assert.equal(parsePatch(result.patch)[0].hunks.length, 2);
    assert.equal(result.diff, [
      "    …", "  4 line 4", "  5 line 5", "  6 line 6", "  7 line 7",
      "- 8 line 8", "+ 8 changed8", "+ 9 extra9",
      "  9 line 9", " 10 line 10", " 11 line 11", " 12 line 12", "    …",
      " 18 line 18", " 19 line 19", " 20 line 20", " 21 line 21",
      "-22 line 22", "+23 changed23",
      " 23 line 23", " 24 line 24", " 25 line 25", " 26 line 26", "    …",
    ].join("\n"));
  });

  for (const distance of [8, 9]) {
    it(`merges only overlapping context when changes have ${distance} unchanged lines between them`, async () => {
      const middle = Array.from({ length: distance }, (_, index) => `common ${index}`).join("\n");
      const before = `old-first\n${middle}\nold-last\n`;
      const after = `new-first\n${middle}\nnew-last\n`;
      const result = await createDiffFeedback(before, after, "context.txt");
      assert.equal(applyPatch(before, result.patch), after);
      assert.equal(parsePatch(result.patch)[0].hunks.length, distance === 8 ? 1 : 2);
      assert.equal((result.diff.match(/…/g) ?? []).length, distance === 8 ? 0 : 1);
    });
  }

  it("enforces the exact combined UTF-8 output limit, including patch EOF annotations and headers", async () => {
    const before = "😀\nold";
    const after = "😀\n新";
    const path = "unicode 文件.txt";
    const reference = await createDiffFeedback(before, after, path);
    const bytes = Buffer.byteLength(reference.diff, "utf8") + Buffer.byteLength(reference.patch, "utf8");
    assert.ok(bytes > reference.diff.length + reference.patch.length);
    assert.deepEqual(await createDiffFeedback(before, after, path, undefined, { maxOutputBytes: bytes }), reference);
    await expectResourceLimit(() => createDiffFeedback(before, after, path, undefined, { maxOutputBytes: bytes - 1 }));
    await expectResourceLimit(() => createDiffFeedback("", "", "header-only.txt", undefined, { maxOutputBytes: 0 }));
  });
});

describe("diff lifecycle under an independent subprocess watchdog", () => {
  it("resolves the plain JS worker relative to the module from a different cwd containing spaces", { timeout: 20_000 }, async () => {
    const result = await runIsolated("different-cwd");
    assert.equal(result.firstChangedLine, 1);
    assert.match(String(result.cwd), /pi diff watchdog /);
  });
});
