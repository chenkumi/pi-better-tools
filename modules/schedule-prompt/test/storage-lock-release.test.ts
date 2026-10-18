import * as fs from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
const actualFs = await vi.importActual<typeof import("fs")>("fs");
const job = (id: string): CronJob => ({ id, name: id, schedule: "5m", prompt: "p", enabled: true, type: "interval", intervalMs: 300000, createdAt: "", runCount: 0 });
const busyLockRemovals = (count: number) => vi.mocked(fs.rmSync).mockImplementation((target, options) => {
  if (String(target).endsWith(".lock") && count-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
  return actualFs.rmSync(target, options);
});

describe("CronStorage lock release", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = actualFs.mkdtempSync(join(tmpdir(), "pi-schedule-lock-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.mocked(fs.rmSync).mockImplementation(actualFs.rmSync);
    vi.restoreAllMocks();
    actualFs.rmSync(cwd, { recursive: true, force: true });
  });

  it("retries a transiently busy release so later mutations still work", () => {
    const storage = new CronStorage(cwd);
    busyLockRemovals(2);
    storage.addJob(job("a"));
    expect(actualFs.existsSync(join(cwd, ".pi", "schedule-prompts.json.lock"))).toBe(false);
    storage.addJob(job("b"));
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["a", "b"]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports a release that keeps failing instead of hiding the stuck lock", () => {
    const storage = new CronStorage(cwd);
    busyLockRemovals(Number.POSITIVE_INFINITY);
    storage.addJob(job("a"));
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Could not release scheduled prompts lock/), expect.anything());
    vi.mocked(fs.rmSync).mockImplementation(actualFs.rmSync);
    expect(() => storage.addJob(job("b"))).toThrow(/Cannot acquire scheduled prompts lock/);
  });
});
