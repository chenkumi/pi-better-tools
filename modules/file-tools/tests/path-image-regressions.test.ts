import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import fileToolsExtension, { detectImageMime } from "../extensions/file-tools.js";
import { normalizeToolPath, resolveToolPath } from "../src/path-utils.js";
import { FileToolError } from "../src/errors.js";
import { hintMissingSubagentLog } from "../src/subagent-log-paths.js";

function toolsAt(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  fileToolsExtension({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: () => {} } as unknown as ExtensionAPI);
  return async (name: string, args: unknown) => {
    const tool = tools.get(name)!;
    const prepared = tool.prepareArguments ? await tool.prepareArguments(args) : args;
    return tool.execute("regression", prepared as never, undefined, undefined, { cwd } as never);
  };
}

function tinyBmp(): Buffer {
  // BITMAPINFOHEADER, 1 x 1, uncompressed 24-bit BGR, padded to four bytes.
  const buffer = Buffer.alloc(58);
  buffer.write("BM");
  buffer.writeUInt32LE(58, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(4, 34);
  buffer[56] = 255;
  return buffer;
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof toolsAt>>>): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

async function inWorkspace(action: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi path image regression "));
  try { await action(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

describe("COMPAT-001 shared path adapter", () => {
  it("preserves relative, absolute, @, unicode spaces and tilde behavior", () => {
    const cwd = resolve("fixture workspace");
    assert.equal(resolveToolPath("@nested/a\u202fb.txt", cwd), join(cwd, "nested", "a b.txt"));
    assert.equal(resolveToolPath(join(cwd, "absolute.txt"), cwd), join(cwd, "absolute.txt"));
    assert.equal(normalizeToolPath("~"), homedir());
    assert.equal(resolveToolPath("~/child.txt", cwd), join(homedir(), "child.txt"));
    assert.equal(resolveToolPath("~\\child.txt", cwd), join(homedir(), "child.txt"));
  });

  it("prefers an existing literal path over the @ / unicode-space rewrite", async () => {
    await inWorkspace(async root => {
      await mkdir(join(root, "@scope"));
      await writeFile(join(root, "@scope", "x.txt"), "x");
      await writeFile(join(root, "shot 1.png"), "x");
      assert.equal(resolveToolPath("@scope/x.txt", root), join(root, "@scope", "x.txt"));
      assert.equal(resolveToolPath("shot 1.png", root), join(root, "shot 1.png"));
      assert.equal(resolveToolPath("shot 2.png", root), join(root, "shot 2.png"));
    });
  });

  it("preserves literal cwd characters while normalizing input paths", async () => {
    assert.equal(resolveToolPath("child.txt", "@literal cwd"), resolve("@literal cwd", "child.txt"));
    await inWorkspace(async root => {
      const cwd = join(root, "unicode\u202fspace");
      const wrongCwd = join(root, "unicode space");
      await Promise.all([cwd, wrongCwd].map(path => mkdir(path)));
      await writeFile(join(cwd, "child.txt"), "correct");
      await writeFile(join(wrongCwd, "child.txt"), "decoy");
      assert.equal(resolveToolPath("child.txt", cwd), join(cwd, "child.txt"));
      assert.equal(resolveToolPath("child.txt", pathToFileURL(cwd).href), join(cwd, "child.txt"));
      const call = toolsAt(cwd);
      const read = await call("read", { path: "child.txt" });
      assert.match(textOf(read), /1│correct/);
      const edit = await call("edit", { path: "child.txt", expectedHash: (read.details as { sha256: string }).sha256, edits: [{ oldText: "correct", newText: "edited" }] });
      await call("write", { path: "child.txt", content: "written", expectedHash: (edit.details as { sha256After: string }).sha256After });
      assert.equal(await readFile(join(cwd, "child.txt"), "utf8"), "written");
      assert.equal(await readFile(join(wrongCwd, "child.txt"), "utf8"), "decoy");
    });
  });

  it("decodes file URLs with spaces, unicode, percent and hash characters exactly once", () => {
    const target = resolve("space ü", "100% #.txt");
    assert.equal(resolveToolPath(pathToFileURL(target).href, resolve("other cwd")), target);
    assert.equal(resolveToolPath("@" + pathToFileURL(target).href, resolve("other cwd")), target);
  });

  it("rejects malformed file URLs instead of resolving them as relative filenames", () => {
    assert.throws(() => resolveToolPath("file:///bad%ZZ.txt", process.cwd()));
    assert.throws(() => resolveToolPath("file:///bad%2Fname.txt", process.cwd()));
  });

  for (const input of ["/c/Users/A/file.txt", "/C/Users/A/file.txt", "/mnt/c/Users/A/file.txt", "/mnt/C/Users/A/file.txt", "/cygdrive/c/Users/A/file.txt", "/cygdrive/C/Users/A/file.txt", "/c", "/mnt/C/", "/cygdrive/c"]) {
    it(`normalizes Windows shell path ${input}`, { skip: process.platform !== "win32" }, () => {
      const target = input.includes("Users") ? "C:\\Users\\A\\file.txt" : "C:\\";
      assert.equal(resolveToolPath(input, "D:\\different cwd"), target);
    });
  }

  it("preserves Windows UNC, native drives and ordinary root-relative paths", { skip: process.platform !== "win32" }, () => {
    assert.equal(resolveToolPath("//server/share/file.txt", "D:\\cwd"), "\\\\server\\share\\file.txt");
    assert.equal(resolveToolPath("\\\\server\\share\\file.txt", "D:\\cwd"), "\\\\server\\share\\file.txt");
    assert.equal(resolveToolPath("C:\\native\\file.txt", "D:\\cwd"), "C:\\native\\file.txt");
    assert.equal(normalizeToolPath("/usr/local/file.txt"), "/usr/local/file.txt");
    assert.equal(normalizeToolPath("/c/mixed\\path.txt"), "/c/mixed\\path.txt");
  });

  it("uses a normalized Windows shell cwd for relative paths", { skip: process.platform !== "win32" }, () => {
    assert.equal(resolveToolPath("child.txt", "/mnt/c/workspace"), "C:\\workspace\\child.txt");
  });

  it("does not reinterpret POSIX /c or /mnt/c paths as Windows drives", { skip: process.platform === "win32" }, () => {
    assert.equal(resolveToolPath("/c/file.txt", "/different cwd"), "/c/file.txt");
    assert.equal(resolveToolPath("/mnt/c/file.txt", "/different cwd"), "/mnt/c/file.txt");
  });

  it("read/write/edit use the same URL and shell targets without touching decoys", async () => {
    await inWorkspace(async cwd => {
      const call = toolsAt(cwd);
      const target = join(cwd, "correct target #.txt");
      const decoy = join(cwd, "decoy.txt");
      await writeFile(decoy, "untouched");
      const slash = target.replaceAll("\\", "/");
      const shell = "/" + slash.replace(":", "");
      const variants = [pathToFileURL(target).href, ...(process.platform === "win32" ? [shell, "/mnt" + shell, "/cygdrive" + shell] : [])];
      for (const path of variants) {
        const created = await call("write", { path, content: "before" });
        assert.match(textOf(created), /FILE_WRITE_SUCCESS/);
        const read = await call("read", { path, offset: null, limit: null });
        assert.match(textOf(read), /1│before/);
        const token = (read.details as { sha256: string }).sha256;
        await call("edit", { path, expectedHash: token, edits: [{ oldText: "before", newText: "after" }] });
        assert.equal(await readFile(target, "utf8"), "after");
        assert.equal(await readFile(decoy, "utf8"), "untouched");
      }
    });
  });
});

describe("subagent live transcript rename recovery", () => {
  const sessionId = "01m45czjs2j8x53wc4ecpyjge4";
  const taskId = "01m45czjs2vtq8kqxqbpd8ecsf";
  const runAt = (cwd: string) => join(cwd, "subagent-sessions", sessionId, "runs", taskId);

  it("reads a live transcript, then hints the renamed file without returning its contents", async () => {
    await inWorkspace(async cwd => {
      const run = runAt(cwd); await mkdir(run, { recursive: true });
      const partial = join(run, "transcript.jsonl.partial"), final = join(run, "transcript.jsonl");
      const content = '{"type":"assistant","content":"PRIVATE_LOG_SENTINEL"}\n';
      await writeFile(partial, content);
      const call = toolsAt(cwd);
      assert.match(textOf(await call("read", { path: partial })), /PRIVATE_LOG_SENTINEL/);
      await rename(partial, final);
      await assert.rejects(call("read", { path: partial, offset: 1 }), (error: unknown) => {
        assert.ok(error instanceof FileToolError);
        assert.equal(error.payload.code, "FILE_NOT_FOUND");
        assert.equal(error.payload.path, partial);
        assert.ok(error.payload.recovery?.includes(JSON.stringify(final)));
        assert.match(error.payload.recovery!, /not proof the job completed/);
        assert.ok(!error.message.includes("PRIVATE_LOG_SENTINEL"));
        return true;
      });
      assert.match(textOf(await call("read", { path: final })), /PRIVATE_LOG_SENTINEL/);
    });
  });

  it("offers notification guidance when neither path exists", async () => {
    await inWorkspace(async cwd => {
      const path = join(runAt(cwd), "transcript.jsonl.partial");
      await assert.rejects(toolsAt(cwd)("read", { path }), (error: unknown) => {
        assert.ok(error instanceof FileToolError);
        assert.match(error.payload.recovery!, /Wait for the background job notification/);
        assert.equal(error.payload.code, "FILE_NOT_FOUND"); return true;
      });
    });
  });

  it("does not guess ordinary .partial files, malformed IDs, or other filenames", async () => {
    const original = new FileToolError("FILE_NOT_FOUND", "missing", { recovery: "original" });
    for (const path of [resolve("transcript.jsonl.partial"), join(runAt(resolve("fixture")), "other.partial"),
      resolve("subagent-sessions", "not-an-id", "runs", taskId, "transcript.jsonl.partial")]) {
      assert.equal(await hintMissingSubagentLog(original, path, async () => { assert.fail("must not probe unrelated paths"); }), original);
    }
  });

  it("does not reinterpret permission errors, unreadable candidates, or failed probes", async () => {
    const path = join(runAt(resolve("fixture")), "transcript.jsonl.partial");
    const permission = new FileToolError("FILE_NOT_READABLE", "denied", { causeCode: "EACCES" });
    assert.equal(await hintMissingSubagentLog(permission, path, async () => { assert.fail("must not probe on permission error"); }), permission);
    const original = new FileToolError("FILE_NOT_FOUND", "missing");
    assert.equal(await hintMissingSubagentLog(original, path, async () => ({ isFile: () => false })), original);
    assert.equal(await hintMissingSubagentLog(original, path, async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }), original);
  });
});

describe("COMPAT-002 BMP snapshot classification", () => {
  for (const text of ["BM", "BM plain markdown text\nThis is not a bitmap.\n", "BM" + "x".repeat(160), "GIF is a text prefix, not an image."]) {
    it(`reads ordinary text ${JSON.stringify(text.slice(0, 30))} rather than omitting it as an image`, async () => {
      await inWorkspace(async cwd => {
        await writeFile(join(cwd, "plain.txt"), text);
        const result = await toolsAt(cwd)("read", { path: "plain.txt" });
        assert.equal(result.content.some(block => block.type === "image"), false);
        assert.match(textOf(result), /FILE_METADATA/);
        assert.ok(textOf(result).includes(text.split("\n")[0]));
        assert.equal((result.details as { sha256: string }).sha256.length, 32);
      });
    });
  }

  const malformedHeaders: Array<[string, (buffer: Buffer) => Buffer]> = [
    ["truncated signature", buffer => buffer.subarray(0, 2)],
    ["truncated DIB fields", buffer => buffer.subarray(0, 29)],
    ["invalid declared size", buffer => { buffer.writeUInt32LE(25, 2); return buffer; }],
    ["pixels overlap DIB", buffer => { buffer.writeUInt32LE(53, 10); return buffer; }],
    ["pixels beyond declared size", buffer => { buffer.writeUInt32LE(58, 10); return buffer; }],
    ["unknown DIB size", buffer => { buffer.writeUInt32LE(13, 14); return buffer; }],
    ["oversized DIB", buffer => { buffer.writeUInt32LE(125, 14); return buffer; }],
    ["invalid color planes", buffer => { buffer.writeUInt16LE(2, 26); return buffer; }],
    ["unsupported bit depth", buffer => { buffer.writeUInt16LE(3, 28); return buffer; }],
    ["high-bit signature is not ASCII BM", buffer => { buffer[0] = 0xc2; buffer[1] = 0xcd; return buffer; }],
  ];
  for (const [name, corrupt] of malformedHeaders) {
    it(`does not classify malformed BMP: ${name}`, () => {
      assert.equal(detectImageMime(corrupt(tinyBmp())), undefined);
    });
  }

  it("recognizes supported BMP DIB variants from the supplied buffer", () => {
    for (const dibSize of [12, 40, 52, 56, 108, 124]) {
      const pixelOffset = 14 + dibSize;
      const buffer = Buffer.alloc(pixelOffset + 4);
      buffer.write("BM");
      buffer.writeUInt32LE(buffer.length, 2);
      buffer.writeUInt32LE(pixelOffset, 10);
      buffer.writeUInt32LE(dibSize, 14);
      buffer.writeUInt16LE(1, dibSize === 12 ? 22 : 26);
      buffer.writeUInt16LE(24, dibSize === 12 ? 24 : 28);
      assert.equal(detectImageMime(buffer), "image/bmp", `DIB ${dibSize}`);
      buffer.writeUInt32LE(0, 2); // Pi also accepts an unspecified declared size.
      assert.equal(detectImageMime(buffer), "image/bmp");
    }
  });

  it("still delegates a genuine BMP image to Pi", async () => {
    await inWorkspace(async cwd => {
      await writeFile(join(cwd, "pixel.bmp"), tinyBmp());
      const result = await toolsAt(cwd)("read", { path: "pixel.bmp" });
      assert.ok(result.content.some(block => block.type === "image"));
      assert.ok(!textOf(result).includes("FILE_METADATA"));
    });
  });
});

describe("compact model-visible success output", () => {
  it("write and edit return single-line metadata while full details stay structured", async () => {
    await inWorkspace(async cwd => {
      const call = toolsAt(cwd);
      const created = await call("write", { path: "n.txt", content: "a\nb\nc\n", expectedHash: "missing" });
      const writeText = textOf(created);
      assert.match(writeText, /^\[FILE_WRITE_SUCCESS\] \{"sha256":"[0-9a-f]{32}","bytes":6,"created":true\}$/);
      assert.deepEqual(created.details, { path: "n.txt", sha256: (created.details as { sha256: string }).sha256, bytes: 6, created: true });

      const edit = await call("edit", { path: "n.txt", expectedHash: (created.details as { sha256: string }).sha256, edits: [{ oldText: "b", newText: "B" }] });
      const editText = textOf(edit);
      assert.match(editText, /^\[FILE_EDIT_SUCCESS\] \{"sha256After":"[0-9a-f]{32}","edits":1,"added":1,"removed":1\}\n\[DIFF\]\n@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c$/);
      const details = edit.details as { sha256After: string; diff: string; patch: string; added: number; removed: number };
      assert.equal(details.added, 1);
      assert.equal(details.removed, 1);
      assert.ok(details.diff.length > 0 && details.patch.includes("--- "));
      assert.ok(!editText.includes("sha256Before") && !editText.includes("changedRanges"));
    });
  });
});
