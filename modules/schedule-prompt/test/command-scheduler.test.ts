import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { MAX_CONCURRENT_COMMANDS, defaultCommandShell } from "../src/command.js";
import type { CronJob } from "../src/types.js";
vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));
vi.mock("../../shell-tools/src/monitor-exec.ts", () => ({ execMonitorCommand: vi.fn() }));
import { execMonitorCommand } from "../../shell-tools/src/monitor-exec.ts";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const mockExec = vi.mocked(execMonitorCommand);

/** One simulated child process: tests push output and decide how and when it closes. */
interface FakeRun {
  tool: string; command: string; cwd: string | undefined; signal: AbortSignal;
  stdout(text: string): void; stderr(text: string): void;
  close(code: number | null, signal?: NodeJS.Signals | null, spawnError?: boolean): void;
  fail(error: Error): void;
  closed: boolean;
}
let runs: FakeRun[];

let base: string;
let project: string;
let storage: CronStorage;
let scheduler: CronScheduler;
let pi: any;
let ctx: any;

const seed = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "c", name: "cmd", type: "interval", schedule: "1h", intervalMs: 3_600_000,
  command: "echo hi", enabled: true, runCount: 0, createdAt: "", session: "s", ...overrides,
});
function install(overrides: Partial<CronJob> = {}) {
  const job = seed(overrides);
  storage.addJob(job);
  return job;
}
const fire = (job: CronJob) => (scheduler as any).fire(job) as Promise<boolean>;
const lastMarker = () => pi.sendMessage.mock.calls.at(-1)![0];
const modes = () => pi.sendMessage.mock.calls.map(([m]: any[]) => m.details?.mode);
const started = (count = 1) => vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(count), { timeout: 10_000 });
const settled = () => vi.waitFor(() => expect((scheduler as any).childRuns.size).toBe(0), { timeout: 10_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  runs = [];
  mockExec.mockReset();
  mockExec.mockImplementation((_pi: any, _ctx: any, tool: any, command: string, signal: AbortSignal, events: any, _seam: any, options: any) =>
    new Promise<void>((resolve, reject) => {
      let done = false;
      const run: FakeRun = {
        tool, command, cwd: options?.cwd, signal, closed: false,
        stdout: (text) => events.stdout(Buffer.from(text)),
        stderr: (text) => events.stderr(Buffer.from(text)),
        close: (code, sig = null, spawnError = false) => {
          if (done) return;
          done = true; run.closed = true;
          events.closed(code, sig, spawnError); resolve();
        },
        fail: (error) => { if (!done) { done = true; run.closed = true; reject(error); } },
      };
      // Like the real helper, cancellation kills the tree and the child's close follows.
      signal.addEventListener("abort", () => run.close(null, "SIGTERM"), { once: true });
      runs.push(run);
      events.started();
    }));
  base = realpathSync(mkdtempSync(join(tmpdir(), "pi-command-scheduler-")));
  project = join(base, "proj");
  mkdirSync(join(project, "sub"), { recursive: true });
  storage = new CronStorage(project);
  pi = { sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn() }, getSettings: () => ({}) };
  ctx = { isProjectTrusted: () => true, cwd: project, sessionManager: { getSessionId: () => "s" } };
  scheduler = new CronScheduler(storage, pi, ctx);
});
afterEach(async () => {
  scheduler.stop();
  await scheduler.drain(50);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(base, { recursive: true, force: true });
});

