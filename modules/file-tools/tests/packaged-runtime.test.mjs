import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { test } from "node:test";
import { parsePackManifest, runCommand, runNpm } from "../scripts/test-process.mjs";
import { cleanupTestResources } from "../scripts/test-cleanup.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const host = dirname(dirname(fileURLToPath(hostEntry)));
const sdk = await import(hostEntry);
// Version-coupled probes stay in test tooling, never in the shipped extension.
const hostModule = path => import(pathToFileURL(join(host, "dist", path)).href);
const hostVersion = JSON.parse(await readFile(join(host, "package.json"), "utf8")).version;
const textOf = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

function tinyPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

test(`packaged extension with real Pi ${hostVersion} loader`, { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi packaged runtime "));
  const workspace = join(root, "different cwd");
  const extracted = join(root, "package with spaces");
  const packageRoot = join(extracted, "package");
  const agentDir = join(root, "isolated agent");
  const oldEnvironment = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY"].map(name => [name, process.env[name]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
  const pulse = setInterval(() => console.log("Packaged runtime verification still running..."), 10000);
  let linked = false;
  let loaded;
  let runner;
  let primaryError;
  try {
    await Promise.all([workspace, extracted, agentDir].map(path => mkdir(path, { recursive: true })));
    const expectedPackage = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    const manifest = parsePackManifest(await runNpm("npm pack", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: project, quiet: true, timeoutMs: 60000 }), expectedPackage);
    assert.ok(manifest.files.some(file => file.path === "src/diff-worker.mjs"));
    assert.ok(!manifest.files.some(file => /^(tests|scripts|issues|node_modules)\//.test(file.path)));
    await runCommand("extract package", "tar", ["-xzf", join(root, manifest.filename), "-C", extracted], { timeoutMs: 30000 });
    // Source-module regression uses the shared development tree; the root production smoke installs real dependencies.
    await symlink(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    linked = true;
    loaded = await sdk.discoverAndLoadExtensions([packageRoot], workspace, agentDir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const definitions = [...loaded.extensions[0].tools.values()].map(tool => tool.definition);
    assert.deepEqual(definitions.map(tool => tool.name), ["read", "write", "edit"]);
    const context = { cwd: workspace };
    const direct = async (name, args, signal) => {
      const definition = definitions.find(tool => tool.name === name);
      const prepared = await definition.prepareArguments(args);
      return definition.execute("packaged-test", prepared, signal, undefined, context);
    };

    await t.test("declares advisory annotations without changing output contracts", () => {
      assert.deepEqual(definitions[0].annotations, { readOnlyHint: true, openWorldHint: false });
      for (const tool of definitions.slice(1)) assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
      assert.ok(definitions.every(tool => tool.outputSchema === undefined && (tool.exposure ?? "direct") === "direct"));
    });

    await t.test("packed read/write/edit and diff worker resolve URL and Windows shell targets", async () => {
      const target = join(workspace, "target #.txt");
      const shell = "/" + target.replaceAll("\\", "/").replace(":", "");
      const paths = [pathToFileURL(target).href, ...(process.platform === "win32" ? [shell, "/mnt" + shell, "/cygdrive" + shell] : [])];
      for (const path of paths) {
        await direct("write", { path, content: "alpha\nbeta\n", expectedHash: null });
        const read = await direct("read", { path, offset: null, limit: null });
        assert.match(textOf(read), /1│alpha/);
        const edit = await direct("edit", { path, expectedHash: read.details.sha256, edits: [{ oldText: "beta", newText: "BETA" }] });
        assert.match(textOf(edit), /FILE_EDIT_SUCCESS/);
        assert.match(textOf(edit), /\+BETA/);
        assert.equal(await readFile(target, "utf8"), "alpha\nBETA\n");
      }
    });

    await t.test("BM text remains model-visible and genuine PNG still attaches", async () => {
      await writeFile(join(workspace, "bm.txt"), "BM plain markdown text\nThis is not a bitmap.\n");
      const text = await direct("read", { path: "bm.txt" });
      assert.match(textOf(text), /2│This is not a bitmap\./);
      assert.equal(text.details.sha256.length, 32);
      await writeFile(join(workspace, "pixel.png"), tinyPng());
      const image = await direct("read", { path: "pixel.png" });
      assert.ok(image.content.some(block => block.type === "image" && block.mimeType === "image/png"));
    });

    const advanced = typeof sdk.createCodemodeExtension === "function";
    if (["0.99.1", "0.99.2", "1.0.0"].includes(hostVersion)) assert.equal(advanced, true, `Pi ${hostVersion} must execute the advanced probes, not silently skip them`);
    const events = [];
    let tools;
    let parallelSuccess;
    if (advanced) {
      const { wrapToolDefinition } = await hostModule("core/tools/tool-definition-wrapper.js");
      const { NestedToolCallRunner } = await hostModule("core/nested-tool-calls.js");
      const agentPackage = findPackageJSON("@earendil-works/pi-agent-core", hostEntry);
      assert.ok(agentPackage);
      const { runToolCall } = await import(pathToFileURL(join(dirname(agentPackage), "dist/index.js")).href);
      tools = definitions.map(tool => wrapToolDefinition(tool, () => context));
      const assistantMessage = { role: "assistant", content: [], api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse", timestamp: 0 };
      runner = new NestedToolCallRunner({
        getTools: () => tools,
        isSequential: () => false,
        runToolCall: (call, _parent, signal, onUpdate) => runToolCall(call, {
          tools, assistantMessage, context: { messages: [], tools }, signal, onUpdate,
          beforeToolCall: async ({ toolCall }) => toolCall.arguments.path === "blocked.txt" ? { block: true, reason: "test permission block" } : undefined,
        }),
        emit: async event => { events.push(event); },
      });
    }
    const call = (name, args, options) => runner.execute("pipeline-parent", name, args, options);

    await t.test("real nested pipeline normalizes arguments and serializes guarded mutations", { skip: !advanced && "Pi 0.86.1 has no nested/codemode runtime" }, async () => {
      await call("write", { path: "parallel.txt", content: "original", expectedHash: "missing" });
      const read = await call("read", { path: "parallel.txt", offset: null, limit: null });
      assert.equal(read.isError, false);
      const token = read.result.details.sha256;
      const edits = await Promise.all(["first", "second"].map(newText => call("edit", { path: "parallel.txt", expectedHash: token, edits: [{ oldText: "original", newText }] })));
      assert.equal(edits.filter(result => !result.isError).length, 1);
      assert.equal(edits.filter(result => result.isError).length, 1);
      assert.match(textOf(edits.find(result => result.isError).result), /STALE_FILE/);
      parallelSuccess = edits.find(result => !result.isError).result;
      const bytes = await readFile(join(workspace, "parallel.txt"), "utf8");
      assert.ok(["first", "second"].includes(bytes));
      const stale = await call("write", { path: "parallel.txt", content: "unsafe", expectedHash: token });
      assert.equal(stale.isError, true);
      assert.equal(await readFile(join(workspace, "parallel.txt"), "utf8"), bytes);
    });

    await t.test("permission block, schema failure and pre-abort cannot commit", { skip: !advanced }, async () => {
      const blocked = await call("write", { path: "blocked.txt", content: "no" });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked.result), /test permission block/);
      await assert.rejects(() => readFile(join(workspace, "blocked.txt")), { code: "ENOENT" });
      const invalid = await call("edit", { path: "parallel.txt", edits: [{ oldText: "first", newText: null }] });
      assert.equal(invalid.isError, true);
      assert.match(textOf(invalid.result), /INVALID_ARGUMENT/);
      const abort = new AbortController(); abort.abort();
      const aborted = await call("write", { path: "aborted.txt", content: "no" }, { signal: abort.signal });
      assert.equal(aborted.isError, true);
      await assert.rejects(() => readFile(join(workspace, "aborted.txt")), { code: "ENOENT" });
      assert.ok(events.length > 0 && events.every(event => event.parentToolCallId === "pipeline-parent"));
    });

    await t.test("QuickJS codemode preserves text return type and nested file tracking", { skip: !advanced }, async () => {
      const { executeCodemode } = await hostModule("extensions/codemode/execute.js");
      const { createFileOps, extractFileOpsFromMessage, computeFileLists } = await hostModule("core/compaction/utils.js");
      const result = await executeCodemode("codemode-parent", { code: 'const r = await tools.read({ path: "bm.txt", offset: null, limit: null }); text({ type: typeof r, metadata: r.includes("[FILE_METADATA]"), body: r.includes("This is not a bitmap.") });' }, undefined, undefined, {
        cwd: workspace, tools, sessionManager: { getBranch: () => [] },
        executeTool: (name, args, options) => runner.execute("codemode-parent", name, args, options),
      });
      assert.notEqual(result.isError, true);
      assert.match(textOf(result), /"type":"string"/);
      assert.match(textOf(result), /"metadata":true/);
      assert.match(textOf(result), /"body":true/);
      const record = runner.takeRecord("codemode-parent");
      assert.ok(record?.calls);
      const ops = createFileOps();
      extractFileOpsFromMessage({ role: "toolResult", nestedCalls: record.calls }, ops);
      assert.deepEqual(computeFileLists(ops), { readFiles: ["bm.txt"], modifiedFiles: [] });
    });

    await t.test("built-in read and custom edit renderers preserve model-visible content", { skip: !advanced }, async () => {
      const { withBuiltInRenderers } = await hostModule("core/tools/renderers/index.js");
      const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, italic: text => text };
      const args = { path: "bm.txt", offset: null, limit: null };
      const renderContext = { cwd: workspace, args, expanded: true, showImages: false, isError: false, argsComplete: true, isPartial: false, executionStarted: true };
      const readRender = withBuiltInRenderers("read", definitions[0]);
      assert.ok(!readRender.renderCall(args, theme, renderContext).render(100).join("\n").includes(":1"));
      const before = JSON.stringify(parallelSuccess.content);
      const rendered = definitions[2].renderResult(parallelSuccess, { expanded: true, isPartial: false }, theme, renderContext).render(100).join("\n");
      assert.match(rendered, /Applied 1 edit/);
      assert.equal(JSON.stringify(parallelSuccess.content), before);
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanup = await cleanupTestResources([
      ["progress", () => clearInterval(pulse)],
      ["nested runner", () => runner?.clear()],
      ["extension runtime", () => loaded?.runtime.invalidate?.()],
      ["dependency link", async () => { if (linked) await unlink(join(packageRoot, "node_modules")); }],
      ["workspace", () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })],
      ["environment", () => {
        for (const [name, value] of Object.entries(oldEnvironment)) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
      }],
    ], primaryError);
    console.log(`Packaged runtime cleanup ${cleanup.status}.`);
  }
});
