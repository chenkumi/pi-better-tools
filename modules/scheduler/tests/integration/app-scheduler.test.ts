import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppScheduler } from "../../src/app-scheduler.js";
import { IndependentRunner } from "../../src/runner.js";
import { RegistryStore } from "../../src/registry-store.js";
import { RunStore } from "../../src/run-store.js";
import { resolveSchedulerPaths } from "../../src/paths.js";
import { PiProcessExecutor } from "../../src/pi-process-executor.js";
import { nodeChildSpawner } from "../../src/runtime-deps.js";

const cleanups: Array<() => Promise<void>> = [];
// Bound asynchronous process/FS assertions without assuming sub-second CI startup.
const waitFor: typeof vi.waitFor = (callback, options) => vi.waitFor(callback, options ?? { timeout: 5000 });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pi-app-host-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const paths = resolveSchedulerPaths(directory);
  const registry = new RegistryStore({ registryPath: paths.registryPath, lockPath: paths.lockPath });
  const runs = new RunStore({ runsPath: paths.runsPath, lockPath: paths.lockPath, logsDir: paths.logsDir });
  let now = new Date("2030-01-01T00:00:00Z");
  const callbacks: Array<{ fire: () => void; cleared: boolean; delay: number }> = [];
  const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath,
    args: ["-e", "console.log(JSON.stringify({child:process.env.PI_SCHEDULER_CHILD})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop'}}));", "--"] }) }, nodeChildSpawner);
  const start = vi.spyOn(executor, "start");
  const makeRunner = (maxChildren?: number) => {
    const runner = new IndependentRunner({ paths, registry, runs, executor, supervisor: {} as never, pollMs: 60_000, maxChildren,
      clock: { now: () => now }, cronClock: { now: () => now, setTimeout: (fire, delay) => {
        const entry = { fire, delay, cleared: false }; callbacks.push(entry); return { clear: () => { entry.cleared = true; } };
      } } });
    cleanups.push(() => runner.stop());
    return runner;
  };
  const create = (id = "job", expression = "2030-01-01T00:01:00Z") => registry.create({
    id, mode: "independent", prompt: "fixture", cwd: directory, timing: { kind: "once", expression, timezone: "UTC" },
  });
  return { paths, registry, runs, makeRunner, create, callbacks, start, executor, setNow: (value: string) => { now = new Date(value); } };
}

