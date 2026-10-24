import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import shell from "../extensions/timeout-ms.ts";
import { ShellJobs } from "../src/background-jobs.ts";
import { MAX_TIMEOUT_MS, timeoutMsToSeconds } from "../src/timeout-ms.mjs";

const slot = globalThis as any;
const ctxOf = (id: string) => ({ cwd: "/workspace", sessionManager: { getSessionId: () => id }, isIdle: () => true, hasPendingMessages: () => false }) as any;
const success = (output: string) => ({ content: [{ type: "text", text: output }], details: undefined, structuredContent: { output, exit_code: 0 } }) as any;
const boundary = () => new Promise(resolve => setImmediate(resolve));
const message = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as Error).message; } throw new Error("expected throw"); };
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected reject"); }, (error: Error) => error.message);

function mainTools() {
  const tools: any[] = [];
  const pi = { registerTool: (t: any) => tools.push(t), on() {}, registerToolRenderer() {}, registerMessageRenderer() {}, registerCommand() {}, getSettings: () => ({}) } as any;
  const saved = slot.__piSubagentsGuardExpected; delete slot.__piSubagentsGuardExpected;
  shell(pi);
  if (saved !== undefined) slot.__piSubagentsGuardExpected = saved;
  return Object.fromEntries(tools.map(t => [t.name, t]));
}

// Agent-facing text may name tool args and tool names, never settings keys, environment variable names or settings paths.
const FORBIDDEN = /pi-shell-tools|pi-pty-terminal|pi-gpt-speed|autoBackgroundMs|detachOnSteer|debugLog|settings\.json|\bPI_[A-Z]|\.pi\/(?!logs)/;

test("tool definitions, receipts and errors never name settings keys or environment variables", async () => {
  const tools = mainTools();
  assert.doesNotMatch(JSON.stringify(Object.values(tools).map((t: any) => ({ d: t.description, g: t.promptGuidelines, s: t.promptSnippet, p: t.parameters }))), FORBIDDEN);
  const run = (input: any) => rejection(tools.bash.execute("t", input, undefined, undefined, ctxOf("owner")));
  for (const input of [{ command: "x", background: "yes" }, { command: 5 }, {}, { command: "x", timeoutMs: -1 }]) assert.doesNotMatch(await run(input), FORBIDDEN);
  assert.doesNotMatch(await rejection(tools.shell_job_status.execute("t", { jobId: "nope" }, undefined, undefined, ctxOf("owner"))), FORBIDDEN);
});

test("timeoutMs validation names parameter, rule, received value and valid range", () => {
  for (const [value, shown] of [[0, "0"], [-1, "-1"], [1.5, "1.5"], [NaN, "NaN"], ["20000", 'string "20000"']] as const) {
    const text = message(() => timeoutMsToSeconds(value as any));
    assert.match(text, /timeoutMs must be a positive integer/);
    assert.ok(text.includes("between 1 and 2147483647"), text);
    assert.ok(text.includes(`received ${shown}`), text);
    assert.match(text, /20000 = 20 seconds/);
  }
  const over = message(() => timeoutMsToSeconds(MAX_TIMEOUT_MS + 1));
  assert.ok(over.includes(`must not exceed ${MAX_TIMEOUT_MS}`) && over.includes(`received ${MAX_TIMEOUT_MS + 1}`) && /omit timeoutMs/i.test(over), over);
});

test("direct bash input errors state rule, received type and fix", async () => {
  const { bash } = mainTools();
  const run = (input: any) => rejection(bash.execute("t", input, undefined, undefined, ctxOf("owner")));
  const bg = await run({ command: "x", background: "yes" });
  assert.match(bg, /background must be a boolean/); assert.match(bg, /received string "yes"/); assert.match(bg, /omit/i);
  const cmd = await run({ command: 5 });
  assert.match(cmd, /command is required and must be a string/); assert.match(cmd, /received number/);
  const missing = await run({});
  assert.match(missing, /received undefined/);
  const noCtx = await rejection(bash.execute("t", { command: "x" }, undefined, undefined, undefined));
  assert.match(noCtx, /execution context/); assert.match(noCtx, /not run/); assert.match(noCtx, /retry/i);
});

test("shell_job_cancel/status validate jobId with an actionable message", async () => {
  const tools = mainTools();
  for (const bad of [undefined, "", 7]) {
    const text = await rejection(tools.shell_job_cancel.execute("t", { jobId: bad }, undefined, undefined, ctxOf("owner")));
    assert.match(text, /jobId is required/); assert.match(text, /shell_job_status/); assert.match(text, /no arguments/);
  }
  const status = await rejection(tools.shell_job_status.execute("t", { jobId: "" }, undefined, undefined, ctxOf("owner")));
  assert.match(status, /jobId must not be empty/); assert.match(status, /omit jobId/);
  assert.ok(tools.shell_job_cancel.parameters.properties.jobId.description, "cancel jobId has a description");
  assert.deepEqual(tools.shell_job_cancel.parameters.required, ["jobId"]);
});

