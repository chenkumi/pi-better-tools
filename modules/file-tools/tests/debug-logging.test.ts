import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("rejects invalid project debugLog values with a config path in the message", async () => {
    const configPath = getFileToolsConfigPath(temporaryDirectory);
    await writeFile(configPath, JSON.stringify({ [FILE_TOOLS_PROJECT_NAME]: { debugLog: "yes" } }), "utf8");
    assert.throws(() => loadFileToolsGlobalConfig(temporaryDirectory), (error: unknown) => error instanceof Error && error.message.includes(configPath));
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
    assert.deepEqual(record.request, request);
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
    assert.deepEqual(records[0].request, invalidRequest);
    assert.equal(records[0].result.code, "INVALID_REGEX");
  });
});
