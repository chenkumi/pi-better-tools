import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Compile } from "typebox/compile";
import { describe, it } from "node:test";
import fileToolsExtension, { prepareEditArguments, prepareReadArguments, prepareWriteArguments } from "../extensions/file-tools.js";
import { FileToolError } from "../src/errors.js";
import { editTextFile } from "../src/file-operations.js";

// Resolve from the installed host, whether npm hoists pi-ai or nests it.
const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const piAiPackage = findPackageJSON("@earendil-works/pi-ai", hostEntry);
assert.ok(piAiPackage, "The installed host must provide pi-ai");
const piAi = join(dirname(piAiPackage), "dist/api/openai-responses-shared.js");
const { convertResponsesTools } = await import(pathToFileURL(piAi).href);

function registeredTools(): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  fileToolsExtension({
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
    on: () => () => {},
  } as never);
  return tools;
}

describe("search overrides and Pi 1.1 read output", () => {
  it("registers only read/write/edit/ls, leaving grep/find to host or FFF", () => {
    assert.deepEqual(registeredTools().map(tool => tool.name), ["read", "write", "edit", "ls"]);
  });

  it("returns precise read text as structuredContent and normalizes search optional arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi search overrides "));
    try {
      await writeFile(join(root, "sample.txt"), "needle\nother\n");
      const tools = registeredTools() as any[];
      const invoke = async (name: string, args: unknown, signal?: AbortSignal) => {
        const tool = tools.find(tool => tool.name === name);
        assert.ok(tool);
        const prepared = await tool.prepareArguments(args);
        return tool.execute("test", prepared, signal, undefined, { cwd: root });
      };
      const read = await invoke("read", { path: "sample.txt" });
      assert.ok(tools.find(tool => tool.name === "read").outputSchema);
      assert.equal(read.structuredContent, read.content[0].text);
      for (const name of ["ls"]) {
        const args = { path: null, limit: null };
        const tool = tools.find(tool => tool.name === name);
        const prepared = tool.prepareArguments(args);
        assert.equal(prepared.path, undefined);
        assert.equal(prepared.limit, undefined);
        assert.equal(args.path, null);
        assert.equal(tool.defaultActive, false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function invalidArgument(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_ARGUMENT");
}

describe("strict provider optional-null compatibility", () => {
  it("normalizes null optionals for every registered tool without mutating caller arguments", () => {
    const tools = registeredTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "ls"]);
    const strictValidators = new Map(tools.map((tool) => {
      const [providerTool] = convertResponsesTools([tool], {
        strict: null,
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: false,
      });
      assert.equal(providerTool.strict, true);
      return [String(tool.name), Compile(providerTool.parameters)];
    }));

    const compactToken = "a".repeat(32);
    const legacyHash = "b".repeat(64);
    assert.equal(strictValidators.get("write")!.Check({ path: "x", content: "y", expectedHash: compactToken }), true);
    assert.equal(strictValidators.get("write")!.Check({ path: "x", content: "y", expectedHash: legacyHash }), true);
    const editWithNullOptionals = { oldText: "a", regex: null, regexFlags: null, newText: "b", lineRange: null, replaceAll: null, replacementMode: null };
    assert.equal(strictValidators.get("edit")!.Check({ path: "x", expectedHash: compactToken, edits: [editWithNullOptionals] }), true);
    assert.equal(strictValidators.get("edit")!.Check({ path: "x", expectedHash: "a".repeat(16), edits: [editWithNullOptionals] }), false);

    const readArgs = { path: "sample.txt", offset: null, limit: null };
    assert.equal(strictValidators.get("read")!.Check(readArgs), true);
    assert.deepEqual(prepareReadArguments(readArgs), { path: "sample.txt", offset: undefined, limit: undefined });
    assert.deepEqual(readArgs, { path: "sample.txt", offset: null, limit: null });

    const writeArgs = { path: "sample.txt", content: "content", expectedHash: null };
    assert.equal(strictValidators.get("write")!.Check(writeArgs), true);
    assert.deepEqual(prepareWriteArguments(writeArgs), { path: "sample.txt", content: "content", expectedHash: undefined });
    assert.deepEqual(writeArgs, { path: "sample.txt", content: "content", expectedHash: null });

    const editArgs = {
      path: "sample.txt",
      expectedHash: null,
      edits: [{ oldText: "before", regex: null, regexFlags: null, newText: "after", lineRange: null, replaceAll: null, replacementMode: null }],
    };
    assert.equal(strictValidators.get("edit")!.Check(editArgs), true);
    assert.deepEqual(prepareEditArguments(editArgs), {
      path: "sample.txt",
      expectedHash: undefined,
      edits: [{ oldText: "before", newText: "after", replaceAll: false, replacementMode: "literal" }],
    });
    assert.deepEqual(editArgs.edits[0], {
      oldText: "before", regex: null, regexFlags: null, newText: "after", lineRange: null, replaceAll: null, replacementMode: null,
    });
  });

  it("treats null lineRange as omitted whole-file search and null flags as absent", async () => {
    const prepared = prepareEditArguments({
      path: "sample.txt",
      edits: [{ oldText: "needle", newText: "replacement", lineRange: null, regexFlags: null }],
    });
    assert.equal(prepared.edits[0].lineRange, undefined);
    assert.equal(prepared.edits[0].regexFlags, undefined);
    assert.equal(prepared.edits[0].oldText, "needle");

    // Explicitly verify the scope consequence against an isolated file: null means
    // exactly the same whole-file search behavior as an omitted lineRange.
    const directory = await mkdtemp(join(tmpdir(), "pi null optional range "));
    const path = join(directory, "sample.txt");
    try {
      await writeFile(path, "first\nneedle\nlast", "utf8");
      await editTextFile(path, "sample.txt", prepared.edits);
      assert.equal(await readFile(path, "utf8"), "first\nreplacement\nlast");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses regex-specific optional defaults after null normalization", () => {
    const prepared = prepareEditArguments({
      path: "sample.txt",
      expectedHash: null,
      edits: [{ oldText: null, regex: "(?<value>needle)", regexFlags: null, newText: "$<value>", lineRange: null, replaceAll: null, replacementMode: null }],
    });
    assert.equal(prepared.expectedHash, undefined);
    assert.deepEqual(prepared.edits, [{
      regex: "(?<value>needle)", newText: "$<value>", replaceAll: false, replacementMode: "literal",
    }]);
  });

  it("still rejects null for required fields and required members inside lineRange", () => {
    invalidArgument(() => prepareReadArguments({ path: null, offset: null, limit: null }));
    invalidArgument(() => prepareWriteArguments({ path: "sample.txt", content: null, expectedHash: null }));
    invalidArgument(() => prepareEditArguments({ path: "sample.txt", expectedHash: null, edits: [{ oldText: "a", newText: null }] }));
    invalidArgument(() => prepareEditArguments({ path: "sample.txt", edits: [{ oldText: "a", newText: "b", lineRange: { start: null, end: 2 } }] }));
    invalidArgument(() => prepareEditArguments({ path: "sample.txt", edits: [{ oldText: null, regex: null, newText: "b" }] }));
  });
});
