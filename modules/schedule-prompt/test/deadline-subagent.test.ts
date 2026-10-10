import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

// Only the SDK boundary is mocked: the actual scheduler AND runner are used,
// so the test cannot pass merely by assuming the runner honors a callback.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn(function () { return { reload: vi.fn() }; }),
  getAgentDir: vi.fn(() => "/isolated-mocked-agent-dir"),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({})) },
}));
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const END = new Date(NOW + 1000).toISOString();
const MODEL = { id: "fixture", provider: "offline", name: "Fixture" };
let cwd: string;
let storage: CronStorage;
let scheduler: CronScheduler;
let active: any;
let pi: any;
let release: () => void;
let reached: Promise<void>;
let terminal: Promise<void>;
const ctx = { cwd: "/isolated-mocked-workspace", isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s" }, modelRegistry: { find: () => MODEL, getAvailable: () => [MODEL] } } as any;

function setup(stage: "reload" | "create" | "bind", endAt: string | undefined = END, once = false) {
  let entered!: () => void;
  reached = new Promise<void>((r) => { entered = r; });
  const paused = new Promise<void>((r) => { release = r; });
  const pause = () => { entered(); return paused; };
  let finish!: () => void;
  terminal = new Promise<void>((r) => { finish = r; });
  active = { prompt: vi.fn().mockResolvedValue(undefined), abort: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()), messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }], bindExtensions: vi.fn(stage === "bind" ? pause : async () => {}) };
  vi.mocked(DefaultResourceLoader).mockImplementation(function () {
    return { reload: vi.fn(stage === "reload" ? pause : async () => {}) } as any;
  });
  vi.mocked(createAgentSession).mockImplementation(async () => {
    if (stage === "create") await pause();
    return { session: active } as any;
  });
  pi = { sendUserMessage: vi.fn(), sendMessage: vi.fn((m: any) => {
    if (m.details.mode === "subagent_done" || m.details.mode === "subagent_error") finish();
  }), events: { emit: vi.fn() } };
  scheduler = new CronScheduler(storage, pi, ctx);
  const job: CronJob = { id: "j", name: "demo", enabled: true, type: once ? "once" : "interval", schedule: once ? new Date(NOW + 100).toISOString() : "1h", intervalMs: once ? undefined : 3600000, prompt: "p", model: "fixture", extensions: true, notify: true, createdAt: "", runCount: 7, lastStatus: "success", lastRun: "last", endAt, session: "s" };
  storage.addJob(job);
  scheduler.addJob(job);
  return job;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  cwd = mkdtempSync(join(tmpdir(), "pi-deadline-initialization-"));
  storage = new CronStorage(cwd);
});
afterEach(() => {
  scheduler?.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(cwd, { recursive: true, force: true });
});

describe("actual runner deadline admission after async initialization", () => {
  it.each(["reload", "create", "bind"] as const)("does not call prompt if %s finishes at the deadline", async (stage) => {
    const job = setup(stage);
    expect(await (scheduler as any).fire(job)).toBe(true);
    await reached;
    vi.setSystemTime(NOW + 1000); // no deadline callback runs: runner guard must enforce it
    release();
    await terminal;
    expect(active.prompt).not.toHaveBeenCalled();
    expect(active.dispose).toHaveBeenCalledTimes(1);
    expect(active.subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 7, lastStatus: "success", lastRun: "last" });
    expect(storage.getJob("j")?.nextRun).toBeUndefined();
    expect(pi.sendMessage.mock.calls.at(-1)).toHaveLength(1); // no notify followUp
    expect(pi.sendMessage.mock.calls.at(-1)[0].content[0].text).toContain("Skipped");
    expect((scheduler as any).runningSubagentJobs.size).toBe(0);
    expect((scheduler as any).activeSubagents.size).toBe(0);
  });
  it("honors a deadline newly set during initialization of an originally unlimited job", async () => {
    const job = setup("create", undefined);
    // Explicitly clear the fixture default to cover a genuine legacy/unlimited job.
    storage.updateJob("j", { endAt: undefined });
    expect(await (scheduler as any).fire(job)).toBe(true);
    await reached;
    storage.updateJob("j", { endAt: new Date(NOW).toISOString() });
    release(); await terminal;
    expect(active.prompt).not.toHaveBeenCalled();
    expect(storage.getJob("j")?.runCount).toBe(7);
  });
  it.each(["extend", "clear"] as const)("re-reads a deadline changed during initialization: %s", async (action) => {
    const job = setup("create");
    expect(await (scheduler as any).fire(job)).toBe(true);
    await reached;
    vi.setSystemTime(NOW + 1000);
    storage.updateJob("j", { endAt: action === "extend" ? new Date(NOW + 5000).toISOString() : undefined });
    release(); await terminal;
    expect(active.prompt).toHaveBeenCalledTimes(1);
    expect(active.dispose).toHaveBeenCalledTimes(1);
    expect(storage.getJob("j")).toMatchObject({ runCount: 8, lastStatus: "success" });
  });
  it.each(["extend", "clear"] as const)("does not bypass recurring disable when its expired deadline is changed without enable: %s", async (action) => {
    const job = setup("create");
    expect(await (scheduler as any).fire(job)).toBe(true);
    await reached;
    vi.setSystemTime(NOW + 1000);
    storage.expireJobIfDue("j", "s");
    const updates = { endAt: action === "extend" ? new Date(NOW + 5000).toISOString() : undefined };
    storage.updateJob("j", updates);
    scheduler.updateJob("j", storage.getJob("j")!);
    release(); await terminal;
    expect(active.prompt).not.toHaveBeenCalled();
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 7, lastRun: "last", lastStatus: "success" });
  });
  it("manual once disable during initialization revokes the auto-disable exception", async () => {
    setup("create", END, true);
    await vi.advanceTimersByTimeAsync(100);
    await reached;
    expect(storage.getJob("j")?.enabled).toBe(false);
    scheduler.updateJob("j", storage.getJob("j")!); // same explicit tool disable path
    release(); await terminal;
    expect(active.prompt).not.toHaveBeenCalled();
    expect(storage.getJob("j")?.runCount).toBe(7);
    expect((scheduler as any).autoDisabledOnceJobs.size).toBe(0);
  });
  it("does not reject a once job merely because it auto-disabled after admission", async () => {
    setup("create", END, true);
    await vi.advanceTimersByTimeAsync(100);
    await reached;
    expect(storage.getJob("j")?.enabled).toBe(false);
    release(); await terminal;
    expect(active.prompt).toHaveBeenCalledTimes(1);
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 8, lastStatus: "success" });
  });
  it("does not cancel a prompt that actually started before the deadline", async () => {
    const job = setup("reload");
    let started!: () => void;
    const prompted = new Promise<void>((r) => { started = r; });
    let complete!: () => void;
    active.prompt.mockImplementation(() => { started(); return new Promise<void>((r) => { complete = r; }); });
    expect(await (scheduler as any).fire(job)).toBe(true);
    await reached; release(); await prompted;
    vi.setSystemTime(NOW + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(active.abort).not.toHaveBeenCalled();
    complete(); await terminal;
    expect(storage.getJob("j")).toMatchObject({ enabled: false, runCount: 8, lastStatus: "success" });
    expect(pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ details: expect.objectContaining({ mode: "subagent_done", output: "done" }) }), { deliverAs: "followUp", triggerTurn: true });
  });
});
