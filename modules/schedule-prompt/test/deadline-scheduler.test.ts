import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler, DEADLINE_RECHECK_MS, MAX_TIMER_MS } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));
import { runSubagentOnce } from "../src/subagent.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const at = (delta: number) => new Date(NOW + delta).toISOString();
const seed = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "j", name: "demo", type: "interval", schedule: "1s", intervalMs: 1000,
  prompt: "p", enabled: true, runCount: 0, createdAt: "", session: "s", ...overrides,
});
let cwd: string;
let storage: CronStorage;
let scheduler: CronScheduler;
let pi: any;
const mockRun = vi.mocked(runSubagentOnce);
const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s" } } as any;
function install(overrides: Partial<CronJob> = {}) {
  const job = seed(overrides);
  storage.addJob(job);
  scheduler.addJob(job);
  return job;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockRun.mockReset();
  cwd = mkdtempSync(join(tmpdir(), "pi-deadline-scheduler-"));
  storage = new CronStorage(cwd);
  pi = { sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn() } };
  scheduler = new CronScheduler(storage, pi, ctx);
});
afterEach(() => {
  scheduler.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(cwd, { recursive: true, force: true });
});

describe("native scheduler deadlines", () => {
  it.each(["interval", "cron", "once"] as const)("enforces the exclusive edge for %s even without running the deadline timer", async (type) => {
    const job = install({ type, schedule: type === "cron" ? "* * * * * *" : type === "once" ? at(1000) : "1s", endAt: at(2000) });
    vi.setSystemTime(NOW + 1999);
    expect(await (scheduler as any).fire(job)).toBe(true);
    vi.setSystemTime(NOW + 2000);
    expect(await (scheduler as any).fire(job)).toBe(false);
    vi.setSystemTime(NOW + 2001);
    expect(await (scheduler as any).fire(job)).toBe(false);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 1, lastStatus: "success" });
    expect(storage.getJob("j")?.nextRun).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("expires without a trigger and doesn't change statistics", async () => {
    install({ intervalMs: 5000, endAt: at(1000), lastStatus: "error", lastRun: "last", runCount: 7, nextRun: at(5000) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob("j")).toMatchObject({ enabled: false, lastStatus: "error", lastRun: "last", runCount: 7 });
    expect(storage.getJob("j")?.nextRun).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.events.emit.mock.calls.filter(([, e]: any[]) => e.type === "update")).toHaveLength(1);
  });
  it("does not fire at a coincident interval tick", async () => {
    install({ endAt: at(1000) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob("j")?.enabled).toBe(false);
  });
  it.each([at(0), "bad", null])("disables overdue/invalid persisted state at startup: %s", (endAt) => {
    storage.addJob(seed({ endAt: endAt as any, lastStatus: "success" }));
    scheduler.start();
    expect(storage.getJob("j")).toMatchObject({ enabled: false, lastStatus: "success" });
    expect(vi.getTimerCount()).toBe(0);
    expect(mockRun).not.toHaveBeenCalled();
  });
  it("does not disable another session's expired job", () => {
    storage.addJob(seed({ session: "foreign", endAt: at(0) }));
    scheduler.start();
    expect(storage.getJob("j")?.enabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds timer segments for a far-future deadline", async () => {
    install({ intervalMs: MAX_TIMER_MS, endAt: at(MAX_TIMER_MS * 2) });
    await vi.advanceTimersByTimeAsync(DEADLINE_RECHECK_MS * 2);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob("j")?.enabled).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
  });
  it("resumes after a clock jump without catching up missed triggers", async () => {
    install({ endAt: at(120000), intervalMs: 600000 });
    vi.setSystemTime(NOW + 180000);
    await vi.advanceTimersByTimeAsync(DEADLINE_RECHECK_MS);
    expect(storage.getJob("j")?.enabled).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.setSystemTime(NOW);
    await vi.advanceTimersByTimeAsync(600000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("rechecks a clock rollback and waits until the absolute deadline", async () => {
    install({ intervalMs: 600000, endAt: at(1000) });
    vi.setSystemTime(NOW - 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.getJob("j")?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.getJob("j")?.enabled).toBe(false);
  });
  it.each([at(5000), undefined])("an old timer cannot expire an extended/cleared deadline: %s", async (endAt) => {
    install({ intervalMs: 10000, endAt: at(1000) });
    storage.updateJob("j", { endAt });
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.getJob("j")?.enabled).toBe(true);
    if (endAt) {
      await vi.advanceTimersByTimeAsync(4000);
      expect(storage.getJob("j")?.enabled).toBe(false);
    } else {
      expect(vi.getTimerCount()).toBe(1);
    }
  });
  it("handles a peer extending the deadline while the expiration lock is acquired", async () => {
    install({ endAt: at(1000) });
    const expire = storage.expireJobIfDue.bind(storage);
    vi.spyOn(storage, "expireJobIfDue").mockImplementationOnce((id, session) => {
      storage.updateJob(id, { endAt: at(5000) });
      return expire(id, session);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.getJob("j")).toMatchObject({ enabled: true, endAt: at(5000) });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(storage.getJob("j")?.enabled).toBe(false);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
  });
  it.each(["remove", "disable", "rebind"])("cleans up when storage has been changed by a peer: %s", async (action) => {
    install({ intervalMs: 10000, endAt: at(1000) });
    if (action === "remove") storage.removeJob("j");
    if (action === "disable") storage.updateJob("j", { enabled: false });
    if (action === "rebind") storage.updateJob("j", { session: "foreign" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (action === "rebind") expect(storage.getJob("j")?.enabled).toBe(true);
  });
  it("reschedules shorter deadlines and frees timers on update/remove/reload", async () => {
    install({ endAt: at(5000) });
    storage.updateJob("j", { endAt: at(500) });
    scheduler.updateJob("j", storage.getJob("j")!);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(storage.getJob("j")?.enabled).toBe(false);
    storage.updateJob("j", { enabled: true, endAt: at(2000) });
    scheduler.updateJob("j", storage.getJob("j")!);
    scheduler.stop();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(2);
    storage.removeJob("j");
    scheduler.removeJob("j");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("rechecks after a synchronous status write crosses the deadline (model=%s)", async (model) => {
    const job = install({ endAt: at(1000), lastStatus: "success", model: model ? "fixture" : undefined });
    const update = storage.updateJob.bind(storage);
    vi.spyOn(storage, "updateJob").mockImplementation((id, changes) => {
      const result = update(id, changes);
      if (changes.lastStatus === "running") vi.setSystemTime(NOW + 1000);
      return result;
    });
    expect(await (scheduler as any).fire(job)).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 0, lastStatus: "success" });
  });
  it.each([false, true])("rechecks after a marker listener crosses the deadline (model=%s)", async (model) => {
    const job = install({ endAt: at(1000), model: model ? "fixture" : undefined });
    pi.sendMessage.mockImplementation(() => vi.setSystemTime(NOW + 1000));
    expect(await (scheduler as any).fire(job)).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(storage.getJob("j")?.lastStatus).toBeUndefined();
  });
  it("allows already-started model work to finish after expiration without re-enabling it", async () => {
    let complete!: (value: any) => void;
    mockRun.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const job = install({ endAt: at(2000), model: "fixture", notify: true });
    expect(await (scheduler as any).fire(job)).toBe(true);
    const signal = mockRun.mock.calls[0][3];
    await vi.advanceTimersByTimeAsync(2000);
    expect(signal?.aborted).toBe(false);
    expect(storage.getJob("j")).toMatchObject({ enabled: false, lastStatus: "running" });
    complete({ ok: true, text: "done" });
    await Promise.resolve(); await Promise.resolve();
    expect(storage.getJob("j")).toMatchObject({ enabled: false, lastStatus: "success", runCount: 1 });
    expect(storage.getJob("j")?.nextRun).toBeUndefined();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ details: expect.objectContaining({ mode: "subagent_done" }) }), { deliverAs: "followUp", triggerTurn: true });
  });
  it("rejects fresh persisted invalid values on execution even without a deadline timer", async () => {
    const job = install();
    storage.updateJob("j", { endAt: "bad" });
    expect(await (scheduler as any).fire(job)).toBe(false);
    expect(storage.getJob("j")?.enabled).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("contains storage/listener failures and never starts an expired prompt", async () => {
    const job = install({ endAt: at(1000) });
    vi.spyOn(storage, "expireJobIfDue").mockImplementation(() => { throw new Error("disk denied"); });
    pi.events.emit.mockImplementation(() => { throw new Error("listener failed"); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await (scheduler as any).fire(job)).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("doesn't show a cron nextRun at/after the deadline", () => {
    install({ type: "cron", schedule: "* * * * * *", endAt: at(1000) });
    expect(scheduler.getNextRun("j")).toBeNull();
    storage.updateJob("j", { endAt: at(2000) });
    expect(scheduler.getNextRun("j")?.toISOString()).toBe(at(1000));
  });
});
