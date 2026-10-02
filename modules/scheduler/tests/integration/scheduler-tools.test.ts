import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryStore } from "../../src/registry-store.js";
import { RunStore } from "../../src/run-store.js";
import { SchedulerService } from "../../src/scheduler-service.js";
import { registerScheduleTools } from "../../src/tools.js";
import { ToolDebugLogger } from "../../src/tool-debug-log.js";
import registerExtension from "../../src/extension.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function setup(debugLog = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-tools-")); dirs.push(dir);
  if (debugLog) {
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({ "pi-scheduler": { debugLog: true } }));
  }
  const registry = new RegistryStore({ registryPath: join(dir, "registry.json"), lockPath: join(dir, "lock") });
  const runs = new RunStore({ runsPath: join(dir, "runs.jsonl"), lockPath: join(dir, "lock"), logsDir: join(dir, "logs") });
  const app = { refresh: vi.fn(), status: vi.fn().mockResolvedValue({ role: "host", independent: {} }), runner: { cancel: vi.fn() }, session: { cancelActiveRun: vi.fn() } };
  const service = new SchedulerService(registry, runs, app as never, () => new Date("2030-01-01T00:00:00Z"));
  const tools = new Map<string, any>();
  registerScheduleTools({ registerTool: (t: any) => tools.set(t.name, t) } as never, service, new ToolDebugLogger(dir));
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "session-1" } };
  const call = async (name: string, params: unknown) => (await tools.get(name).execute("call", params, undefined, undefined, ctx)).details;
  const input = { prompt: "review fixture", timing: { kind: "once" as const, expression: "2030-01-01T11:10:00+08:00", timezone: "Asia/Taipei" } };
  return { dir, registry, runs, app, service, tools, ctx, call, input };
}

