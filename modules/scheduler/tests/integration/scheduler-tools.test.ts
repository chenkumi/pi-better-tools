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
  const call = async (name: string, params: unknown) => (await tools.get(name).execute("call", params, undefined, undefined, ctx)).structuredContent;
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
    expect(result.content[0].text).not.toContain("\n"); expect(result.details).toBeUndefined(); // one compact copy, no pretty-printed duplicate
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
    expect(pi.registerTool.mock.calls.map(([t]) => t.name)).toEqual(["schedule_create", "schedule_update", "schedule_status", "schedule_cancel", "schedule_delete"]);
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
  it("returns summary rows for lists (no empty or default fields) and detail for an id", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", { ...f.input, title: "Summary" });
    const list = await f.call("schedule_status", {});
    expect(list.schedules[0]).toEqual({ id: schedule.id, title: "Summary", state: "active", revision: 1, nextRun: "2030-01-01T03:10:00.000Z" });
    expect(list).not.toHaveProperty("offset");
    const detail = await f.call("schedule_status", { id: schedule.id });
    expect(detail.schedules[0]).toMatchObject({ prompt: "review fixture", cwd: f.dir, consumed: false, mode: "independent" });
    const at = "2030-01-01T00:00:00Z", runId = "01hz0000000000000000000009";
    await f.runs.append({ runId, scheduleId: schedule.id, mode: "independent", status: "succeeded", plannedAt: at, endedAt: at, events: [] });
    const summaryRun = (await f.call("schedule_status", {})).runs[0];
    expect(summaryRun).toEqual({ runId, scheduleId: schedule.id, mode: "independent", status: "succeeded", plannedAt: at, endedAt: at });
    expect((await f.call("schedule_status", { runId })).runs[0]).not.toHaveProperty("events");
  });
  it("reads legacy skipped_busy+missed_no_backfill as missed without rewriting stored data, and new misses persist as missed", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    const legacy = "01hz0000000000000000000001", at = "2030-01-01T00:00:00Z";
    await writeFile(join(f.dir, "runs.jsonl"), JSON.stringify({ runId: legacy, scheduleId: schedule.id, mode: "independent", status: "skipped_busy", plannedAt: at, endedAt: at, events: [{ type: "diagnostic", at, detail: "missed_no_backfill" }] }) + "\n");
    const before = await readFile(join(f.dir, "runs.jsonl"), "utf8");
    const status = await f.call("schedule_status", {});
    expect(status.runs[0]).toMatchObject({ runId: legacy, status: "missed" });
    expect(await readFile(join(f.dir, "runs.jsonl"), "utf8")).toBe(before);
    await f.runs.append({ runId: "01hz0000000000000000000002", scheduleId: schedule.id, mode: "independent", status: "missed", plannedAt: at, endedAt: at, events: [] });
    expect((await f.call("schedule_status", {})).runs.map((run: any) => run.status)).toEqual(["missed", "missed"]);
  });
  it("deletes only disabled schedules, with revision check, and prunes finished history", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    await expect(f.call("schedule_delete", { id: schedule.id, revision: 1 })).rejects.toThrow("schedule_cancel");
    expect(await f.registry.list()).toHaveLength(1);
    await f.runs.append({ runId: "01hz0000000000000000000001", scheduleId: schedule.id, mode: "independent", status: "succeeded", plannedAt: "2030-01-01T00:00:00Z", endedAt: "2030-01-01T00:00:00Z", events: [] });
    await f.runs.append({ runId: "01hz0000000000000000000002", scheduleId: "other", mode: "independent", status: "succeeded", plannedAt: "2030-01-01T00:00:00Z", endedAt: "2030-01-01T00:00:00Z", events: [] });
    await f.call("schedule_cancel", { id: schedule.id });
    await expect(f.call("schedule_delete", { id: schedule.id, revision: 1 })).rejects.toThrow("Revision conflict");
    expect(f.tools.get("schedule_delete").annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    const deleted = await f.call("schedule_delete", { id: schedule.id, revision: 2 });
    expect(deleted).toMatchObject({ deleted: { id: schedule.id, revision: 2 }, prunedRuns: 1 });
    expect(await f.registry.list()).toHaveLength(0);
    expect((await f.runs.list()).map((run) => run.scheduleId)).toEqual(["other"]);
    await expect(f.call("schedule_delete", { id: schedule.id, revision: 2 })).rejects.toThrow("Unknown schedule");
    await expect(f.call("schedule_status", { id: schedule.id })).rejects.toThrow("Unknown schedule");
  });
  it("deletes a paused schedule", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    await f.call("schedule_update", { id: schedule.id, revision: 1, patch: { state: "paused" } });
    await f.call("schedule_delete", { id: schedule.id, revision: 2 }); expect(await f.registry.list()).toHaveLength(0);
  });
  it.each(["running", "orphaned"] as const)("refuses to delete a disabled schedule that still has a %s run", async (status) => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    await f.runs.append({ runId: "01hz0000000000000000000001", scheduleId: schedule.id, mode: "independent", status, plannedAt: "2030-01-01T00:00:00Z", ...(status === "orphaned" ? { endedAt: "2030-01-01T00:00:00Z" } : {}), events: [] });
    await f.call("schedule_cancel", { id: schedule.id });
    await expect(f.call("schedule_delete", { id: schedule.id, revision: 2 })).rejects.toThrow(/still active or orphaned/);
    expect(await f.registry.list()).toHaveLength(1); expect(await f.runs.list()).toHaveLength(1);
  });
  it("keeps scheduler children read-only for delete", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input); await f.call("schedule_cancel", { id: schedule.id });
    f.app.status.mockResolvedValue({ role: "child-disabled", independent: {} });
    await expect(f.call("schedule_delete", { id: schedule.id, revision: 2 })).rejects.toThrow("read-only");
    expect(await f.registry.list()).toHaveLength(1);
  });
  it("reports legacy-missed runs as missed and returns a bounded result tail for runId without changing persisted runs", async () => {
    const f = await setup(); const { schedule } = await f.call("schedule_create", f.input);
    const missedId = "01hz0000000000000000000001", doneId = "01hz0000000000000000000002", sessionId = "01hz0000000000000000000003";
    const at = "2030-01-01T00:00:00Z";
    await f.runs.append({ runId: missedId, scheduleId: schedule.id, mode: "independent", status: "skipped_busy", plannedAt: at, endedAt: at, events: [{ type: "diagnostic", at, detail: "missed_no_backfill" }] });
    await f.runs.append({ runId: doneId, scheduleId: schedule.id, mode: "independent", status: "succeeded", plannedAt: at, endedAt: at, outputSummary: "raw json events", events: [] });
    await f.runs.append({ runId: sessionId, scheduleId: schedule.id, mode: "session", status: "succeeded", plannedAt: at, endedAt: at, outputSummary: "session answer", events: [] });
    const final = "x".repeat(3000) + "THE-END";
    const event = (message: object) => JSON.stringify({ type: "message_end", message });
    await f.runs.writeOutput(doneId, "stdout", [
      event({ role: "assistant", content: [{ type: "text", text: "earlier" }] }),
      event({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }),
      event({ role: "assistant", content: [{ type: "text", text: final }] }), "{partial"].join("\n"));
    const before = await readFile(join(f.dir, "runs.jsonl"), "utf8");
    const status = await f.call("schedule_status", { id: schedule.id, runId: doneId });
    const byId = Object.fromEntries(status.runs.map((run: any) => [run.runId, run]));
    expect(byId[missedId]).toMatchObject({ status: "missed" }); expect(byId[missedId]).not.toHaveProperty("capacitySkipped");
    expect(byId[doneId].status).toBe("succeeded");
    expect(status.result).toMatchObject({ runId: doneId, status: "succeeded", source: "final_assistant_text", truncated: true });
    expect(status.result.tail.length).toBeLessThanOrEqual(2001); expect(status.result.tail.endsWith("THE-END")).toBe(true);
    expect((await f.call("schedule_status", { runId: sessionId })).result).toMatchObject({ source: "session_output_summary", tail: "session answer" });
    expect((await f.call("schedule_status", { runId: missedId })).result).toMatchObject({ source: "none", tail: "" });
    await expect(f.call("schedule_status", { runId: "nope" })).rejects.toThrow("Unknown run");
    expect(await readFile(join(f.dir, "runs.jsonl"), "utf8")).toBe(before);
    expect((await f.call("schedule_status", {})).result).toBeUndefined();
  });
  it("documents cron fields, skip rules and trust defaults in tool descriptions", async () => {
    const f = await setup(); const create = f.tools.get("schedule_create");
    expect(create.description).toMatch(/60 seconds[\s\S]*4 child[\s\S]*busy/); expect(create.description).toMatch(/Pi stays open/);
    const props = create.parameters.properties;
    expect(props.timing.properties.expression.description).toMatch(/day-of-month[\s\S]*day-of-week[\s\S]*0 9 \* \* 1-5/);
    expect(props.projectTrust.description).toMatch(/Default false/); expect(props.sessionId.description).toMatch(/mode=session/);
    expect(f.tools.get("schedule_status").parameters.properties.runId).toBeTruthy();
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
