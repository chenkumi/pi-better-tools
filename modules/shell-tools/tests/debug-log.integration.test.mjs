import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createPiFixture, text } from "./helpers/pi-fixture.mjs";

const shellNames = process.platform === "win32" ? ["bash", "powershell"] : ["bash"];
const timeout = 60_000;
const enabled = { "pi-shell-tools": { debugLog: true } };
let fixture;
let heartbeat;

before(async () => {
  heartbeat = setInterval(() => console.log("Debug logging integration verification in progress..."), 5000);
  fixture = await createPiFixture();
});
beforeEach(() => {
  fixture.writeDebugSettings({});
  fs.rmSync(path.join(fixture.homeDir, ".pi", "logs"), { recursive: true, force: true });
});
afterEach(() => fixture?.disposeSessions());
after(() => {
  clearInterval(heartbeat);
  console.log("Cleaning up isolated debug logs, home directory, and Pi sessions...");
  fixture?.cleanup();
});

function logs() {
  const directory = path.join(fixture.homeDir, ".pi", "logs", "pi-shell-tools");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
}
async function shellSession(options = {}) {
  return fixture.createSession({ tools: shellNames, ...options });
}
function nonzeroCommand(name, code = 7) {
  return name === "bash" ? `printf FAILURE_OUTPUT; exit ${code}` : `Write-Output FAILURE_OUTPUT; exit ${code}`;
}

test("successful real shells do not create debug logs even when enabled", { timeout }, async () => {
  fixture.writeDebugSettings(enabled);
  const { session } = await shellSession();
  for (const name of shellNames) {
    const command = name === "bash" ? "printf SUCCESS_OK" : "Write-Output SUCCESS_OK";
    const result = await fixture.execute(session, name, { command, timeoutMs: 5000 });
    assert.equal(result.structuredContent.exit_code, 0);
    assert.match(result.structuredContent.output, /SUCCESS_OK/);
  }
  assert.deepEqual(logs(), []);
  assert.equal(fs.existsSync(path.join(fixture.homeDir, ".pi", "logs")), false);
});

