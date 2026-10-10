import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler, MAX_CONCURRENT_SUBAGENTS, MAX_TIMER_MS } from "../src/scheduler.js";
import type { CronJob } from "../src/types.js";

vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));

import { runSubagentOnce } from "../src/subagent.js";

const mockRun = vi.mocked(runSubagentOnce);
const DAY = 86_400_000;

function makeStorage(seed: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seed.map((j) => [j.id, j]));
  return {
    updateJob: vi.fn((id: string, partial: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    }),
    updateJobWith: (id: string, fn: (j: CronJob) => Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, fn(job));
      return true;
    },
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values()),
  } as any;
}

const makePi = () => ({ sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn() } }) as any;
const ctx = { cwd: "/tmp", isProjectTrusted: () => true, modelRegistry: {}, sessionManager: { getSessionId: () => "s" } } as any;

function job(overrides: Partial<CronJob> = {}): CronJob {
  return { id: "j1", name: "demo", schedule: "5m", prompt: "p", enabled: true, type: "interval", intervalMs: 1000, createdAt: "", runCount: 0, ...overrides };
}

describe("timer limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("rejects intervals Node would clamp to 1ms, accepts the largest safe day count", () => {
    expect(CronScheduler.validateSchedule("interval", "30d").ok).toBe(false);
    expect(CronScheduler.validateSchedule("interval", "24d")).toMatchObject({ ok: true, intervalMs: 24 * DAY });
    expect(24 * DAY).toBeLessThan(MAX_TIMER_MS);
  });

  it("does not schedule a hand-edited oversized interval (no 1ms flood)", async () => {
    const pi = makePi();
    const scheduler = new CronScheduler(makeStorage(), pi, ctx);
    scheduler.addJob(job({ intervalMs: 30 * DAY }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "error" }));
    scheduler.stop();
  });

  it("fires a far-future one-shot job once, at its target time rather than immediately", async () => {
    const pi = makePi();
    const target = new Date(Date.now() + 30 * DAY);
    const once = job({ type: "once", schedule: target.toISOString(), intervalMs: undefined });
    const storage = makeStorage([once]);
    const scheduler = new CronScheduler(storage, pi, ctx);
    scheduler.addJob(once);
    await vi.advanceTimersByTimeAsync(25 * DAY);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * DAY + 1000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(storage.getJob("j1").enabled).toBe(false);
    scheduler.stop();
  });
});

describe("timer callbacks never throw into the host", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRun.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("contains a storage write failure raised while firing a model job", async () => {
    const pi = makePi();
    const model = job({ model: "haiku" });
    const storage = makeStorage([model]);
    storage.updateJob.mockImplementation(() => {
      throw new Error("EPERM: rename");
    });
    const scheduler = new CronScheduler(storage, pi, ctx);
    scheduler.addJob(model);
    await vi.advanceTimersByTimeAsync(1000); // an escaped rejection would fail the test run
    expect(pi.events.emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "error", error: "EPERM: rename" }));
    expect(mockRun).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("keeps a one-shot job enabled when it did not actually fire", async () => {
    const pi = makePi();
    const once = job({ type: "once", schedule: new Date(Date.now() + 10_000).toISOString(), intervalMs: undefined, session: "other" });
    const storage = makeStorage([once]);
    const scheduler = new CronScheduler(storage, pi, ctx);
    scheduler.addJob(once);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob("j1").enabled).toBe(true);
    scheduler.stop();
  });
});

describe("subagent overlap and concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRun.mockReset();
    mockRun.mockImplementation(() => new Promise(() => {})); // never settles
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("does not start a second run of a job whose previous run is still in flight", async () => {
    const scheduler = new CronScheduler(makeStorage([job({ model: "haiku" })]), makePi(), ctx);
    scheduler.addJob(job({ model: "haiku" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockRun).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("caps simultaneous runs across jobs", async () => {
    const jobs = Array.from({ length: MAX_CONCURRENT_SUBAGENTS + 3 }, (_, i) => job({ id: `j${i}`, name: `n${i}`, model: "haiku" }));
    const scheduler = new CronScheduler(makeStorage(jobs), makePi(), ctx);
    for (const j of jobs) scheduler.addJob(j);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRun).toHaveBeenCalledTimes(MAX_CONCURRENT_SUBAGENTS);
    scheduler.stop();
  });

  it("allows the job to run again after its run settles", async () => {
    mockRun.mockResolvedValue({ ok: true, text: "done" });
    const scheduler = new CronScheduler(makeStorage([job({ model: "haiku" })]), makePi(), ctx);
    scheduler.addJob(job({ model: "haiku" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    scheduler.stop();
  });
});
