import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadlineLabel, deadlineState, normalizeEndAt, validateJobDeadline } from "../src/deadline.js";
import { CronStorage } from "../src/storage.js";
import { createCronTool } from "../src/tool.js";
import type { CronJob } from "../src/types.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const END = "2030-01-01T01:00:00.000Z";
const job = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "j", name: "demo", type: "interval", schedule: "5m", intervalMs: 300000,
  prompt: "p", enabled: true, runCount: 3, lastStatus: "success", createdAt: "", ...overrides,
});
let cwd: string;
let storage: CronStorage;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  cwd = fs.mkdtempSync(join(tmpdir(), "pi-deadline-contract-"));
  storage = new CronStorage(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("deadline contract", () => {
  it("normalizes offset/UTC and valid leap days without guessing a timezone", () => {
    expect(normalizeEndAt("2030-01-01T09:00:00+08:00")).toBe(END);
    expect(normalizeEndAt("2030-01-01T01:00:00Z")).toBe(END);
    expect(normalizeEndAt("2032-02-29T01:00:00.1Z")).toBe("2032-02-29T01:00:00.100Z");
    const century = normalizeEndAt("2000-02-29T09:00:00+08:00");
    expect(normalizeEndAt(century)).toBe(century);
  });
  it.each([null, "", "+1h", "2030-01-01", "2030-01-01T01:00:00", "2030-02-29T01:00:00Z",
    "2030-04-31T01:00:00Z", "2030-00-01T01:00:00Z", "2030-01-00T01:00:00Z",
    "2030-01-01T24:00:00Z", "2030-01-01T01:60:00Z", "2030-01-01T01:00:60Z",
    "2030-01-01T01:00:00+24:00", "2030-01-01T01:00:00+01:60",
    "2100-02-29T01:00:00Z", "0000-01-01T00:00:00+01:00", "9999-12-31T23:00:00-01:00", 123])("rejects invalid input %s", (input) => {
    expect(() => normalizeEndAt(input)).toThrow(/endAt/);
    expect(deadlineState(input)).toBe("invalid");
  });
  it("has an exclusive boundary and distinguishes absent from invalid", () => {
    const end = Date.parse(END);
    expect(deadlineState(END, end - 1)).toBe("active");
    expect(deadlineState(END, end)).toBe("expired");
    expect(deadlineState(END, end + 1)).toBe("expired");
    expect(deadlineState(undefined)).toBe("none");
    expect(() => validateJobDeadline(job({ endAt: new Date(NOW).toISOString() }))).toThrow(/expired/);
    expect(() => validateJobDeadline(job({ type: "once", schedule: END, endAt: END }))).toThrow(/strictly/);
    expect(() => validateJobDeadline(job({ type: "once", schedule: "2030-01-01T00:30:00Z", endAt: END }))).not.toThrow();
  });
});

describe("conditional storage expiration", () => {
  it("disables only an expired job, clears nextRun, and keeps execution statistics", () => {
    storage.addJob(job({ endAt: new Date(NOW).toISOString(), nextRun: END, lastRun: "last" }));
    expect(storage.expireJobIfDue("j", "s").expired).toBe(true);
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 3, lastStatus: "success", lastRun: "last" });
    expect(storage.getJob("j")?.nextRun).toBeUndefined();
    expect(storage.expireJobIfDue("j", "s").expired).toBe(false);
    expect(fs.readdirSync(join(cwd, ".pi"))).toEqual(["schedule-prompts.json"]);
  });
  it.each([{ endAt: END }, {}, { endAt: "bad", session: "foreign" }, { endAt: "bad", enabled: false }])("leaves non-expirable state unchanged: %j", (overrides) => {
    storage.addJob(job(overrides));
    const before = fs.readFileSync(storage.getStorePath(), "utf8");
    expect(storage.expireJobIfDue("j", "s").expired).toBe(false);
    expect(fs.readFileSync(storage.getStorePath(), "utf8")).toBe(before);
  });
  it("re-reads a peer's extension/clear inside the mutation, not the caller's old snapshot", () => {
    storage.addJob(job({ endAt: new Date(NOW).toISOString() }));
    const peer = new CronStorage(cwd);
    peer.updateJob("j", { endAt: END });
    expect(storage.expireJobIfDue("j", "s")).toMatchObject({ expired: false, job: { enabled: true, endAt: END } });
    peer.updateJob("j", { endAt: undefined });
    expect(storage.expireJobIfDue("j", "s").expired).toBe(false);
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(storage.getStorePath(), "utf8")).jobs[0], "endAt")).toBe(false);
  });
  it("fails closed for invalid persisted deadlines without rewriting lastStatus", () => {
    storage.addJob(job({ endAt: null as any }));
    expect(storage.expireJobIfDue("j", "s")).toMatchObject({ expired: true, job: { enabled: false, lastStatus: "success" } });
  });
  it("does not fall through to an unlocked expiration when locking fails", () => {
    storage.addJob(job({ endAt: new Date(NOW).toISOString() }));
    const before = fs.readFileSync(storage.getStorePath(), "utf8");
    // Real contention, no implementation-specific clock budget or fixed sleep.
    const lock = `${storage.getStorePath()}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(join(lock, "owner"), "peer");
    expect(() => storage.expireJobIfDue("j", "s")).toThrow(/lock/);
    expect(fs.readFileSync(storage.getStorePath(), "utf8")).toBe(before);
    expect(fs.readFileSync(join(lock, "owner"), "utf8")).toBe("peer");
  });
  it("preserves an old version-1 job without adding a deadline", () => {
    storage.addJob(job());
    expect(storage.load().version).toBe(1);
    expect(storage.getJob("j")?.endAt).toBeUndefined();
  });
});

describe("schedule_prompt deadline actions", () => {
  const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => "s" } } as any;
  function execute(params: any) {
    const scheduler = { addJob: vi.fn(), updateJob: vi.fn(), removeJob: vi.fn(), getNextRun: () => null } as any;
    const tool = createCronTool(() => storage, () => scheduler);
    return tool.execute("call", params, undefined, undefined, ctx);
  }
  it("creates a normalized deadline and displays it", async () => {
    const result = await execute({ action: "add", name: "new", type: "interval", schedule: "5m", prompt: "p", endAt: "2030-01-01T09:00:00+08:00" });
    expect(result.details?.error).toBeUndefined();
    expect(result.details?.jobs[0].endAt).toBe(END);
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining(END) })]);
  });
  it.each([null, "bad", "2030-01-01T00:00:00Z"])("rejects bad add deadline %s without writing", async (endAt) => {
    const result = await execute({ action: "add", type: "interval", schedule: "5m", prompt: "p", endAt });
    expect(result.details?.error).toMatch(/endAt/);
    expect(storage.getAllJobs()).toEqual([]);
  });
  it("rejects a once schedule equal to or later than endAt", async () => {
    const result = await execute({ action: "add", type: "once", schedule: "+1h", prompt: "p", endAt: END });
    expect(result.details?.error).toMatch(/strictly/);
    expect(storage.getAllJobs()).toEqual([]);
  });
  it("preserves, replaces and clears the deadline on update, never auto-enabling", async () => {
    storage.addJob(job({ enabled: false, endAt: END }));
    expect((await execute({ action: "update", jobId: "j", prompt: "new" })).details?.jobs[0].endAt).toBe(END);
    expect((await execute({ action: "update", jobId: "j", endAt: "2030-01-01T02:00:00Z" })).details?.jobs[0].endAt).toBe("2030-01-01T02:00:00.000Z");
    const cleared = await execute({ action: "update", jobId: "j", endAt: null });
    expect(cleared.details?.jobs[0]).toMatchObject({ enabled: false });
    expect(storage.getJob("j")?.endAt).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(storage.getStorePath(), "utf8")).jobs[0], "endAt")).toBe(false);
  });
  it("validates the merged once schedule on either field's update", async () => {
    storage.addJob(job({ type: "once", schedule: "2030-01-01T00:30:00Z", endAt: END }));
    expect((await execute({ action: "update", jobId: "j", schedule: "+2h" })).details?.error).toMatch(/strictly/);
    expect((await execute({ action: "update", jobId: "j", endAt: "2030-01-01T00:15:00Z" })).details?.error).toMatch(/strictly/);
    expect(storage.getJob("j")?.endAt).toBe(END);
  });
  it("allows editing expired history but rejects enabling until extended/cleared", async () => {
    storage.addJob(job({ enabled: false, endAt: new Date(NOW).toISOString() }));
    expect((await execute({ action: "update", jobId: "j", description: "history" })).details?.error).toBeUndefined();
    expect((await execute({ action: "enable", jobId: "j" })).details?.error).toMatch(/expired/);
    await execute({ action: "update", jobId: "j", endAt: null });
    expect(storage.getJob("j")?.enabled).toBe(false);
    expect((await execute({ action: "enable", jobId: "j" })).details?.error).toBeUndefined();
    expect(storage.getJob("j")?.enabled).toBe(true);
  });
  it("shows expiration independently of the last execution status", async () => {
    storage.addJob(job({ enabled: false, endAt: new Date(NOW).toISOString() }));
    const result = await execute({ action: "list" });
    expect((result.content[0] as any).text).toContain("(expired)");
    expect((result.content[0] as any).text).toContain("success");
    expect(deadlineLabel(undefined)).toBe("No deadline");
  });
});
