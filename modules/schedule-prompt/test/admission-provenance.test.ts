import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChildFailure, runSubagentOnce } from "../src/subagent.js";
import { CronScheduler } from "../src/scheduler.js";
import { createCronTool, isInScheduledExecution } from "../src/tool.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  // biome-ignore lint/complexity/useArrowFunction: used as a constructor mock
  DefaultResourceLoader: vi.fn(function () {
    return { reload: vi.fn().mockResolvedValue(undefined) };
  }),
  getAgentDir: vi.fn(() => "/tmp/agent-dir"),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({ marker: "shared-settings" })) },
}));

import { createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const MODEL = { id: "gpt-4o", name: "GPT-4o", provider: "openai" };
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = () => ({ type: "message", message: { role: "assistant", content: [] } });
const marker = (details: Record<string, unknown>) => ({ type: "custom_message", customType: "scheduled_prompt", details });
const branch = (entries: any[]) => ({ getBranch: () => entries });

describe("D06: recursion guard uses real entry type and the current run", () => {
  it("blocks the turn started by an inline scheduled prompt (custom_message + matching user message)", () => {
    expect(isInScheduledExecution(branch([user("hi"), assistant(), marker({ prompt: "P" }), user("P")]))).toBe(true);
  });
  it("does not block a later ordinary turn behind a finished scheduled run", () => {
    expect(isInScheduledExecution(branch([marker({ prompt: "P" }), user("P"), assistant(), user("please schedule X")]))).toBe(false);
  });
  it("blocks a notify child result turn, not a silent one", () => {
    const m = { prompt: "P", mode: "subagent_done" };
    expect(isInScheduledExecution(branch([user("x"), assistant(), marker({ ...m, notify: true })]))).toBe(true);
    expect(isInScheduledExecution(branch([user("x"), assistant(), marker(m)]))).toBe(false);
  });
  it("ignores the legacy type=custom shape that the scheduler never writes", () => {
    expect(isInScheduledExecution(branch([{ type: "custom", customType: "scheduled_prompt" }, user("P")]))).toBe(false);
  });
});

describe("D08: tool failures are isError results", () => {
  it("returns isError for a missing job and keeps details.error", async () => {
    const storage = { getJob: () => undefined, getAllJobs: () => [] } as any;
    const tool = createCronTool(() => storage, () => ({}) as any);
    const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s" } } as any;
    const result: any = await tool.execute("c", { action: "remove", jobId: "nope" } as any, undefined as any, undefined as any, ctx);
    expect(result.isError).toBe(true);
    expect(result.details.error).toMatch(/not found/i);
    const ok: any = await tool.execute("c", { action: "list" } as any, undefined as any, undefined as any, ctx);
    expect(ok.isError).toBeUndefined();
  });
});

describe("D09: child terminal outcome", () => {
  it("classifies aborted, error, missing and normal completions", () => {
    const s = (messages: any[]) => ({ messages }) as any;
    expect(getChildFailure(s([{ role: "assistant", stopReason: "aborted" }]))).toMatch(/aborted/i);
    expect(getChildFailure(s([{ role: "assistant", stopReason: "error", errorMessage: "boom" }]))).toBe("boom");
    expect(getChildFailure(s([]))).toMatch(/without an assistant response/);
    expect(getChildFailure(s([]), "streamed")).toBeUndefined();
    expect(getChildFailure(s([{ role: "assistant", stopReason: "stop" }]))).toBeUndefined();
  });
});

describe("D02/D04: child session trust and awaited shutdown", () => {
  const mockCreate = vi.mocked(createAgentSession);
  beforeEach(() => mockCreate.mockReset());
  const ctx = (trusted: boolean) => ({ cwd: "/tmp", isProjectTrusted: () => trusted, modelRegistry: { find: () => MODEL, getAvailable: () => [MODEL] } }) as any;

  it("creates one trust-aware SettingsManager shared by loader and SDK", async () => {
    mockCreate.mockResolvedValue({ session: { abort: vi.fn(), subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", stopReason: "stop", content: [] }], dispose: vi.fn() } } as any);
    await runSubagentOnce(ctx(false), "p", MODEL.id);
    const create = vi.mocked(SettingsManager.create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][2]).toEqual({ projectTrusted: false });
    const shared = create.mock.results[0].value;
    expect((vi.mocked(DefaultResourceLoader).mock.calls.at(-1)![0] as any).settingsManager).toBe(shared);
    expect((mockCreate.mock.calls[0][0] as any).settingsManager).toBe(shared);
  });

  it("awaits the child's session_shutdown before returning and reports cleanup failure", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = { hasHandlers: () => true, emit: vi.fn(async () => { await gate; order.push("shutdown"); throw new Error("child cleanup failed"); }) };
    const session = { abort: vi.fn(), subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", stopReason: "stop", content: [] }], extensionRunner: runner, dispose: vi.fn(() => order.push("dispose")), bindExtensions: vi.fn() };
    mockCreate.mockResolvedValue({ session } as any);
    const done = runSubagentOnce(ctx(true), "p", MODEL.id, undefined, { extensions: true }).then((r) => { order.push("returned"); return r; });
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual([]);
    release();
    const result = await done;
    expect(order).toEqual(["shutdown", "dispose", "returned"]);
    expect(runner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(result.cleanupError).toMatch(/child cleanup failed/);
  });
});

describe("D02: scheduler admission", () => {
  const storage = { getAllJobs: vi.fn(() => [{ id: "j", name: "j", enabled: true, type: "interval", schedule: "1s", intervalMs: 1000, prompt: "p", runCount: 0, createdAt: "" }]), getJob: vi.fn() } as any;
  it("does not start project jobs when the project is untrusted", () => {
    vi.useFakeTimers();
    try {
      const sch = new CronScheduler(storage, { events: { emit: vi.fn() } } as any, { isProjectTrusted: () => false, sessionManager: { getSessionId: () => "s" } } as any);
      sch.start();
      expect(vi.getTimerCount()).toBe(0);
      expect(sch.getNextRun("j")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("fails closed when the context cannot report trust (missing method or throwing probe)", () => {
    vi.useFakeTimers();
    try {
      for (const probe of [undefined, () => { throw new Error("stale context"); }]) {
        const sch = new CronScheduler(storage, { events: { emit: vi.fn() } } as any, { isProjectTrusted: probe, sessionManager: { getSessionId: () => "s" } } as any);
        sch.start();
        expect(vi.getTimerCount()).toBe(0);
        expect(sch.getNextRun("j")).toBeNull();
      }
    } finally { vi.useRealTimers(); }
  });
  it("drain returns once accepted child runs settle and stop closes admission", async () => {
    const sch = new CronScheduler(storage, {} as any, { sessionManager: { getSessionId: () => "s" } } as any);
    sch.stop();
    expect(await (sch as any).fire({ id: "j" })).toBe(false);
    expect(await sch.drain(10)).toEqual({ pending: 0, cleanupFailures: [] });
  });
});
