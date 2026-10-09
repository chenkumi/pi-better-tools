import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileToolError } from "../src/errors.js";
import {
  executeWithFailureLogging,
  FILE_TOOLS_PROJECT_NAME,
  getFileToolsConfigPath,
  loadFileToolsGlobalConfig,
  prepareWithFailureLogging,
  redactRequestForLog,
} from "../src/debug-logging.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-file-tools-debug-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("file-tools debug logging", () => {
  it("defaults debugLog to false when the global config is absent", () => {
    assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory), { debugLog: false });
  });

  it("loads the project-name debugLog from global settings while ignoring unrelated Pi settings", async () => {
    const configPath = getFileToolsConfigPath(temporaryDirectory);
    await writeFile(configPath, JSON.stringify({ theme: "dark", [FILE_TOOLS_PROJECT_NAME]: { debugLog: true } }), "utf8");
    assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory), { debugLog: true });

    await writeFile(configPath, JSON.stringify({ [FILE_TOOLS_PROJECT_NAME]: { debugLog: false } }), "utf8");
    assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory), { debugLog: false });
    await writeFile(configPath, JSON.stringify({ theme: "dark" }), "utf8");
    assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory), { debugLog: false });
  });

  it("accepts a UTF-8 BOM in global settings like Pi's own settings loader", async () => {
    await writeFile(getFileToolsConfigPath(temporaryDirectory), `﻿${JSON.stringify({ [FILE_TOOLS_PROJECT_NAME]: { debugLog: true } })}`, "utf8");
    assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory), { debugLog: true });
  });

  it("degrades invalid or unreadable settings to debugLog=false with a warning naming the config path", async () => {
    const configPath = getFileToolsConfigPath(temporaryDirectory);
    const cases: Array<() => Promise<void>> = [
      () => writeFile(configPath, JSON.stringify({ [FILE_TOOLS_PROJECT_NAME]: { debugLog: "yes" } }), "utf8"),
      () => writeFile(configPath, "{ not json", "utf8"),
      () => writeFile(configPath, "[]", "utf8"),
      () => writeFile(configPath, JSON.stringify({ [FILE_TOOLS_PROJECT_NAME]: [] }), "utf8"),
      async () => { await rm(configPath, { force: true }); await mkdir(configPath); }, // EISDIR on read
    ];
    for (const setup of cases) {
      await setup();
      const warnings: string[] = [];
      assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory, (message) => warnings.push(message)), { debugLog: false });
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(configPath));
      await rm(configPath, { recursive: true, force: true });
    }
  });

  it("L9 degrades EACCES to debugLog=false rather than failing extension configuration", t => {
    const configPath = getFileToolsConfigPath(temporaryDirectory);
    const original = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
      if (args[0] === configPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const warnings: string[] = [];
      assert.deepEqual(loadFileToolsGlobalConfig(temporaryDirectory, message => warnings.push(message)), { debugLog: false });
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(configPath));
      assert.match(warnings[0], /debugLog=false/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("redacts write/edit payloads to length and SHA-256 in failure logs", async () => {
    const logDirectory = join(temporaryDirectory, "logs");
    const request = { path: "a.txt", content: "secret body", edits: [{ oldText: "old", newText: "new", regexFlags: "g" }] };
    const failure = new FileToolError("STALE_FILE", "stale");
    await assert.rejects(executeWithFailureLogging(true, "write", "call-redact", request, async () => { throw failure; }, logDirectory));
    const [fileName] = await readdir(logDirectory);
    const raw = await readFile(join(logDirectory, fileName), "utf8");
    assert.ok(!raw.includes("secret body"));
    const [record] = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(record.request.content, { redacted: true, length: 11, sha256: createHash("sha256").update("secret body").digest("hex") });
    assert.equal(record.request.path, "a.txt");
    assert.equal(record.request.edits[0].oldText.length, 3);
    assert.equal(record.request.edits[0].newText.redacted, true);
    assert.equal(record.request.edits[0].regexFlags, "g");
  });

  it("redacts stringified edits, deep invalid inputs, cycles and file previews on both failure paths", async () => {
    const secret = "private file contents";
    const nested: Record<string, unknown> = { content: secret };
    nested.self = nested;
    let deep: unknown = nested;
    for (let index = 0; index < 12; index++) deep = { nested: deep };
    assert.doesNotMatch(JSON.stringify(redactRequestForLog(deep)), /private file contents/);
    const logDirectory = join(temporaryDirectory, "logs");
    const request = { path: "file.txt", edits: JSON.stringify([{ oldText: secret, newText: "after" }]), deep };
    const failure = new FileToolError("TEXT_NOT_FOUND_IN_RANGE", "not found", { rangePreview: secret });
    const prepare = prepareWithFailureLogging(true, "edit", () => { throw failure; }, logDirectory);
    assert.throws(() => prepare(request), error => error === failure);
    await assert.rejects(executeWithFailureLogging(true, "edit", "execute", request, async () => { throw failure; }, logDirectory), error => error === failure);
    const [fileName] = await readdir(logDirectory);
    const raw = await readFile(join(logDirectory, fileName), "utf8");
    assert.doesNotMatch(raw, /private file contents/);
    const records = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.request.edits.redacted, true);
      assert.equal(record.result.rangePreview.redacted, true);
      assert.equal(record.result.rangePreview.sha256, createHash("sha256").update(secret).digest("hex"));
    }
  });

  it("does not reintroduce the regex via its syntax error diagnostic", async () => {
    const logDirectory = join(temporaryDirectory, "logs");
    const regex = "private-pattern(";
    let diagnostic = "";
    try { new RegExp(regex); } catch (error) { diagnostic = (error as Error).message; }
    assert.ok(diagnostic.includes(regex));
    const failure = new FileToolError("INVALID_REGEX", diagnostic);
    const prepare = prepareWithFailureLogging(true, "edit", () => { throw failure; }, logDirectory);
    assert.throws(() => prepare({ path: "file.txt", edits: [{ regex, newText: "after" }] }), error => error === failure);
    const [fileName] = await readdir(logDirectory);
    const raw = await readFile(join(logDirectory, fileName), "utf8");
    assert.doesNotMatch(raw, /private-pattern/);
    const record = JSON.parse(raw.trim());
    assert.equal(record.result.code, "INVALID_REGEX");
    assert.equal(record.result.message.redacted, true);
    assert.equal(record.result.message.sha256, createHash("sha256").update(diagnostic).digest("hex"));
  });

  it("logs execution request and structured error result, then rethrows the original error", async () => {
    const logDirectory = join(temporaryDirectory, "logs");
    const request = { path: "missing.txt", content: "debug payload" };
    const failure = new FileToolError("FILE_NOT_FOUND", "Cannot read the target file.", { path: "missing.txt" });

    await assert.rejects(
      executeWithFailureLogging(true, "read", "call-123", request, async () => { throw failure; }, logDirectory),
      (error: unknown) => error === failure,
    );

    const [fileName] = await readdir(logDirectory);
    const [record] = (await readFile(join(logDirectory, fileName), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(record.tool, "read");
    assert.equal(record.toolCallId, "call-123");
    assert.deepEqual(record.request, { path: "missing.txt", content: { redacted: true, length: 13, sha256: createHash("sha256").update("debug payload").digest("hex") } });
    assert.deepEqual(record.result, failure.payload);
    assert.equal(FILE_TOOLS_PROJECT_NAME, "pi-file-tools");
  });

  it("logs argument-preparation failures and keeps logging opt-in", async () => {
    const logDirectory = join(temporaryDirectory, "logs");
    const invalidRequest = { path: "file.txt", edits: [{ regex: "(?m)", newText: "x" }] };
    const failure = new FileToolError("INVALID_REGEX", "Invalid ECMAScript pattern.");
    const prepare = prepareWithFailureLogging(true, "edit", () => { throw failure; }, logDirectory);
    assert.throws(() => prepare(invalidRequest), (error: unknown) => error === failure);

    await assert.rejects(
      executeWithFailureLogging(false, "write", "call-disabled", { path: "x" }, async () => { throw failure; }, logDirectory),
      (error: unknown) => error === failure,
    );

    const [fileName] = await readdir(logDirectory);
    const records = (await readFile(join(logDirectory, fileName), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, "edit");
    assert.equal(records[0].toolCallId, "prepareArguments");
    assert.equal(records[0].request.edits[0].regex.redacted, true);
    assert.equal(records[0].request.path, "file.txt");
    assert.equal(records[0].result.code, "INVALID_REGEX");
  });
});
