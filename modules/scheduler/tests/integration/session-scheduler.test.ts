import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "../../src/domain.js";
import { RegistryStore } from "../../src/registry-store.js";
import { RunStore } from "../../src/run-store.js";
import { SessionScheduler } from "../../src/session-scheduler.js";

const directories: string[] = [];
const schedulers: SessionScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.shutdown();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function setup(idle = true, admissionTimeoutMs = 10_000) {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-session-")); directories.push(directory);
  const registry = new RegistryStore({ registryPath: join(directory, "registry.json"), lockPath: join(directory, "lock"), now: () => "2026-09-17T00:00:00.000Z" });
  const runs = new RunStore({ runsPath: join(directory, "runs.jsonl"), lockPath: join(directory, "lock"), logsDir: join(directory, "logs") });
  const oldModel = { provider: "old", id: "old-model", contextWindow: 272_000, input: ["text"] };
  const targetModel = { provider: "new", id: "new-model" };
  let currentModel: { provider: string; id: string; contextWindow?: number; input?: string[] } = oldModel;
  let thinking: ThinkingLevel = "low";
  const controller = new AbortController();
  const setModel = vi.fn(async (model: typeof currentModel) => { currentModel = model; thinking = "medium"; return true; });
  const setThinkingLevel = vi.fn((level: ThinkingLevel) => { thinking = level; });
  const sendUserMessage = vi.fn(); const setSessionName = vi.fn();
  const pi = { setModel, setThinkingLevel, getThinkingLevel: () => thinking, setSessionName, sendUserMessage };
  const scheduler = new SessionScheduler({ registry, runs, pi: pi as never, admissionTimeoutMs, clock: { now: () => new Date("2026-09-17T00:00:00.000Z") } });
  const ctx = {
    get model() { return currentModel; },
    modelRegistry: { find: (provider: string, id: string) => provider === "new" && id === "new-model" ? targetModel : undefined },
    sessionManager: { getSessionId: () => "session-1" }, isIdle: () => idle, hasPendingMessages: vi.fn(() => false),
    signal: controller.signal, abort: vi.fn(() => controller.abort()), ui: { notify: vi.fn() },
  };
  schedulers.push(scheduler); await scheduler.start(ctx as never);
  const schedule = await registry.create({ id: "session-schedule", mode: "session", prompt: "scheduled work", cwd: process.cwd(), targetSessionId: "session-1",
    timing: { kind: "once", expression: "2030-01-01T00:00:00.000Z", timezone: "Asia/Taipei" }, title: "Daily review",
    execution: { provider: "new", model: "new-model", thinkingLevel: "high" } });
  return { registry, runs, scheduler, ctx, schedule, oldModel, targetModel, pi, getThinking: () => thinking, setIdle: (value: boolean) => { idle = value; } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function begin(f: Fixture) {
  const prompt = f.pi.sendUserMessage.mock.calls.at(-1)![0] as string;
  await f.scheduler.messageStarted({ type: "message_start", message: { role: "user", content: prompt, timestamp: 1 } } as never, f.ctx as never);
}
async function finish(f: Fixture, stopReason = "stop", errorMessage?: string) {
  f.scheduler.agentEnded({ type: "agent_end", messages: [{ role: "assistant", provider: "new", model: "new-model", content: [{ type: "text", text: "done" }], stopReason, errorMessage }] } as never);
  await f.scheduler.settled();
}

describe("session-affine scheduler", () => {
  it("recovers after shutdown cancellation persistence fails without trapping profile ownership", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f);
    vi.spyOn(f.runs, "requestCancellation").mockRejectedValueOnce(new Error("injected shutdown EIO"));
    await expect(f.scheduler.shutdown()).rejects.toThrow("shutdown EIO");
    expect(f.getThinking()).toBe("low"); expect(f.scheduler.profileOwnershipActive).toBe(false);
    await f.scheduler.start(f.ctx as never);
    expect(f.scheduler.handleInput({ source: "interactive", text: "normal" } as never, f.ctx as never)).toBeUndefined();
    expect((await f.runs.list())[0].status).toBe("orphaned");
  });
  it("standby instances do not abort the lock owner's correlated prompt", async () => {
    const f = await setup(); const follower = new SessionScheduler({ registry: f.registry, runs: f.runs, pi: f.pi as never });
    schedulers.push(follower); await follower.start(f.ctx as never); await f.scheduler.dispatch(f.schedule);
    const prompt = f.pi.sendUserMessage.mock.calls.at(-1)![0];
    await follower.messageStarted({ message: { role: "user", content: prompt } } as never, f.ctx as never);
    expect(f.ctx.abort).not.toHaveBeenCalled(); await begin(f); await finish(f);
  });
  it("cancellation at the last submitted boundary prevents prompt dispatch", async () => {
    const f = await setup(); const submit = f.runs.submitQueued.bind(f.runs);
    vi.spyOn(f.runs, "submitQueued").mockImplementationOnce(async (id, at, callback) => { await f.runs.requestCancellation(id, at); return submit(id, at, callback); });
    expect((await f.scheduler.dispatch(f.schedule)).status).toBe("cancelled");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled(); expect(f.pi.setModel).toHaveBeenLastCalledWith(f.oldModel);
  });
  it("consumes overlapping once callbacks as submitted then skipped_busy, acknowledging running only on matching message_start", async () => {
    const f = await setup(); const second = await f.registry.create({ ...f.schedule, id: "second" });
    const [a, b] = await Promise.all([f.scheduler.dispatch(f.schedule), f.scheduler.dispatch(second)]);
    expect(a.status).toBe("queued"); expect(a.startedAt).toBeUndefined(); expect(b.status).toBe("skipped_busy");
    await begin(f); expect((await f.runs.list())[0].status).toBe("running");
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1); expect((await f.registry.list()).every((s) => !!s.lastPlannedAt)).toBe(true);
  });
  it("shutdown waits for profile preflight and prevents a prompt after shutdown", async () => {
    const f = await setup(); let release!: (value: boolean) => void;
    f.pi.setModel.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const dispatch = f.scheduler.dispatch(f.schedule); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const shutdown = f.scheduler.shutdown(); release(true);
    expect((await dispatch).status).toBe("cancelled"); await shutdown;
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled(); expect(f.pi.setModel).toHaveBeenLastCalledWith(f.oldModel);
  });
  it("permits only one host for the same session and allows takeover", async () => {
    const f = await setup(); const follower = new SessionScheduler({ registry: f.registry, runs: f.runs, pi: f.pi as never });
    schedulers.push(follower); await follower.start(f.ctx as never); await expect(follower.dispatch(f.schedule)).rejects.toThrow("active owner");
    await f.scheduler.shutdown(); await follower.refresh(); expect((await follower.dispatch(f.schedule)).status).toBe("queued");
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });
  it("applies the profile, guards all unrelated input, and restores after correlated completion", async () => {
    const f = await setup(); expect((await f.scheduler.dispatch(f.schedule)).status).toBe("queued");
    expect(f.pi.setModel).toHaveBeenCalledWith(f.targetModel); expect(f.getThinking()).toBe("high");
    expect(f.pi.setSessionName).toHaveBeenCalledWith("Daily review");
    expect(f.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^\[\[pi-scheduler:.+\]\]\nscheduled work$/), { expandPromptTemplates: false });
    for (const source of ["interactive", "rpc", "extension"]) expect(f.scheduler.handleInput({ source, text: "manual" } as never, f.ctx as never)).toEqual({ action: "handled" });
    await begin(f); await finish(f);
    expect(f.pi.setModel).toHaveBeenLastCalledWith(f.oldModel); expect(f.getThinking()).toBe("low"); expect((await f.runs.list())[0].status).toBe("succeeded");
  });
  it("preserves user changes and cancels started work with one abort", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f);
    await f.pi.setModel({ provider: "user", id: "choice" }); f.scheduler.onModelChanged({ provider: "user", id: "choice" }); await finish(f);
    expect((await f.runs.list())[0].events.map((event) => event.type)).toContain("restore_skipped_user_change");
    const active = await f.registry.create({ ...f.schedule, id: "session-schedule-2" }); await f.scheduler.dispatch(active); await begin(f);
    await f.scheduler.cancel(active.id); await f.scheduler.cancel(active.id);
    expect(f.ctx.abort).toHaveBeenCalledTimes(1); expect((await f.registry.list()).find((item) => item.id === active.id)!.state).toBe("cancelled");
    expect((await f.runs.list()).at(-1)!.events.filter((event) => event.type === "abort_requested")).toHaveLength(1);
    await finish(f, "aborted"); expect((await f.runs.list()).at(-1)!.status).toBe("cancelled");
  });
  it("installs a current-session timer for schedules created after session_start", async () => {
    const f = await setup(); await f.scheduler.shutdown();
    const due = new Date("2030-01-01T00:01:00.000Z"), timers: Array<() => void> = []; let now = new Date("2030-01-01T00:00:00.000Z");
    // Remove the fixture's once schedule so only the newly created timer is counted.
    await f.registry.setState(f.schedule.id, f.schedule.revision, "cancelled");
    const scheduler = new SessionScheduler({ registry: f.registry, runs: f.runs, pi: f.pi as never, clock: { now: () => now },
      cronClock: { now: () => now, setTimeout: (callback) => { timers.push(callback); return { clear: () => undefined }; } } });
    schedulers.push(scheduler); await scheduler.start(f.ctx as never); expect(timers).toHaveLength(0);
    await f.registry.create({ id: "created-after-start", mode: "session", prompt: "scheduled work", cwd: process.cwd(), targetSessionId: "session-1",
      timing: { kind: "once", expression: due.toISOString(), timezone: "Asia/Taipei" } });
    await scheduler.refresh(); expect(timers).toHaveLength(1); now = due; timers[0]!();
    // The fake clock fires the timer; wait on the persisted outcome. sendUserMessage runs inside the history lock before the
    // submit diagnostic is written, so asserting right after the call could read runs.jsonl mid-write (rename on Windows).
    await vi.waitFor(async () => {
      expect((await f.runs.list())[0]?.events.some((event) => event.detail?.startsWith("session_prompt_submitted"))).toBe(true);
    }, { timeout: 15_000, interval: 20 });
    expect(f.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("\nscheduled work"), { expandPromptTemplates: false });
    expect((await f.runs.list())[0]?.status).toBe("queued"); expect((await f.runs.list())[0]?.startedAt).toBeUndefined();
  });
  it("records a one-shot that is already past at session start as a persisted missed run and never sends it", async () => {
    const f = await setup(); await f.scheduler.shutdown();
    await f.registry.setState(f.schedule.id, f.schedule.revision, "cancelled");
    await f.registry.create({ id: "already-past", mode: "session", prompt: "late work", cwd: process.cwd(), targetSessionId: "session-1",
      timing: { kind: "once", expression: "2020-01-01T00:00:00.000Z", timezone: "UTC" } });
    const scheduler = new SessionScheduler({ registry: f.registry, runs: f.runs, pi: f.pi as never, clock: { now: () => new Date("2030-01-01T00:00:00.000Z") } });
    schedulers.push(scheduler); await scheduler.start(f.ctx as never);
    const runs = await f.runs.list();
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ scheduleId: "already-past", status: "missed", events: [] });
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("releases input interception and marks the run orphaned when history finalization keeps failing", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f);
    const finishSpy = vi.spyOn(f.runs, "finish").mockRejectedValue(new Error("injected persistent EIO"));
    await finish(f);
    expect(finishSpy).toHaveBeenCalledTimes(4); // 3 bounded attempts + one orphaned attempt
    expect(f.scheduler.profileOwnershipActive).toBe(false);
    expect(f.scheduler.handleInput({ source: "interactive", text: "normal" } as never, f.ctx as never)).toBeUndefined();
    expect(f.scheduler.lastError).toContain("persistent EIO");
    finishSpy.mockRestore();
    // The persisted run stays non-terminal, so it remains a dispatch barrier until recovery orphans it.
    expect((await f.runs.list())[0].status).toBe("running");
  });
  it("skips busy sessions instead of queueing a prompt", async () => {
    const f = await setup(false); expect((await f.scheduler.dispatch(f.schedule)).status).toBe("skipped_busy"); expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("reserves input ownership before append IO and rechecks idle after the yield (RISK-001)", async () => {
    const f = await setup(); const append = f.runs.append.bind(f.runs); let guarded: unknown;
    vi.spyOn(f.runs, "append").mockImplementationOnce(async (run) => {
      guarded = f.scheduler.handleInput({ source: "interactive", text: "racing user" } as never, f.ctx as never);
      f.setIdle(false); await append(run);
    });
    expect((await f.scheduler.dispatch(f.schedule)).status).toBe("skipped_busy"); expect(guarded).toEqual({ action: "handled" });
    expect(f.pi.setModel).not.toHaveBeenCalled(); expect(f.pi.sendUserMessage).not.toHaveBeenCalled(); expect(f.scheduler.profileOwnershipActive).toBe(false);
  });
  it("does not submit when pending messages exist despite idle", async () => {
    const f = await setup(); f.ctx.hasPendingMessages.mockReturnValue(true);
    expect((await f.scheduler.dispatch(f.schedule)).status).toBe("skipped_busy"); expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("does not complete new submitted work on an old settled event (RISK-002)", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await f.scheduler.settled();
    expect((await f.runs.list())[0].status).toBe("queued"); expect(f.scheduler.profileOwnershipActive).toBe(true);
    await begin(f); await finish(f); expect((await f.runs.list())[0].status).toBe("succeeded");
  });
  it("classifies the final retry response instead of latching an earlier assistant failure", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f);
    f.scheduler.messageEnded({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary error" } } as never);
    await finish(f, "stop"); expect((await f.runs.list())[0].status).toBe("succeeded");
  });
  it.each(["error", "pending", "toolUse", "deferred"])("does not call %s terminal response a success", async (reason) => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f); await finish(f, reason, "terminal diagnostic");
    expect((await f.runs.list())[0].status).toBe("failed"); expect((await f.runs.list())[0].error).toBe("terminal diagnostic");
  });
  it("does not infer success from settlement without an assistant response", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f); await f.scheduler.settled();
    expect((await f.runs.list())[0].status).toBe("failed"); expect((await f.runs.list())[0].error).toMatch(/missing/);
  });
  it.each(["false", "throw"])("finalizes and blocks further profiles if model restoration returns %s (BUG-005)", async (failure) => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f);
    if (failure === "false") f.pi.setModel.mockResolvedValueOnce(false); else f.pi.setModel.mockRejectedValueOnce(new Error("restore failure"));
    await finish(f); const run = (await f.runs.list())[0];
    expect(run.status).toBe("failed"); expect(run.restoreError).toBeTruthy(); expect(run.events.some((event) => event.detail?.startsWith("restore_failed"))).toBe(true);
    expect(f.scheduler.profileOwnershipActive).toBe(false); expect(f.scheduler.lastError).toBeTruthy();
    const next = await f.registry.create({ ...f.schedule, id: "blocked-after-restore" }); expect((await f.scheduler.dispatch(next)).status).toBe("skipped_busy");
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });
  it("cancellation preserves restoration errors as a separate diagnostic", async () => {
    const f = await setup(); const run = await f.scheduler.dispatch(f.schedule); await begin(f);
    f.pi.setModel.mockRejectedValueOnce(new Error("restore denied")); await f.scheduler.cancelActiveRun(run.runId); await finish(f, "aborted");
    expect((await f.runs.list())[0].status).toBe("cancelled"); expect((await f.runs.list())[0].restoreError).toBe("restore denied");
  });
  it("fails preflight without dispatch and restores after a profile setter throws", async () => {
    const f = await setup(); f.pi.setThinkingLevel.mockImplementationOnce(() => { throw new Error("thinking setter failed"); });
    expect((await f.scheduler.dispatch(f.schedule)).status).toBe("failed_preflight"); expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.getThinking()).toBe("low"); expect(f.scheduler.profileOwnershipActive).toBe(false);
  });
  it("reconciles only its own stale session runs and retains an orphan dispatch barrier (BUG-006)", async () => {
    const f = await setup(); await f.scheduler.shutdown();
    for (const [runId, targetSessionId] of [["stale-own", "session-1"], ["stale-other", "session-2"]]) await f.runs.append({ runId, targetSessionId, scheduleId: f.schedule.id,
      mode: "session", status: "running", plannedAt: "2026-09-17T00:00:00Z", events: [] });
    await f.scheduler.start(f.ctx as never); const runs = await f.runs.list();
    expect(runs.find((run) => run.runId === "stale-own")!.status).toBe("orphaned"); expect(runs.find((run) => run.runId === "stale-other")!.status).toBe("running");
    expect((await f.scheduler.dispatch(f.schedule)).status).toBe("skipped_busy"); expect(f.ctx.abort).not.toHaveBeenCalled(); expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("shutdown leaves an orphan barrier rather than claiming a started agent actually stopped", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f); await f.scheduler.shutdown();
    expect((await f.runs.list())[0].status).toBe("orphaned"); expect(f.ctx.abort).toHaveBeenCalledTimes(1);
  });
  it("ignores delayed stale thinking self-events and notices a real user thinking change", async () => {
    const f = await setup(); await f.scheduler.dispatch(f.schedule); await begin(f);
    f.scheduler.onThinkingChanged("medium"); await f.pi.setThinkingLevel("low"); f.scheduler.onThinkingChanged("low"); await finish(f);
    expect((await f.runs.list())[0].events.some((event) => event.type === "restore_skipped_user_change")).toBe(true);
    expect(f.getThinking()).toBe("low");
  });
});
