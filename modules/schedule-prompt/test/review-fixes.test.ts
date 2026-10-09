import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { CronWidget } from "../src/ui/cron-widget.js";

vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));

const makePi = () => ({ sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }) as any;
const ctxFor = (id = "s") => ({ cwd: "/tmp", modelRegistry: {}, sessionManager: { getSessionId: () => id } }) as any;
const job = (o: Partial<CronJob> = {}): CronJob =>
  ({ id: "j", name: "demo", schedule: "5m", prompt: "p", enabled: true, type: "interval", intervalMs: 300000, createdAt: "", runCount: 0, ...o }) as CronJob;

let cwd: string;
let storage: CronStorage;
beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), "pi-sp-review-"));
  storage = new CronStorage(cwd);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("storage (M7, L15, L17)", () => {
  it("does not remove a lock a peer took over while we held it", () => {
    storage.addJob(job());
    const lock = join(cwd, ".pi", "schedule-prompts.json.lock");
    storage.updateJobWith("j", () => {
      fs.writeFileSync(join(lock, "owner"), "peer-token"); // peer stole it as stale
      return {};
    });
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(join(lock, "owner"), "utf8")).toBe("peer-token");
  });

  it("refuses even an old lock: its age cannot prove a peer is dead", () => {
    const pi = join(cwd, ".pi");
    fs.mkdirSync(pi);
    const lock = join(pi, "schedule-prompts.json.lock");
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(() => storage.addJob(job())).toThrow(/Cannot acquire scheduled prompts lock/);
    expect(fs.readdirSync(pi).sort()).toEqual(["schedule-prompts.json.lock"]);
  });

  it("drops malformed job elements instead of throwing on every operation", () => {
    const pi = join(cwd, ".pi");
    fs.mkdirSync(pi);
    fs.writeFileSync(join(pi, "schedule-prompts.json"), JSON.stringify({ version: 1, jobs: [null, 5, "x", {}, job()] }));
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["j"]);
    expect(storage.getJob("missing")).toBeUndefined();
    expect(() => storage.updateJob("j", { enabled: false })).not.toThrow();
  });

  it("increments runCount from the freshly locked on-disk value", () => {
    storage.addJob(job({ runCount: 1 }));
    // A peer bumps the count after the scheduler snapshot was taken.
    storage.updateJob("j", { runCount: 10 });
    storage.updateJobWith("j", (cur) => ({ runCount: (cur.runCount ?? 0) + 1 }));
    expect(storage.getJob("j")?.runCount).toBe(11);
  });
});