describe("command job execution", () => {
  it("runs the command through the shell helper in the project directory and records success", async () => {
    const job = install();
    expect(await fire(job)).toBe(true);
    await started();
    expect(runs[0]).toMatchObject({ tool: defaultCommandShell(), command: "echo hi", cwd: project });
    expect(modes()).toEqual(["command_start"]);
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "running", runCount: 0 });
    runs[0].stdout("hello\n");
    runs[0].stderr("warning\n");
    runs[0].close(0);
    await settled();
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "success", runCount: 1 });
    expect(modes()).toEqual(["command_start", "command_done"]);
    const marker = lastMarker();
    expect(marker.details).toMatchObject({ jobId: "c", command: "echo hi", cwd: project, exitCode: 0, output: "hello\nwarning" });
    // G5-001: output lives only in `details` (display/state); model-visible content is empty, so it is never projected to the LLM.
    expect(marker.content).toEqual([]);
    expect(JSON.stringify(pi.sendMessage.mock.calls.map((call: any[]) => call[0].content))).not.toContain("hello");
    // Output goes to a display marker only: never steers/wakes the agent (deferred when streaming), never a user message.
    expect(pi.sendMessage.mock.calls.every((call: any[]) => call[1]?.triggerTurn === false && call[1]?.deliverAs === undefined)).toBe(true);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("uses the job's own shell and an explicit directory", async () => {
    const other = defaultCommandShell() === "bash" ? "powershell" : "bash";
    const job = install({ shell: other, cwd: join(project, "sub") });
    await fire(job);
    await started();
    expect(runs[0]).toMatchObject({ tool: other, cwd: join(project, "sub") });
    runs[0].close(0);
    await settled();
  });

  it("records a non-zero exit as an error with the exit code and output, without counting a run", async () => {
    const job = install();
    await fire(job);
    await started();
    runs[0].stderr("boom");
    runs[0].close(3);
    await settled();
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "error", runCount: 0 });
    expect(modes()).toEqual(["command_start", "command_error"]);
    expect(lastMarker().details).toMatchObject({ exitCode: 3 });
    expect(lastMarker().details.error).toBe("Command exited with code 3\nboom");
    expect(pi.events.emit.mock.calls.some(([, e]: any[]) => e.type === "error" && e.jobId === "c")).toBe(true);
  });

  it("reports a spawn failure, a signal death and a thrown helper error", async () => {
    const job = install();
    await fire(job); await started(1);
    runs[0].close(null, null, true); await settled();
    expect(lastMarker().details.error).toBe("Command could not be started");
    await fire(storage.getJob("c")!); await started(2);
    runs[1].close(null, "SIGKILL"); await settled();
    expect(lastMarker().details.error).toBe("Command was terminated by signal SIGKILL");
    await fire(storage.getJob("c")!); await started(3);
    runs[2].fail(new Error("Installed host lacks required Shell backend capability")); await settled();
    expect(lastMarker().details.error).toBe("Command could not run: Installed host lacks required Shell backend capability");
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "error", runCount: 0 });
  });

  it("keeps only the end of very long output", async () => {
    const job = install();
    await fire(job); await started();
    runs[0].stdout("A".repeat(20_000));
    runs[0].stdout("tail-marker");
    runs[0].close(0); await settled();
    const output = lastMarker().details.output as string;
    expect(output.startsWith("…")).toBe(true);
    expect(output.endsWith("tail-marker")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(501);
  });

  it("doesn't let a multi-byte character cut by the output window leak a replacement character", async () => {
    const job = install();
    await fire(job); await started();
    // 3-byte characters: an 8 KiB window almost surely starts mid-character.
    runs[0].stdout("€".repeat(5000));
    runs[0].close(0); await settled();
    expect(lastMarker().details.output).not.toContain("�");
  });
});