describe("app-hosted independent scheduler", () => {
  it.each(["log-io", "executor-wait"])("does not drop unknown ownership on %s failure", async (fault) => {
    const f = await setup(); const job = await f.registry.create({ id: `fault-${fault}`, mode: "independent", prompt: "fixture", cwd: f.paths.agentDir,
      timing: { kind: "cron", expression: "* * * * *", timezone: "UTC" } });
    const terminate = vi.spyOn(f.executor, "terminate");
    if (fault === "log-io") {
      vi.spyOn(f.executor, "wait").mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: "", stderr: "", piErrors: ["unknown pipes"], ownershipUnknown: true });
      vi.spyOn(f.runs, "writeOutput").mockRejectedValueOnce(new Error("injected log IO failure"));
    } else vi.spyOn(f.executor, "wait").mockRejectedValueOnce(new Error("injected executor rejection"));
    const runner = f.makeRunner(); await runner.start(); await runner.runOnce(job.id);
    await waitFor(async () => expect((await f.runs.list())[0]?.status).toBe("orphaned")); expect(terminate).toHaveBeenCalledTimes(1);
    f.setNow("2030-01-01T00:01:00Z"); expect((await runner.runOnce(job.id))?.status).toBe("skipped_busy"); expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("retains an orphan barrier when output-pipe descendants have unknown ownership", async () => {
    const f = await setup(); const job = await f.registry.create({ id: "pipe-job", mode: "independent", prompt: "fixture", cwd: f.paths.agentDir,
      timing: { kind: "cron", expression: "* * * * *", timezone: "UTC" } });
    vi.spyOn(f.executor, "wait").mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: "", stderr: "", piErrors: ["descendant ownership unknown"], ownershipUnknown: true });
    const runner = f.makeRunner(); await runner.start(); await runner.runOnce(job.id);
    await waitFor(async () => expect((await f.runs.list())[0]?.status).toBe("orphaned"));
    f.setNow("2030-01-01T00:01:00Z"); expect((await runner.runOnce(job.id))?.status).toBe("skipped_busy"); expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("skips at the host concurrency cap without creating a backlog", async () => {
    const f = await setup();
    f.start.mockImplementation((request) => new PiProcessExecutor({ resolve: () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", "--"] }) }, nodeChildSpawner).start(request));
    await f.create("first"); await f.create("second"); const runner = f.makeRunner(1); await runner.start();
    f.setNow("2030-01-01T00:01:00Z"); f.callbacks[0].fire(); f.callbacks[1].fire();
    await waitFor(async () => expect(await f.runs.list()).toHaveLength(2));
    const runs = await f.runs.list(); expect(runs.map((run) => run.status)).toEqual(["running", "skipped_busy"]);
    expect(runs[1].events.some((event) => event.detail === "host_capacity_skipped")).toBe(true);
    expect((await runner.status()).maxChildren).toBe(1); expect(f.start).toHaveBeenCalledTimes(1);
    await runner.stop(); expect((await runner.status()).activeChildren).toBe(0);
  });
  it("dispatches a due one-shot once, marks children, and does not repeat after restart", async () => {
    const f = await setup(); const job = await f.create(); const runner = f.makeRunner();
    await runner.start(); f.setNow("2030-01-01T00:01:00Z"); f.callbacks[0].fire();
    await waitFor(async () => expect((await f.runs.list())[0]?.status).toBe("succeeded"));
    expect((await f.runs.list())[0].outputSummary).toContain('"child":"1"');
    expect((await f.registry.list())[0].lastPlannedAt).toBeTruthy();
    await runner.stop(); await runner.start(); await runner.poll();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(await f.runs.list(job.id)).toHaveLength(1);
  });

  it("records missed-once diagnostics only once across polling and restart", async () => {
    const f = await setup(); await f.create("past", "2029-01-01T00:00:00Z"); const runner = f.makeRunner();
    await runner.start(); await runner.poll(); await runner.stop(); await runner.start(); await runner.poll();
    expect(await f.runs.list()).toHaveLength(1); expect(f.start).not.toHaveBeenCalled();
    expect((await f.runs.list())[0].events[0].detail).toBe("missed_no_backfill");
  });

  it("replaces edited timers and rejects stale/cancelled callbacks", async () => {
    const f = await setup(); const job = await f.create(); const runner = f.makeRunner(); await runner.start();
    const updated = await f.registry.update(job.id, job.revision, { timing: { ...job.timing, expression: "2030-01-01T00:02:00Z" } });
    await runner.poll(); expect(f.callbacks[0].cleared).toBe(true);
    f.setNow("2030-01-01T00:01:00Z"); f.callbacks[0].fire(); await runner.poll(); expect(f.start).not.toHaveBeenCalled();
    await f.registry.setState(job.id, updated.revision, "cancelled");
    f.setNow("2030-01-01T00:02:00Z"); f.callbacks[1].fire(); await runner.poll();
    expect(f.start).not.toHaveBeenCalled(); expect(await f.runs.list()).toHaveLength(0);
  });

  it("serializes simultaneous callbacks and re-arms a once only for a changed time", async () => {
    const f = await setup(); const job = await f.create(); const runner = f.makeRunner(); await runner.start();
    f.setNow("2030-01-01T00:01:00Z"); f.callbacks[0].fire(); f.callbacks[0].fire();
    await waitFor(async () => expect((await f.runs.list())[0]?.status).toBe("succeeded"));
    expect(f.start).toHaveBeenCalledTimes(1);
    await f.registry.update(job.id, job.revision, { timing: { ...job.timing, expression: "2030-01-01T00:02:00Z" } });
    await runner.poll(); f.setNow("2030-01-01T00:02:00Z"); f.callbacks.at(-1)!.fire();
    await waitFor(async () => expect((await f.runs.list()).filter((r) => r.status === "succeeded")).toHaveLength(2));
  });

  it("elects one host, permits takeover and disables host startup inside child Pi", async () => {
    const f = await setup(); await f.create();
    const session = () => ({ start: vi.fn(), refresh: vi.fn(), shutdown: vi.fn() });
    const s1 = session(), s2 = session(), s3 = session();
    const a = new AppScheduler(f.makeRunner(), s1 as never, { pollMs: 60_000 });
    const b = new AppScheduler(f.makeRunner(), s2 as never, { pollMs: 60_000 });
    const child = new AppScheduler(f.makeRunner(), s3 as never, { child: true });
    cleanups.push(() => a.stop(), () => b.stop(), () => child.stop());
    await Promise.all([a.start({} as never), b.start({} as never)]);
    const hostStatus = await a.status();
    expect(hostStatus).not.toHaveProperty("versions");
    const states = [hostStatus.role, (await b.status()).role]; expect(states.sort()).toEqual(["host", "standby"]);
    const host = (await a.status()).role === "host" ? a : b; const follower = host === a ? b : a;
    await host.stop(); await follower.refresh(); expect((await follower.status()).role).toBe("host");
    await child.start({} as never); expect((await child.status()).role).toBe("child-disabled"); expect(s3.start).not.toHaveBeenCalled();
  });

  it("observes remote cancellation and stops owned children during shutdown", async () => {
    const f = await setup();
    const realStart = f.executor.start.bind(f.executor);
    f.start.mockImplementation((request) => {
      const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", "--"] }) }, nodeChildSpawner);
      return executor.start(request);
    });
    await f.create(); const runner = f.makeRunner(); await runner.start();
    f.setNow("2030-01-01T00:01:00Z"); f.callbacks[0].fire();
    await waitFor(async () => expect((await f.runs.list())[0]?.status).toBe("running"));
    const run = (await f.runs.list())[0]; await f.runs.requestCancellation(run.runId, new Date().toISOString()); await runner.poll();
    await waitFor(async () => expect((await f.runs.list())[0].status).toBe("cancelled"));
    await f.create("shutdown", "2030-01-01T00:02:00Z"); await runner.poll();
    f.setNow("2030-01-01T00:02:00Z"); f.callbacks.at(-1)!.fire();
    await waitFor(async () => expect((await f.runs.list()).at(-1)?.status).toBe("running"));
    await runner.stop(); expect((await runner.status()).activeChildren).toBe(0);
    expect((await f.runs.list()).at(-1)?.status).toBe("cancelled");
    f.start.mockImplementation(realStart);
  });

  it("releases the host lock if startup fails and exposes background errors", async () => {
    const f = await setup(); await f.create(); const runner = f.makeRunner();
    const list = vi.spyOn(f.registry, "list").mockRejectedValueOnce(new Error("registry unavailable"));
    await expect(runner.start()).rejects.toThrow("registry unavailable");
    await runner.start(); expect(runner.running).toBe(true); list.mockRestore();
    const session = { start: vi.fn(), refresh: vi.fn().mockRejectedValue(new Error("session disk error")), shutdown: vi.fn() };
    const app = new AppScheduler(f.makeRunner(), session as never); cleanups.push(() => app.stop());
    await app.start({} as never); expect((await app.status()).lastError).toContain("session disk error");
  });
});