describe("scheduler (L14, L18, M5, L19)", () => {
  function mem(seed: CronJob[]) {
    const jobs = new Map(seed.map((j) => [j.id, j]));
    return {
      updateJob: vi.fn((id: string, p: Partial<CronJob>) => { const j = jobs.get(id); if (!j) return false; Object.assign(j, p); return true; }),
      updateJobWith: (id: string, fn: (j: CronJob) => Partial<CronJob>) => { const j = jobs.get(id); if (!j) return false; Object.assign(j, fn(j)); return true; },
      getJob: (id: string) => jobs.get(id),
      getAllJobs: () => Array.from(jobs.values()),
    } as any;
  }

  it("L14: getNextRun answers for interval and once jobs", () => {
    vi.useFakeTimers();
    const iv = job({ id: "iv", intervalMs: 1000, schedule: "1s" });
    const target = new Date(Date.now() + 60_000);
    const once = job({ id: "o", type: "once", schedule: target.toISOString(), intervalMs: undefined });
    const s = new CronScheduler(mem([iv, once]), makePi(), ctxFor());
    const t0 = Date.now();
    s.addJob(iv);
    s.addJob(once);
    expect(s.getNextRun("iv")?.getTime()).toBe(t0 + 1000);
    expect(s.getNextRun("o")?.getTime()).toBe(target.getTime());
    vi.advanceTimersByTime(2500);
    expect(s.getNextRun("iv")?.getTime()).toBe(t0 + 3000);
    s.stop();
    expect(s.getNextRun("iv")).toBeNull();
  });

  it("L18: start() clears running only for this session jobs, not unbound/foreign", () => {
    const mine = job({ id: "m", type: "cron", schedule: "0 0 * * * *", session: "s", lastStatus: "running" });
    const unbound = job({ id: "u", type: "cron", schedule: "0 0 * * * *", lastStatus: "running" });
    const foreign = job({ id: "f", type: "cron", schedule: "0 0 * * * *", session: "x", lastStatus: "running" });
    const st = mem([mine, unbound, foreign]);
    const s = new CronScheduler(st, makePi(), ctxFor("s"));
    s.start();
    s.stop();
    expect(st.getJob("m").lastStatus).toBeUndefined();
    expect(st.getJob("u").lastStatus).toBe("running");
    expect(st.getJob("f").lastStatus).toBe("running");
  });

  it("M5: a skipped once job is immediately disabled with an error (no retry)", async () => {
    vi.useFakeTimers();
    const once = job({ type: "once", schedule: new Date(Date.now() + 1000).toISOString(), intervalMs: undefined, model: "m" });
    const st = mem([once]);
    const pi = makePi();
    const s = new CronScheduler(st, pi, ctxFor());
    (s as any).runningSubagentJobs.add("j"); // previous run still in flight => every fire is skipped
    s.addJob(once);
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.getNextRun("j")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180000);
    expect(st.getJob("j")).toMatchObject({ enabled: false, lastStatus: "error" });
    expect(pi.events.emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "error", jobId: "j" }));
    s.stop();
  });

  it("M5: a false once result cannot silently re-arm or deliver later", async () => {
    vi.useFakeTimers();
    const once = job({ type: "once", schedule: new Date(Date.now() + 1000).toISOString(), intervalMs: undefined });
    const st = mem([once]);
    const s = new CronScheduler(st, makePi(), ctxFor());
    const fire = vi.spyOn(s as any, "executeJob").mockResolvedValueOnce(false).mockResolvedValue(true);
    s.addJob(once);
    await vi.advanceTimersByTimeAsync(180000);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(st.getJob("j")).toMatchObject({ enabled: false, lastStatus: "error" });
    expect(vi.getTimerCount()).toBe(0);
    s.stop();
  });

  it("L19: rejects +0s and out-of-range relative times with clear errors", () => {
    expect(CronScheduler.parseRelativeTime("+0s")).toBeNull();
    const zero = CronScheduler.validateSchedule("once", "+0s");
    expect(zero.ok).toBe(false);
    expect(!zero.ok && zero.error).toMatch(/greater than zero/);
    const huge = CronScheduler.validateSchedule("once", "+99999999999999999d");
    expect(huge.ok).toBe(false);
    expect(!huge.ok && huge.error).toMatch(/too far/);
    expect(CronScheduler.validateSchedule("once", "+1s").ok).toBe(true);
  });
});

describe("widget (M6)", () => {
  it("reads storage once per show(), not per render", () => {
    const j = job({ type: "cron", schedule: "0 * * * * *" });
    const st = { getAllJobs: vi.fn(() => [j]), getJob: vi.fn(() => j) } as any;
    const sched = { getNextRun: vi.fn(() => null) } as any;
    const ctx = { ui: { setWidget: vi.fn() } };
    const w = new CronWidget(st, sched, makePi(), () => true, "s");
    w.show(ctx);
    const theme = new Proxy({}, { get: () => (a: any, b?: any) => (typeof a === "string" && b === undefined ? a : b ?? a) });
    const impl = ctx.ui.setWidget.mock.calls[0][1](null, theme);
    const reads = st.getAllJobs.mock.calls.length;
    impl.render(100); impl.render(100); impl.render(100);
    expect(st.getAllJobs.mock.calls.length).toBe(reads);
    expect(st.getJob).not.toHaveBeenCalled();
    expect(sched.getNextRun).toHaveBeenCalledWith("j", j); // cached job passed, no storage read
    w.destroy();
  });
});
