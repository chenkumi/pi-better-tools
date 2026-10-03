import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const acquire = vi.fn();
vi.mock("../../src/locking.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/locking.js")>()), acquireAdvisoryLock: (...args: unknown[]) => acquire(...args) }));

import { IndependentRunner } from "../../src/runner.js";
import { RegistryStore } from "../../src/registry-store.js";
import { RunStore } from "../../src/run-store.js";
import { resolveSchedulerPaths } from "../../src/paths.js";

const directories: string[] = [];
afterEach(async () => { acquire.mockReset(); await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pi-runner-lock-")); directories.push(directory);
  const paths = resolveSchedulerPaths(directory);
  const registry = new RegistryStore({ registryPath: paths.registryPath, lockPath: paths.lockPath });
  const runs = new RunStore({ runsPath: paths.runsPath, lockPath: paths.lockPath, logsDir: paths.logsDir });
  const runner = new IndependentRunner({ paths, registry, runs, executor: {} as never, supervisor: {} as never, internalPoll: false });
  return { directory, registry, runs, runner };
}

describe("independent runner singleton lock", () => {
  it("demotes to standby without throwing when the lock is compromised, then can re-acquire", async () => {
    const f = await setup();
    const release = vi.fn(async () => undefined);
    acquire.mockResolvedValue(release);
    await f.runner.start();
    expect(f.runner.running).toBe(true);
    const options = acquire.mock.calls[0][1] as { onCompromised: (error: Error) => void };
    expect(() => options.onCompromised(new Error("mtime stale"))).not.toThrow();
    expect(f.runner.running).toBe(false);
    expect((await f.runner.status()).lastError).toContain("compromised");
    await f.runner.stop();
    expect(release).not.toHaveBeenCalled(); // the lock is no longer ours
    await f.runner.start();
    expect(f.runner.running).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
    await f.runner.stop();
  });

  it("run-once gives a clear error for paused or cancelled schedules instead of returning undefined", async () => {
    const f = await setup();
    acquire.mockResolvedValue(async () => undefined);
    const base = { mode: "independent" as const, prompt: "x", cwd: f.directory, timing: { kind: "cron" as const, expression: "0 * * * *", timezone: "UTC" } };
    const paused = await f.registry.create({ ...base, id: "paused-job" });
    await f.registry.setState(paused.id, paused.revision, "paused");
    const cancelled = await f.registry.create({ ...base, id: "cancelled-job" });
    await f.registry.setState(cancelled.id, cancelled.revision, "cancelled");
    await expect(f.runner.runOnce("paused-job")).rejects.toThrow("is paused");
    await expect(f.runner.runOnce("cancelled-job")).rejects.toThrow("is cancelled");
    await f.runner.stop();
  });
});