describe("scheduler tools", () => {
  it.each([
    ["schedule_create", "create"], ["schedule_update", "update"],
    ["schedule_status", "status"], ["schedule_cancel", "cancel"],
  ] as const)("logs %s execution failures only when enabled, preserving the original error", async (name, method) => {
    const f = await setup(true); const error = new Error(`injected ${method} failure`);
    vi.spyOn(f.service, method).mockRejectedValueOnce(error);
    await expect(f.call(name, { ...f.input, prompt: "PRIVATE-PROMPT-SENTINEL" })).rejects.toBe(error);
    const logs = join(f.dir, ".pi", "logs", "pi-scheduler"), files = await readdir(logs);
    expect(files).toHaveLength(1);
    const text = await readFile(join(logs, files[0]), "utf8"), record = JSON.parse(text);
    expect(record).toMatchObject({ project: "pi-scheduler", toolName: name, toolCallId: "call", error: { name: "Error", message: error.message } });
    expect(record.error.stack).toContain(error.message);
    expect(text).not.toContain("PRIVATE-PROMPT-SENTINEL"); expect(record).not.toHaveProperty("params");
  });
  it("does not create diagnostic logs on successful execution even when enabled", async () => {
    const f = await setup(true); expect((await f.call("schedule_status", {})).runtime.role).toBe("host");
    await expect(readdir(join(f.dir, ".pi", "logs", "pi-scheduler"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the original tool rejection when log IO fails", async () => {
    const f = await setup(true); await writeFile(join(f.dir, ".pi", "logs"), "blocked");
    const error = new Error("original service error"); vi.spyOn(f.service, "status").mockRejectedValueOnce(error);
    await expect(f.call("schedule_status", {})).rejects.toBe(error);
    expect(await readFile(join(f.dir, ".pi", "logs"), "utf8")).toBe("blocked");
  });
  it("logs an aborted tool execution without dispatching the service", async () => {
    const f = await setup(true); const controller = new AbortController(); controller.abort();
    const status = vi.spyOn(f.service, "status");
    await expect(f.tools.get("schedule_status").execute("abort-call", {}, controller.signal, undefined, f.ctx)).rejects.toBe(controller.signal.reason);
    expect(status).not.toHaveBeenCalled();
    const logs = join(f.dir, ".pi", "logs", "pi-scheduler"), files = await readdir(logs);
    expect(files).toHaveLength(1); expect(JSON.parse(await readFile(join(logs, files[0]), "utf8"))).toMatchObject({ toolCallId: "abort-call", error: { name: "AbortError" } });
  });
  it("declares output contracts and exposes JSON-safe structured content with read-only status hints", async () => {
    const f = await setup(); const tool = f.tools.get("schedule_status");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    for (const t of f.tools.values()) expect(t.outputSchema.type).toBe("object");
    const result = await tool.execute("id", {}, undefined, undefined, f.ctx);
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
    expect(result.structuredContent.now).toBe("2030-01-01T00:00:00.000Z");
  });
  it("makes scheduler children read-only while leaving status available", async () => {
    const f = await setup(); const created = await f.call("schedule_create", f.input);
    f.app.status.mockResolvedValue({ role: "child-disabled", independent: {} });
    await expect(f.call("schedule_create", f.input)).rejects.toThrow("read-only");
    await expect(f.call("schedule_update", { id: created.schedule.id, revision: 1, patch: { title: "forbidden" } })).rejects.toThrow("read-only");
    await expect(f.call("schedule_cancel", { id: created.schedule.id })).rejects.toThrow("read-only");
    expect((await f.call("schedule_status", {})).runtime.role).toBe("child-disabled");
    expect((await f.registry.list())[0]).toMatchObject({ state: "active", revision: 1 });
  });
  it("registers tools without starting resources at extension factory time", () => {
    const pi = { registerTool: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    registerExtension(pi as never);
    expect(pi.registerTool.mock.calls.map(([t]) => t.name)).toEqual(["schedule_create", "schedule_update", "schedule_status", "schedule_cancel"]);
    expect(pi.on.mock.calls.map(([e]) => e)).toContain("session_shutdown");
  });
  it("creates persistent default-independent tasks and binds session tasks to caller", async () => {
    const f = await setup(); const created = await f.call("schedule_create", { ...f.input, title: "Morning import" });
    expect(created.schedule).toMatchObject({ mode: "independent", cwd: f.dir, revision: 1, nextRun: "2030-01-01T03:10:00.000Z" });
    expect(created.schedule).toHaveProperty("title", "Morning import");
    expect(created.schedule.projectTrust).toBeUndefined();
    const session = await f.call("schedule_create", { ...f.input, sessionId: "session-1" });
    expect(session.schedule).toMatchObject({ mode: "session", targetSessionId: "session-1" }); expect(f.app.refresh).toHaveBeenCalledTimes(2);
    expect(await f.registry.list()).toHaveLength(2);
  });
  it("requires sessionId to identify the current session and rejects mixing it with independent mode", async () => {
    const f = await setup();
    await expect(f.call("schedule_create", { ...f.input, sessionId: "another-session" })).rejects.toThrow("must match the current session");
    await expect(f.call("schedule_create", { ...f.input, mode: "independent", sessionId: "session-1" })).rejects.toThrow("only be used with session execution");
    expect(await f.registry.list()).toHaveLength(0);
  });
  it("updates using revisions, pauses/resumes and throws on stale writes", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    const paused = await f.call("schedule_update", { id: schedule.id, revision: 1, patch: { state: "paused" } });
    expect(paused.schedule.nextRun).toBeNull();
    await expect(f.call("schedule_update", { id: schedule.id, revision: 1, patch: { prompt: "stale" } })).rejects.toThrow("Revision conflict");
    const resumed = await f.call("schedule_update", { id: schedule.id, revision: 2, patch: { state: "active" } });
    expect(resumed.schedule.nextRun).toBeTruthy();
  });
  it("paginates status with current time and runs and never dispatches during reads", async () => {
    const f = await setup(); await f.call("schedule_create", f.input); await f.call("schedule_create", f.input);
    f.app.refresh.mockClear(); const status = await f.call("schedule_status", { offset: 1, limit: 1, runsLimit: 0 });
    expect(status.total).toBe(2); expect(status.schedules).toHaveLength(1); expect(status.now).toBe("2030-01-01T00:00:00.000Z");
    expect(status.timezone).toBeTruthy(); expect(f.app.refresh).not.toHaveBeenCalled();
  });
  it("cancels futures by default, explicitly requests running cancellation and is idempotent", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    await f.runs.append({ runId: "run", scheduleId: schedule.id, mode: "independent", status: "running", plannedAt: "2030-01-01T00:00:00Z", events: [] });
    await f.call("schedule_cancel", { id: schedule.id }); expect(f.app.runner.cancel).not.toHaveBeenCalled();
    expect((await f.registry.list())[0].state).toBe("cancelled");
    await f.call("schedule_cancel", { id: schedule.id, cancelRunning: true });
    expect(f.app.runner.cancel).toHaveBeenCalledWith("run");
    await f.call("schedule_cancel", { runId: "run" }); expect((await f.runs.list())[0].events).toHaveLength(1);
    await expect(f.call("schedule_cancel", { id: schedule.id, runId: "run" })).rejects.toThrow("exactly one");
  });
  it.each([
    { prompt: "   " }, { timing: { kind: "once", expression: "2029-12-01T10:00:00Z", timezone: "UTC" } },
    { timing: { kind: "once", expression: "2030-01-01T10:00:00", timezone: "UTC" } },
    { timing: { kind: "once", expression: "2030-01-01T10:00:00Z", timezone: "not/a-zone" } },
    { timing: { kind: "cron", expression: "not cron", timezone: "UTC" } },
    { execution: { provider: "x" } }, { cwd: "does-not-exist" },
  ])("rejects invalid create without persistence: %j", async (override) => {
    const f = await setup(); await expect(f.call("schedule_create", { ...f.input, ...override })).rejects.toThrow();
    expect(await f.registry.list()).toHaveLength(0); expect(f.app.refresh).not.toHaveBeenCalled();
  });
  it("rejects a file cwd and propagates persistence/abort failures as failed tools", async () => {
    const f = await setup(); await writeFile(join(f.dir, "file"), "fixture");
    await expect(f.call("schedule_create", { ...f.input, cwd: "file" })).rejects.toThrow("directory");
    vi.spyOn(f.registry, "create").mockRejectedValue(new Error("disk full"));
    await expect(f.call("schedule_create", f.input)).rejects.toThrow("disk full");
    const controller = new AbortController(); controller.abort();
    await expect(f.tools.get("schedule_create").execute("id", f.input, controller.signal, undefined, f.ctx)).rejects.toThrow();
  });
});
