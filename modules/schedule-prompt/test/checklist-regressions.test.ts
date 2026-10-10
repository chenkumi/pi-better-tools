import * as fs from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import { CronScheduler, MAX_CONCURRENT_SUBAGENTS } from "../src/scheduler.js";
import { CronWidget } from "../src/ui/cron-widget.js";
import type { CronJob } from "../src/types.js";
vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));
import { runSubagentOnce } from "../src/subagent.js";
const actualFs = await vi.importActual<typeof import("fs")>("fs");
const seed = (partial: Partial<CronJob> = {}): CronJob => ({ id: "j", name: "demo", schedule: "1s", prompt: "p", enabled: true, type: "interval", intervalMs: 1000, createdAt: "", runCount: 0, ...partial });
const makePi = () => ({ sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }) as any;
const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s" } } as any;
let cwd: string;
let storage: CronStorage;
let scheduler: CronScheduler | undefined;
beforeEach(() => {
  cwd = actualFs.mkdtempSync(join(tmpdir(), "pi-sp-checklist-"));
  storage = new CronStorage(cwd);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(runSubagentOnce).mockReset();
});
afterEach(() => {
  scheduler?.stop(); scheduler = undefined;
  vi.useRealTimers(); vi.restoreAllMocks();
  vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync);
  vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
  actualFs.rmSync(cwd, { recursive: true, force: true });
});

describe("storage checklist regressions", () => {
  it("M7: every mutation, including direct save, refuses a contended lock and preserves bytes", () => {
    storage.addJob(seed());
    const bytes = actualFs.readFileSync(storage.getStorePath(), "utf8");
    const peer = new CronStorage(cwd);
    storage.updateJobWith("j", () => {
      for (const operation of [
        () => peer.addJob(seed({ id: "peer" })), () => peer.removeJob("j"),
        () => peer.updateJob("j", { enabled: false }),
        () => peer.updateJobWith("j", () => ({ runCount: 99 })),
        () => peer.save({ version: 1, jobs: [] }),
        () => peer.expireJobIfDue("j", "s"),
      ]) expect(operation).toThrow(/Cannot acquire scheduled prompts lock/);
      expect(actualFs.readFileSync(storage.getStorePath(), "utf8")).toBe(bytes);
      return { runCount: 1 };
    });
    expect(peer.getJob("j")?.runCount).toBe(1);
    expect(actualFs.readdirSync(join(cwd, ".pi"))).toEqual(["schedule-prompts.json"]);
  });
  it("M7: token initialization failure never invokes the write callback", () => {
    vi.mocked(fs.writeFileSync).mockImplementation(((p: any, ...args: any[]) => {
      if (String(p).endsWith("owner")) throw new Error("token failure");
      return (actualFs.writeFileSync as any)(p, ...args);
    }) as any);
    expect(() => storage.addJob(seed())).toThrow(/Cannot initialize scheduled prompts lock/);
    expect(actualFs.readdirSync(join(cwd, ".pi"))).toEqual([]);
  });
  it.each([
    { enabled: "yes" }, { type: "invalid" }, { session: [] }, { model: {} },
    { notify: "false" }, { extensions: [null] }, { skills: {} },
    { runCount: "1" }, { runCount: -1 }, { lastStatus: {} },
    { intervalMs: -10 }, { intervalMs: null }, { lastRun: {} }, { createdAt: 1 },
  ])("L15: rejects corrupt element fields: %j", (partial) => {
    actualFs.mkdirSync(join(cwd, ".pi"));
    actualFs.writeFileSync(storage.getStorePath(), JSON.stringify({ version: 1, jobs: [seed({ id: "bad", ...partial } as any), seed()] }));
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["j"]);
    expect(storage.load().version).toBe(1);
  });
  it("L15: retains v1 missing optional stats and invalid endAt for scheduler fail-closed handling", () => {
    const j = seed({ type: "cron", schedule: "0 * * * * *", intervalMs: undefined, runCount: undefined, createdAt: undefined, endAt: null as any });
    storage.save({ version: 1, jobs: [j] });
    expect(storage.getJob("j")).toMatchObject({ endAt: null, enabled: true });
    scheduler = new CronScheduler(storage, makePi(), ctx);
    scheduler.start();
    expect(storage.getJob("j")?.enabled).toBe(false);
  });
  it("L16: rereads under lock rather than quarantining a valid peer replacement", () => {
    const target = storage.getStorePath();
    actualFs.mkdirSync(join(cwd, ".pi"));
    actualFs.writeFileSync(target, "{damaged");
    let first = true;
    vi.mocked(fs.readFileSync).mockImplementation(((p: any, ...args: any[]) => {
      if (String(p) === target && first) {
        first = false;
        actualFs.writeFileSync(target, JSON.stringify({ version: 1, jobs: [seed()] }));
        return "{damaged";
      }
      return (actualFs.readFileSync as any)(p, ...args);
    }) as any);
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["j"]);
    expect(actualFs.readdirSync(join(cwd, ".pi"))).toEqual(["schedule-prompts.json"]);
  });
  it("L16: refuses corruption recovery while a peer owns the lock, preserving the original", () => {
    const pi = join(cwd, ".pi"); actualFs.mkdirSync(pi);
    actualFs.writeFileSync(storage.getStorePath(), "{damaged");
    actualFs.mkdirSync(`${storage.getStorePath()}.lock`);
    expect(() => storage.load()).toThrow(/Cannot acquire scheduled prompts lock/);
    expect(actualFs.readFileSync(storage.getStorePath(), "utf8")).toBe("{damaged");
    expect(actualFs.readdirSync(pi).sort()).toEqual(["schedule-prompts.json", "schedule-prompts.json.lock"]);
  });
});

