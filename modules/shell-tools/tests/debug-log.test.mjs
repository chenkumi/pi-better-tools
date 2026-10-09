import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_LOG_TEXT_CHARS, PROJECT_NAME, writeFailureDebugLog } from "../src/debug-log.mjs";

function fixture(t, settings) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-debug-unit-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const settingsDir = path.join(homeDir, ".pi", "agent");
  const settingsPath = path.join(settingsDir, "settings.json");
  const logsDir = path.join(homeDir, ".pi", "logs", "pi-shell-tools");
  function writeSettings(value) {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(value));
  }
  if (settings !== undefined) writeSettings(settings);
  return { homeDir, settingsPath, logsDir, writeSettings };
}

function record(overrides = {}) {
  return {
    tool: "bash", toolCallId: "test-call", cwd: "/test/workspace", sessionId: "test-session",
    elapsedMs: 12, input: { command: "exit 7", timeoutMs: 20000 },
    failure: { kind: "exception", error: new Error("test failure") }, ...overrides,
  };
}
const enabled = { "pi-shell-tools": { debugLog: true } };

test("debug logs use the requested pi-shell-tools namespace and contain diagnostic context", async (t) => {
  assert.equal(PROJECT_NAME, "pi-shell-tools");
  const f = fixture(t, enabled);
  const file = await writeFailureDebugLog(record(), { homeDir: f.homeDir });
  assert.equal(path.dirname(file), f.logsDir);
  assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}T.*-[0-9A-HJKMNP-TV-Z]{26}\.json$/);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.project, "pi-shell-tools");
  assert.equal(value.tool, "bash");
  assert.equal(value.toolCallId, "test-call");
  assert.equal(value.cwd, "/test/workspace");
  assert.equal(value.sessionId, "test-session");
  assert.equal(value.elapsedMs, 12);
  assert.equal(value.processId, process.pid);
  assert.ok(Number.isFinite(Date.parse(value.timestamp)));
  assert.deepEqual(value.input, { command: "exit 7", timeoutMs: 20000 });
  assert.equal(value.failure.kind, "exception");
  assert.equal(value.failure.error.name, "Error");
  assert.equal(value.failure.error.message, "test failure");
  assert.match(value.failure.error.stack, /debug-log\.test\.mjs/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.logsDir).mode & 0o777, 0o700);
  }
});

test("only literal true in the correct namespace opts in; disabled logs create no directory", async (t) => {
  const f = fixture(t);
  for (const settings of [
    {}, null, [], { debugLog: true }, { "pi-shell-timeout-ms": { debugLog: true } },
    ...[undefined, false, null, 1, "true", {}].map((debugLog) => ({ "pi-shell-tools": { debugLog } })),
  ]) {
    f.writeSettings(settings);
    assert.equal(await writeFailureDebugLog(record(), { homeDir: f.homeDir }), undefined);
    assert.equal(fs.existsSync(path.join(f.homeDir, ".pi", "logs")), false);
  }
});

test("missing, invalid JSON, and unreadable settings cannot opt in or break callers", async (t) => {
  const f = fixture(t);
  assert.equal(await writeFailureDebugLog(record(), { homeDir: f.homeDir }), undefined);
  f.writeSettings(enabled);
  fs.writeFileSync(f.settingsPath, '{"pi-shell-tools":');
  assert.equal(await writeFailureDebugLog(record(), { homeDir: f.homeDir }), undefined);
  fs.rmSync(f.settingsPath);
  fs.mkdirSync(f.settingsPath); // reading a directory is not a usable settings file
  assert.equal(await writeFailureDebugLog(record(), { homeDir: f.homeDir }), undefined);
  assert.equal(fs.existsSync(f.logsDir), false);
});

test("UTF-8 BOM settings files are supported", async (t) => {
  const f = fixture(t, enabled);
  fs.writeFileSync(f.settingsPath, "\uFEFF" + JSON.stringify(enabled));
  const file = await writeFailureDebugLog(record(), { homeDir: f.homeDir });
  assert.ok(fs.existsSync(file));
});

test("the debug switch is reread for each failure without reload or cached opt-in", async (t) => {
  const f = fixture(t, enabled);
  assert.ok(await writeFailureDebugLog(record(), { homeDir: f.homeDir }));
  f.writeSettings({ "pi-shell-tools": { debugLog: false } });
  assert.equal(await writeFailureDebugLog(record(), { homeDir: f.homeDir }), undefined);
  assert.equal(fs.readdirSync(f.logsDir).length, 1);
  f.writeSettings(enabled);
  assert.ok(await writeFailureDebugLog(record(), { homeDir: f.homeDir }));
  assert.equal(fs.readdirSync(f.logsDir).length, 2);
});

test("error causes, circular inputs, BigInt, and invalid numbers remain traceable", async (t) => {
  const f = fixture(t, enabled);
  const input = { command: "exit 1", timeoutMs: NaN, big: 3n };
  input.self = input;
  const error = new TypeError("bad input");
  error.code = "TEST_ERROR";
  error.cause = error;
  const file = await writeFailureDebugLog(record({ input, failure: { kind: "exception", error } }), { homeDir: f.homeDir });
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(value.input.self, "[Circular]");
  assert.equal(value.input.big, "3n");
  assert.equal(value.input.timeoutMs, "NaN");
  assert.equal(value.failure.error.code, "TEST_ERROR");
  assert.equal(value.failure.error.name, "TypeError");
  assert.equal(value.failure.error.cause, "[Circular]");
});

test("long command/output strings retain head and tail with an explicit omission marker", async (t) => {
  const f = fixture(t, enabled);
  assert.equal(MAX_LOG_TEXT_CHARS, 65_536);
  const head = "BEGIN_" + "0123456789".repeat(3276) + "ab";
  const middle = "hidden_middle".repeat(1024);
  const tail = "wxyz" + "9876543210".repeat(3276) + "_END";
  assert.equal(head.length, 32_768);
  assert.equal(tail.length, 32_768);
  const output = head + middle + tail;
  const result = { isError: true, structuredContent: { exit_code: 7, output } };
  const file = await writeFailureDebugLog(record({ failure: { kind: "error-result", result } }), { homeDir: f.homeDir });
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const saved = value.failure.result.structuredContent.output;
  assert.equal(saved, `${head}\n[... ${middle.length} characters omitted ...]\n${tail}`);
  assert.equal(value.failure.result.structuredContent.exit_code, 7);
  assert.equal(result.structuredContent.output, output, "logging must not mutate the result");
});

test("filesystem logging failures are nonfatal and never overwrite an existing blocker", async (t) => {
  const f = fixture(t, enabled);
  const blocker = path.join(f.homeDir, ".pi", "logs");
  fs.writeFileSync(blocker, "do not overwrite");
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await writeFailureDebugLog(record(), { homeDir: f.homeDir }), undefined);
  assert.equal(fs.readFileSync(blocker, "utf8"), "do not overwrite");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /pi-shell-tools.*Could not write/);
});

test("serialization and host console failures still cannot escape the debug logger", async (t) => {
  const f = fixture(t, enabled);
  t.mock.method(console, "warn", () => { throw new Error("console unavailable"); });
  const input = { get command() { throw new Error("unreadable diagnostic input"); } };
  assert.equal(await writeFailureDebugLog(record({ input }), { homeDir: f.homeDir }), undefined);
  assert.equal(fs.existsSync(f.logsDir), false);
});