describe("output-stall timeout", () => {
  it("stops a command that is silent for timeoutMs and says cancellation is only requested", async () => {
    const job = install({ timeoutMs: 1000 });
    await fire(job); await started();
    runs[0].stdout("partial");
    await vi.advanceTimersByTimeAsync(999);
    expect(runs[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs[0].signal.aborted).toBe(true);
    await settled();
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "error", runCount: 0 });
    const error = lastMarker().details.error as string;
    expect(error).toContain("no output for 1000 ms");
    expect(error).toContain("descendant processes may still be running");
    expect(error).toContain("partial");
  });

  it("is a stall deadline, not a total limit: output keeps a long command alive", async () => {
    const job = install({ timeoutMs: 1000 });
    await fire(job); await started();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(900);
      runs[0].stdout(`tick ${i}\n`);
    }
    expect(runs[0].signal.aborted).toBe(false); // 4.5 s elapsed with a 1 s deadline
    runs[0].close(0); await settled();
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "success", runCount: 1 });
  });

  it("starts the stall clock at launch, so a command that never prints is also stopped", async () => {
    const job = install({ timeoutMs: 500 });
    await fire(job); await started();
    await vi.advanceTimersByTimeAsync(500);
    expect(runs[0].signal.aborted).toBe(true);
    await settled();
    expect(lastMarker().details.error).toContain("no output for 500 ms");
  });

  it("clears its timer once the command has exited", async () => {
    const job = install({ timeoutMs: 60_000 });
    await fire(job); await started();
    runs[0].close(0); await settled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("admission", () => {
  it("skips a tick while the previous run of the same job is still going", async () => {
    const job = install();
    expect(await fire(job)).toBe(true);
    await started();
    expect(await fire(job)).toBe(false);
    expect(runs).toHaveLength(1);
    runs[0].close(0); await settled();
    expect(await fire(storage.getJob("c")!)).toBe(true);
    await started(2);
    runs[1].close(0); await settled();
  });

  it(`allows at most ${MAX_CONCURRENT_COMMANDS} command runs at once and reports the skip`, async () => {
    const jobs = Array.from({ length: MAX_CONCURRENT_COMMANDS + 1 }, (_, i) => install({ id: `j${i}`, name: `n${i}` }));
    for (const job of jobs.slice(0, MAX_CONCURRENT_COMMANDS)) expect(await fire(job)).toBe(true);
    await started(MAX_CONCURRENT_COMMANDS);
    expect(await fire(jobs[MAX_CONCURRENT_COMMANDS])).toBe(false);
    expect(runs).toHaveLength(MAX_CONCURRENT_COMMANDS);
    expect(pi.events.emit.mock.calls.some(([, e]: any[]) => e.type === "error" && /too many scheduled command runs/.test(e.error))).toBe(true);
    for (const run of runs) run.close(0);
    await settled();
  });

  it("does not start a disabled, foreign-session or untrusted job", async () => {
    const disabled = install({ id: "d", name: "d", enabled: false });
    const foreign = install({ id: "f", name: "f", session: "other" });
    expect(await fire(disabled)).toBe(false);
    expect(await fire(foreign)).toBe(false);
    ctx.isProjectTrusted = () => false;
    expect(await fire(install({ id: "t", name: "t" }))).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("working-directory policy at fire time", () => {
  let outside: string;
  beforeEach(() => { outside = join(base, "outside"); mkdirSync(outside); });

  it("refuses an unapproved directory outside the project and never runs elsewhere", async () => {
    const job = install({ cwd: outside });
    expect(await fire(job)).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "error", runCount: 0 });
    expect(lastMarker().details.error).toMatch(/outside the project and was not approved/);
  });

  it("posts one marker per failure streak, not one per tick", async () => {
    install({ cwd: outside });
    for (let i = 0; i < 3; i++) await fire(storage.getJob("c")!);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.events.emit.mock.calls.filter(([, e]: any[]) => e.type === "error")).toHaveLength(3);
  });

  it("runs an outside directory after this process approved exactly that command/shell/directory", async () => {
    const job = install({ cwd: outside });
    expect(scheduler.approveCommand(job)).toBe(true);
    expect(await fire(job)).toBe(true);
    await started();
    expect(runs[0].cwd).toBe(outside);
    runs[0].close(0); await settled();
    // Editing the command invalidates the approval.
    const edited = { ...storage.getJob("c")!, command: "echo other" };
    storage.updateJob("c", { command: "echo other" });
    expect(await fire(edited)).toBe(false);
    expect(runs).toHaveLength(1);
  });

  it("does not need an approval inside the project (the trusted project is the boundary)", async () => {
    const job = install({ cwd: join(project, "sub") });
    expect(await fire(job)).toBe(true);
    await started();
    expect(runs[0].cwd).toBe(join(project, "sub"));
    runs[0].close(0); await settled();
  });

  it("re-checks the directory at every fire and never falls back to the project directory", async () => {
    const gone = join(project, "sub");
    const job = install({ cwd: gone });
    rmSync(gone, { recursive: true });
    expect(await fire(job)).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
    expect(lastMarker().details.error).toMatch(/does not exist/);
  });

  it("approveCommand reports an unusable directory and trivially accepts prompt jobs", () => {
    expect(scheduler.approveCommand(seed({ cwd: join(base, "missing") }))).toBe(false);
    expect(scheduler.approveCommand({ ...seed(), command: undefined, prompt: "p" })).toBe(true);
  });
});

describe("shutdown and once jobs", () => {
  it("stop() cancels the running command and touches neither storage nor chat afterwards", async () => {
    const job = install();
    await fire(job); await started();
    const before = pi.sendMessage.mock.calls.length;
    scheduler.stop();
    expect(runs[0].signal.aborted).toBe(true);
    const result = await scheduler.drain(1000);
    expect(result.pending).toBe(0);
    expect(pi.sendMessage.mock.calls.length).toBe(before);
    expect(storage.getJob("c")).toMatchObject({ lastStatus: "running", runCount: 0 });
  });

  it("asks the helper to defer an early abort", async () => {
    await fire(install()); await started();
    expect(mockExec.mock.calls[0][7]).toMatchObject({ abortGraceMs: 500, exitIdleMs: 250 });
  });

  it("stops waiting when a cancelled run never closes (surviving grandchild holds the pipe) and says so", async () => {
    mockExec.mockImplementation((_pi: any, _ctx: any, _tool: any, _command: string, signal: AbortSignal, events: any) =>
      new Promise<void>(() => { runs.push({ signal } as any); events.started(); }));
    const job = install();
    await fire(job); await started();
    scheduler.stop();
    const drained = scheduler.drain(60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await drained).pending).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a once command job is disabled after it is admitted, and its result still arrives", async () => {
    scheduler.start();
    const job = seed({ type: "once", schedule: new Date(NOW + 1000).toISOString(), intervalMs: undefined });
    storage.addJob(job);
    scheduler.addJob(job);
    await vi.advanceTimersByTimeAsync(1000);
    await started();
    await vi.waitFor(() => expect(storage.getJob("c")?.enabled).toBe(false));
    runs[0].close(0); await settled();
    expect(storage.getJob("c")).toMatchObject({ enabled: false, lastStatus: "success", runCount: 1 });
    expect(modes()).toEqual(["command_start", "command_done"]);
  });

  it("a once command job that is refused is disabled with an error and not retried", async () => {
    scheduler.start();
    const outside = join(base, "outside"); mkdirSync(outside);
    const job = seed({ type: "once", schedule: new Date(NOW + 1000).toISOString(), intervalMs: undefined, cwd: outside });
    storage.addJob(job);
    scheduler.addJob(job);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(storage.getJob("c")).toMatchObject({ enabled: false, lastStatus: "error" }));
    expect(mockExec).not.toHaveBeenCalled();
  });
});