describe("scheduler checklist regressions", () => {
  it.each(["overlap", "capacity", "delivery-error"])("M5: once false fire is terminal (%s)", async (reason) => {
    vi.useFakeTimers();
    const j = seed({ type: "once", schedule: new Date(Date.now() + 1000).toISOString(), intervalMs: undefined, model: reason === "delivery-error" ? undefined : "fixture" });
    storage.addJob(j);
    const pi = makePi();
    scheduler = new CronScheduler(storage, pi, ctx);
    if (reason === "overlap") (scheduler as any).runningSubagentJobs.add("j");
    if (reason === "capacity") for (let n = 0; n < MAX_CONCURRENT_SUBAGENTS; n++) (scheduler as any).activeSubagents.add(new AbortController());
    if (reason === "delivery-error") pi.sendUserMessage.mockImplementation(() => { throw new Error("delivery failed"); });
    scheduler.addJob(j);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.getJob("j")).toMatchObject({ enabled: false, lastStatus: "error", runCount: 0 });
    expect(scheduler.getNextRun("j")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(reason === "delivery-error" ? 1 : 0);
    expect(runSubagentOnce).not.toHaveBeenCalled();
  });
  it.each([false, true])("L17: counts a peer completion between snapshot and commit (model=%s)", async (model) => {
    const j = seed({ model: model ? "fixture" : undefined }); storage.addJob(j);
    scheduler = new CronScheduler(storage, makePi(), ctx);
    vi.mocked(runSubagentOnce).mockResolvedValue({ ok: true, text: "done" });
    vi.spyOn(scheduler, "getNextRun").mockImplementationOnce(() => {
      new CronStorage(cwd).updateJobWith("j", (fresh) => ({ runCount: fresh.runCount + 1 }));
      return null;
    });
    expect(await (scheduler as any).fire(j)).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(storage.getJob("j")).toMatchObject({ runCount: 2, lastStatus: "success" });
  });
  it("L18: an unavailable session id cannot clear an unbound peer's running status", () => {
    storage.addJob(seed({ lastStatus: "running" }));
    scheduler = new CronScheduler(storage, makePi(), { isProjectTrusted: () => true, sessionManager: { getSessionId: () => undefined } } as any);
    scheduler.start();
    expect(storage.getJob("j")?.lastStatus).toBe("running");
  });
  it("L19: keeps the documented date-only UTC interpretation", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(CronScheduler.validateSchedule("once", "2030-01-02")).toEqual({ ok: true, schedule: "2030-01-02T00:00:00.000Z" });
  });
});

it("M6: coalesces change bursts, reads no disk during render, and cancels pending refresh on destroy", async () => {
  vi.useFakeTimers();
  storage.addJob(seed());
  const pi = makePi(), ui = { setWidget: vi.fn() };
  scheduler = new CronScheduler(storage, pi, ctx);
  const read = vi.spyOn(storage, "getAllJobs");
  const widget = new CronWidget(storage, scheduler, pi, () => true, "s");
  const onChange = pi.events.on.mock.calls[0][1];
  widget.show({ mode: "tui", ui });
  for (let n = 0; n < 50; n++) onChange();
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
  const theme = { fg: (_: any, s: any) => s, bold: (s: any) => s };
  const impl = ui.setWidget.mock.calls.at(-1)![1](null, theme);
  impl.render(100); impl.render(100);
  expect(read).toHaveBeenCalledTimes(2);
  onChange(); widget.destroy();
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("M6: a deferred refresh storage error is contained and hides stale state", async () => {
  vi.useFakeTimers(); storage.addJob(seed());
  const pi = makePi(), ui = { setWidget: vi.fn() };
  scheduler = new CronScheduler(storage, pi, ctx);
  const widget = new CronWidget(storage, scheduler, pi, () => true, "s");
  widget.show({ mode: "tui", ui });
  vi.spyOn(storage, "getAllJobs").mockImplementation(() => { throw new Error("store unreadable"); });
  pi.events.on.mock.calls[0][1]();
  await vi.advanceTimersByTimeAsync(100);
  expect(console.error).toHaveBeenCalledWith("Failed to refresh scheduled prompts widget:", expect.objectContaining({ message: "store unreadable" }));
  expect(ui.setWidget).toHaveBeenLastCalledWith("schedule-prompts", undefined);
  expect(vi.getTimerCount()).toBe(0);
  widget.destroy();
});