test("managed foreground-only rejection says to remove background", async context => {
  context.mock.method(fsPromises, "stat", async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  syncBuiltinESMExports();
  const old = process.env.PI_SUBAGENTS_GUARD, saved = slot.__piSubagentsGuardExpected;
  try {
    delete slot.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "managed", cwd: "/workspace", startupPath: "/startup", shellMode: "foreground-v1" });
    const tools: any[] = [];
    shell({ registerTool: (t: any) => tools.push(t), on() {}, registerToolRenderer() {}, registerMessageRenderer() {}, registerCommand() {}, getSettings() { return {}; } } as any);
    const text = await rejection(tools[0].execute("t", { command: "x", background: true }, undefined, undefined, ctxOf("managed")));
    assert.match(text, /foreground-only/); assert.match(text, /Remove the background parameter/); assert.match(text, /timeoutMs/);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = old;
    if (saved === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = saved;
    context.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("owner, shutdown and unknown-job errors carry a fix hint and known ids", async () => {
  const jobs = new ShellJobs({ sendMessage() {} } as any);
  const ctx = ctxOf("owner"); jobs.start(ctx);
  let release!: () => void;
  try {
    const receipt = jobs.submit(ctx, "bash", "c1", undefined, async () => { await new Promise<void>(r => { release = r; }); return success("ok"); }, "sleeping-command");
    await boundary();
    const foreign = message(() => jobs.status(ctxOf("other"), receipt.jobId));
    assert.match(foreign, /different owner session/); assert.match(foreign, /shell_job_status with no arguments/);
    const missing = message(() => jobs.status(ctx, "NOPE"));
    assert.match(missing, /Shell job NOPE/); assert.match(missing, /shell_job_status with no arguments/);
    assert.ok(missing.includes(receipt.jobId) && missing.includes("sleeping-command"), missing);
    assert.match(missing, /do not survive/i);
    const aborted = new AbortController(); aborted.abort();
    const abortText = message(() => jobs.submit(ctx, "bash", "c2", aborted.signal, async () => success("x")));
    assert.match(abortText, /aborted before background acceptance/); assert.match(abortText, /nothing was run/i);
    release(); await boundary(); await boundary();
    await jobs.shutdown();
    const down = message(() => jobs.status(ctx, receipt.jobId));
    assert.match(down, /shutting down/); assert.match(down, /do not retry/i);
  } finally { release?.(); await jobs.shutdown(); }
});

test("owner disposed message tells how to proceed", async () => {
  const jobs = new ShellJobs({ sendMessage() {} } as any);
  let id = "owner"; const ctx = { sessionManager: { getSessionId: () => id } } as any;
  jobs.start(ctx); id = "replaced";
  try {
    const text = message(() => jobs.status(ctx, "X"));
    assert.match(text, /disposed or replaced/); assert.match(text, /current session/); assert.match(text, /without background/);
  } finally { await jobs.shutdown(); }
});

test("onAccepted failures are wrapped with operation and consequence", async () => {
  const jobs = new ShellJobs({ sendMessage() {} } as any);
  const ctx = ctxOf("owner"); jobs.start(ctx);
  try {
    const text = message(() => jobs.submit(ctx, "bash", "c", undefined, async () => success("x"), "cmd", () => { throw Object.assign(new Error("EACCES: /secret/raw/path"), { code: "EACCES" }); }));
    assert.match(text, /Background job could not be started/); assert.match(text, /command was not run/i); assert.match(text, /foreground/i);
    assert.doesNotMatch(text, /\/secret\/raw\/path/);
    assert.equal(jobs.list(ctx).length, 0);
  } finally { await jobs.shutdown(); }
});

test("live log failures say output is incomplete and give the log path, not raw errors", async () => {
  const jobs = new ShellJobs({ sendMessage() {} } as any);
  const ctx = ctxOf("owner"); jobs.start(ctx);
  try {
    const receipt = jobs.submit(ctx, "bash", "c", undefined, async (signal, wrap) => {
      await wrap({ async exec(_c: any, _d: any, { onData }: any) { (jobs as any).jobs.values().next().value.fd = 999999; onData(Buffer.from("data")); return { exitCode: 0 }; } }).exec("c", ".", { signal, onData() {} });
      return success("x");
    });
    await boundary(); await boundary(); await boundary();
    const job = jobs.status(ctx, receipt.jobId);
    assert.equal(job.status, "failed");
    assert.match(job.error!, /output log could not be written/i);
    assert.match(job.error!, /incomplete/i);
    assert.ok(job.error!.includes(receipt.liveLogPath), job.error);
    assert.doesNotMatch(job.error!, /Error:|EBADF: /);
  } finally { await jobs.shutdown(); }
});
