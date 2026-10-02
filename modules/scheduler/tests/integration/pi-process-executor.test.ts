import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPiArgs, extractPiErrors, PiProcessExecutor } from "../../src/pi-process-executor.js";
import { nodeChildSpawner, type ChildSpawner } from "../../src/runtime-deps.js";

const directories: string[] = [];

async function fakeSpawner(): Promise<{ spawner: ChildSpawner; seen: string[][] }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-fake-pi-"));
  directories.push(directory);
  const script = join(directory, "fake-pi.mjs");
  await writeFile(script, `
const args = process.argv.slice(2);
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
console.log(JSON.stringify({ args, prompt }));
if (prompt === "fail") { console.error(JSON.stringify({ type: "error", message: "fake failure" })); process.exit(9); }
if (prompt === "wait") setTimeout(() => console.log("done"), 5_000);
else console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }));
`, "utf8");
  const seen: string[][] = [];
  return {
    seen,
    spawner: {
      spawn(request) {
        seen.push([...request.args]);
        const child = spawn(process.execPath, [script, ...request.args], { cwd: request.cwd, env: request.env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.on("error", () => undefined); child.stdin.end(request.stdin);
        return { child, pid: child.pid };
      },
    },
  };
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function request(prompt: string, execution?: { provider?: string; model?: string; thinkingLevel?: "high" }): Parameters<PiProcessExecutor["execute"]>[0] {
  return { runId: "abc", schedule: { cwd: process.cwd(), prompt, execution } };
}

describe("Pi child executor", () => {
  it("bounds pipe draining after parent exit with mocked retained-pipe ownership", async () => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as ChildProcess;
    const executor = new PiProcessExecutor({ resolve: () => ({ command: "mocked-owned-child" }) }, { spawn: () => ({ child, pid: undefined }) });
    const started = executor.start(request("ok"));
    stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\n"); child.emit("exit", 0, null);
    const result = await executor.wait(started); child.emit("close", 0, null);
    expect(result.ownershipUnknown).toBe(true); expect(result.piErrors.join(" ")).toMatch(/pipes did not close/);
  });
  // Windows observed immediate close with inherited Node stdio; do not assert POSIX pipe behavior there.
  it.skipIf(process.platform === "win32")("bounds pipe draining when a self-ending POSIX descendant retains inherited stdio", async () => {
    const script = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{stdio:['ignore',process.stdout,process.stderr]}); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop'}})); process.exit(0);`;
    const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath, args: ["-e", script, "--"] }) }, nodeChildSpawner);
    const start = Date.now(); const { result } = await executor.execute(request("ok"));
    try { expect(result.ownershipUnknown).toBe(true); expect(result.piErrors.join(" ")).toMatch(/pipes did not close/); }
    finally { // Fixture-only descendant self-ends; never kill a bare persisted PID.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 6500 - (Date.now() - start))));
    }
  }, 15_000);
  it("sends leading @ text literally via stdin, not as a CLI attachment", async () => {
    const { spawner, seen } = await fakeSpawner(); const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath }) }, spawner);
    const { result } = await executor.execute(request("@missing-file literal task"));
    expect(result.exitCode).toBe(0); expect(result.piErrors).toEqual([]);
    expect(JSON.parse(result.stdout.split("\n")[0]).prompt).toBe("@missing-file literal task");
    expect(seen[0]).not.toContain("@missing-file literal task");
  });
  it("normalizes and aligns both child agent-directory variables across a saved cwd", async () => {
    const { spawner } = await fakeSpawner(); const spy = vi.spyOn(spawner, "spawn");
    const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath }) }, spawner, undefined, "./relative-agent");
    await executor.execute(request("ok")); const env = spy.mock.calls[0][0].env!;
    expect(env.PI_AGENT_DIR).toBe(resolve("relative-agent")); expect(env.PI_CODING_AGENT_DIR).toBe(env.PI_AGENT_DIR);
  });
  it("bounds retained stream output while still detecting a terminal error after the cap", async () => {
    const script = `for(let i=0;i<256;i++)console.log(JSON.stringify({type:'message_update',data:'x'.repeat(16384)})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'terminal after 4 MiB'}}));`;
    const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath, args: ["-e", script, "--"] }) }, nodeChildSpawner);
    const { result } = await executor.execute(request("ok"));
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024 + 12);
    expect(result.stdout).toContain("[truncated]"); expect(result.piErrors).toContain("terminal after 4 MiB");
  });
  it("does not infer successful work from exit zero without terminal JSON", async () => {
    const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath, args: ["-e", "console.log('no response')", "--"] }) }, nodeChildSpawner);
    const { result } = await executor.execute(request("ok")); expect(result.exitCode).toBe(0); expect(result.piErrors.join(" ")).toMatch(/without a terminal/);
  });
  it("reads final assistant JSON errors without treating recovered tool failures as terminal", () => {
    const error = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider unavailable" } });
    expect(extractPiErrors(error, "")).toEqual(["provider unavailable"]);
    const recovered = error + "\n" + JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    expect(extractPiErrors(recovered, "")).toEqual([]);
    expect(extractPiErrors(JSON.stringify({ type: "tool_execution_end", isError: true }), "")).toEqual([]);
  });
  it("passes no profile, full profile, and thinking-only profile argv to a fake Pi executable", async () => {
    const { spawner, seen } = await fakeSpawner();
    const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath }) }, spawner, () => "2026-09-17T00:00:00.000Z");
    await executor.execute(request("ok"));
    await executor.execute(request("ok", { provider: "openai", model: "gpt-test", thinkingLevel: "high" }));
    await executor.execute(request("ok", { thinkingLevel: "high" }));
    expect(seen[0]).toEqual(buildPiArgs(request("ok")));
    expect(buildPiArgs({ ...request("ok"), schedule: { ...request("ok").schedule, title: "Nightly audit" } })).toContain("Nightly audit");
    expect(seen[1]).toContain("--provider");
    expect(seen[1]).toContain("gpt-test");
    expect(seen[2]).toEqual(expect.arrayContaining(["--thinking", "high"]));
    expect(seen[2]).not.toContain("--provider");
  });

  it("captures non-zero Pi errors and can gracefully terminate an owned child handle", async () => {
    const { spawner } = await fakeSpawner();
    const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath }) }, spawner);
    const failed = await executor.execute(request("fail"));
    expect(failed.result.exitCode).toBe(9);
    expect(failed.result.piErrors).toContain("fake failure");

    const started = executor.start(request("wait"));
    expect(executor.terminate(started)).toBe(true);
    const cancelled = await executor.wait(started);
    expect(cancelled.signal).not.toBeNull();
  });

  it("captures an asynchronous spawn error without rejecting or leaving it unhandled", async () => {
    const executor = new PiProcessExecutor({ resolve: () => ({ command: "pi-scheduler-command-that-does-not-exist" }) }, nodeChildSpawner);

    const { result } = await executor.execute(request("ok"));

    expect(result.exitCode).toBeNull();
    expect(result.piErrors.join(" ")).toMatch(/ENOENT|not found/i);
  });
});
