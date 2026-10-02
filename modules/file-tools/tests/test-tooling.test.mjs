import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { runCommand, runNpm } from "../scripts/test-process.mjs";
import { cleanupTestResources } from "../scripts/test-cleanup.mjs";

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("test process output separates stdout from diagnostics", async () => {
  const result = await runCommand("fixture stdout", process.execPath, ["-e", 'console.log("result"); console.error("diagnostic");'], { quiet: true, timeoutMs: 3000 });
  assert.equal(result.trim(), "result");
});

test("test process nonzero exit remains observable", async () => {
  await assert.rejects(() => runCommand("fixture exit", process.execPath, ["-e", 'console.error("fixture failure"); process.exit(3);'], { quiet: true, timeoutMs: 3000 }), /exited 3[\s\S]*fixture failure/);
});

test("test process timeout terminates a live root", { timeout: 15000 }, async () => {
  const started = performance.now();
  await assert.rejects(() => runCommand("fixture timeout", process.execPath, ["-e", 'setInterval(() => console.log("Fixture still running..."), 100);'], { quiet: true, timeoutMs: 500 }), /timed out/);
  assert.ok(performance.now() - started < 12000);
});

test("test process bounds output instead of accumulating indefinitely", { timeout: 15000 }, async () => {
  await assert.rejects(() => runCommand("fixture output limit", process.execPath, ["-e", 'process.stdout.write("x".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);'], { quiet: true, timeoutMs: 5000 }), /output exceeded 4 MiB/);
});

test("exited-root descendants and missing close notifications cannot keep the watchdog waiting forever", { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi process lifecycle "));
  const pidFile = join(root, "fixture-pids.json");
  let childPid;
  const code = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','process.stdout.on("error",()=>{}); setInterval(() => console.log("Fixture descendant still running..."),100); process.send("ready");'],{stdio:['ignore','inherit','inherit','ipc']}); child.once('message',()=>{ writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid})); child.disconnect(); child.unref(); process.exit(0); });`;
  const started = performance.now();
  // POSIX naturally retains inherited pipe descriptors. On this Windows Node
  // build, pipe closure is immediate; inject only the missing close notification
  // while keeping real root/descendant processes and real termination actions.
  const spawnProcess = process.platform !== "win32" ? spawn : (...args) => {
    const child = spawn(...args);
    const once = child.once.bind(child);
    child.once = (event, listener) => event === "close" ? child : once(event, listener);
    return child;
  };
  try {
    await assert.rejects(() => runCommand("fixture orphan pipe", process.execPath, ["-e", code, pidFile], { quiet: true, timeoutMs: 3000, spawnProcess }), /timed out/);
    childPid = JSON.parse(await readFile(pidFile, "utf8")).child;
    assert.ok(performance.now() - started < 14000, "Termination wait must also be bounded");
    assert.equal(alive(childPid), false, "Known fixture descendant must be terminated, not merely disconnected");
  } finally {
    if (!childPid) {
      try { childPid = JSON.parse(await readFile(pidFile, "utf8")).child; } catch {}
    }
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("npm can be located without npm_execpath for direct Windows node --test", async () => {
  const original = process.env.npm_execpath;
  delete process.env.npm_execpath;
  try {
    const version = await runNpm("fixture direct npm", ["--version"], { quiet: true, timeoutMs: 10000 });
    assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    if (original === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = original;
  }
});

test("cleanup failure still runs later environment restoration and is not reported as complete", async () => {
  const ran = [];
  await assert.rejects(() => cleanupTestResources([
    ["simulated locked workspace", () => { ran.push("workspace"); throw Object.assign(new Error("locked"), { code: "EBUSY" }); }],
    ["restore environment", () => { ran.push("restore"); }],
  ]), error => error instanceof AggregateError && error.errors[0].cause.code === "EBUSY");
  assert.deepEqual(ran, ["workspace", "restore"]);
});

test("cleanup failure is reported without masking the primary test error", async t => {
  const warning = t.mock.method(console, "error", () => {});
  const primary = new Error("primary fixture error");
  let restored = false;
  await assert.rejects(async () => {
    try { throw primary; } finally {
      const result = await cleanupTestResources([
        ["workspace", () => { throw new Error("cleanup fixture error"); }],
        ["restore environment", () => { restored = true; }],
      ], primary);
      assert.equal(result.status, "incomplete");
    }
  }, error => error === primary);
  assert.equal(restored, true);
  assert.equal(warning.mock.calls.length, 1);
});