test("isError results create one log per real shell failure with original millisecond input", { timeout }, async () => {
  fixture.writeDebugSettings(enabled);
  const { session, cwd } = await shellSession();
  for (const name of shellNames) {
    const command = nonzeroCommand(name);
    const result = await fixture.execute(session, name, { command, timeoutMs: 5000 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.exit_code, 7);
    const record = logs().find((record) => record.tool === name);
    assert.ok(record);
    assert.equal(record.project, "pi-shell-tools");
    assert.equal(record.cwd, cwd);
    assert.equal(record.sessionId, session.sessionManager.getSessionId());
    assert.match(record.toolCallId, /^test-/);
    assert.ok(record.elapsedMs >= 0);
    assert.deepEqual(record.input, { command, timeoutMs: 5000 });
    assert.equal(record.failure.kind, "error-result");
    assert.equal(record.failure.result.isError, true);
    assert.deepEqual(record.failure.result.structuredContent, result.structuredContent);
    assert.match(record.failure.result.structuredContent.output, /FAILURE_OUTPUT/);
  }
  assert.equal(logs().length, shellNames.length);
});

test("adapter validation and missing-context exceptions are logged without changing errors", { timeout }, async () => {
  fixture.writeDebugSettings(enabled);
  const { session } = await shellSession();
  await assert.rejects(fixture.execute(session, "bash", { command: "printf MUST_NOT_RUN", timeoutMs: 0 }),
    (error) => error instanceof TypeError && error.message === "timeoutMs must be a positive integer in milliseconds");
  await assert.rejects(fixture.execute(session, "bash", { command: "printf MUST_NOT_RUN", timeout: 3 }), /no longer accepts timeout/);
  await assert.rejects(session.getToolDefinition("bash").execute("no-context", { command: "echo forbidden" }, undefined, undefined, undefined),
    /Pi did not provide the shell tool execution context/);
  const records = logs();
  assert.equal(records.length, 3);
  assert.ok(records.every((record) => record.failure.kind === "exception"));
  const invalid = records.find((record) => record.input.timeoutMs === 0);
  assert.equal(invalid.failure.error.name, "TypeError");
  assert.match(invalid.failure.error.stack, /timeout-ms\.mjs/);
  assert.equal(records.find((record) => record.toolCallId === "no-context").cwd, undefined);
});

test("cancelled running shells still finish writing their debug logs", { timeout }, async () => {
  fixture.writeDebugSettings(enabled);
  const { session } = await shellSession();
  for (const name of shellNames) {
    const controller = new AbortController();
    let observedReady = false;
    const command = name === "bash"
      ? "printf 'DEBUG_ABORT_READY\\n'; sleep 2"
      : "Write-Output DEBUG_ABORT_READY; Start-Sleep -Seconds 2";
    await assert.rejects(fixture.execute(session, name, { command }, {
      signal: controller.signal,
      onUpdate(update) {
        if (text(update).includes("DEBUG_ABORT_READY")) {
          observedReady = true;
          controller.abort();
        }
      },
    }), /Command aborted/);
    assert.equal(observedReady, true);
    const record = logs().find((record) => record.tool === name);
    assert.equal(record.failure.kind, "exception");
    assert.match(record.failure.error.message, /Command aborted/);
  }
  assert.equal(logs().length, shellNames.length);
});

test("only ~/.pi/agent/settings.json controls logging, not SDK/project/agentDir settings", { timeout }, async () => {
  const memory = await shellSession({ settings: enabled, globalSettings: enabled });
  assert.equal(memory.settingsManager.getSettings()["pi-shell-tools"].debugLog, true);
  await fixture.execute(memory.session, "bash", { command: "exit 7", timeoutMs: 3000 });
  assert.deepEqual(logs(), [], "memory or alternate agentDir debug flags must not opt in");

  const disk = await shellSession({
    disk: true, trusted: true,
    globalSettings: { "pi-shell-tools": { debugLog: false } },
    projectSettings: enabled,
  });
  assert.equal(disk.settingsManager.getSettings()["pi-shell-tools"].debugLog, true,
    "the host must actually merge the trusted project flag from disk");
  await fixture.execute(disk.session, "bash", { command: "exit 7", timeoutMs: 3000 });
  assert.deepEqual(logs(), [], "even genuinely merged project settings must not opt in");

  fixture.writeDebugSettings(enabled);
  const other = await shellSession({
    disk: true, trusted: true,
    globalSettings: enabled,
    projectSettings: { "pi-shell-tools": { debugLog: false } },
  });
  assert.equal(other.settingsManager.getSettings()["pi-shell-tools"].debugLog, false,
    "the host must actually merge the opposite project flag from disk");
  await fixture.execute(other.session, "bash", { command: "exit 7", timeoutMs: 3000 });
  assert.equal(logs().length, 1, "global home opt-in must not be overridden by session/project settings");
});

test("live global debug flag changes affect the next failure without extension reload", { timeout }, async () => {
  const { session } = await shellSession();
  const input = { command: "exit 7", timeoutMs: 3000 };
  await fixture.execute(session, "bash", input);
  assert.equal(logs().length, 0);
  fixture.writeDebugSettings({ "pi-shell-timeout-ms": { debugLog: true } });
  await fixture.execute(session, "bash", input);
  assert.equal(logs().length, 0, "old package-name namespace must not enable logs");
  fixture.writeDebugSettings(enabled);
  await fixture.execute(session, "bash", input);
  assert.equal(logs().length, 1);
  fixture.writeDebugSettings({ "pi-shell-tools": { debugLog: false } });
  await fixture.execute(session, "bash", input);
  assert.equal(logs().length, 1);
});

test("failed log writes preserve both structured errors and thrown tool exceptions", { timeout }, async (t) => {
  fixture.writeDebugSettings(enabled);
  const blocker = path.join(fixture.homeDir, ".pi", "logs");
  fs.writeFileSync(blocker, "existing blocker");
  t.mock.method(console, "warn", () => { throw new Error("host console unavailable"); });
  const { session } = await shellSession();
  const result = await fixture.execute(session, "bash", { command: "exit 7", timeoutMs: 3000 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.exit_code, 7);
  await assert.rejects(fixture.execute(session, "bash", { command: "exit 0", timeoutMs: 0 }),
    (error) => error instanceof TypeError && error.message === "timeoutMs must be a positive integer in milliseconds");
  assert.equal(fs.readFileSync(blocker, "utf8"), "existing blocker");
});

test("codemode parallel failing shells each log once while returning structured exit data", { timeout }, async () => {
  fixture.writeDebugSettings(enabled);
  const { session } = await shellSession({ codemode: true, tools: [...shellNames, "codemode"] });
  const calls = [
    'tools.bash({command: "exit 7", timeoutMs: 3000})',
    'tools.bash({command: "exit 8", timeoutMs: 3000})',
    ...(shellNames.includes("powershell") ? ['tools.powershell({command: "exit 9", timeoutMs: 5000})'] : []),
  ];
  const result = await fixture.execute(session, "codemode", {
    code: `const results = await Promise.all([${calls.join(",")}]); for (const result of results) text({exitCode: result.exit_code});`,
  });
  assert.ok(!result.isError, text(result));
  assert.match(text(result), /exitCode.*7/);
  assert.match(text(result), /exitCode.*8/);
  const records = logs();
  assert.equal(records.length, calls.length);
  assert.equal(new Set(records.map((record) => record.toolCallId)).size, calls.length);
  assert.ok(records.every((record) => record.sessionId === session.sessionManager.getSessionId()));
  assert.deepEqual(records.map((record) => record.failure.result.structuredContent.exit_code).sort(),
    shellNames.includes("powershell") ? [7, 8, 9] : [7, 8]);
});
