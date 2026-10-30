import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptTool, createShellTool } from "../src/tool.js";
import { CronScheduler } from "../src/scheduler.js";
import { normalizeEndAt, validateJobDeadline } from "../src/deadline.js";
import { jobKindError, resolveCommandCwd } from "../src/command.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

const job = (o: Partial<CronJob> = {}): CronJob => ({
  id: "jobid00001", name: "nightly", schedule: "5m", intervalMs: 300000, prompt: "hi", enabled: true, type: "interval",
  createdAt: new Date().toISOString(), runCount: 0, ...o,
});

// Agent-facing text may name tool args and tool names, never settings keys, storage/settings files or environment variables.
const FORBIDDEN = /schedule-prompts|defaultJobScope|widgetVisible|pi-schedule-prompt|pi-shell-tools|settings\.json|\bPI_[A-Z]|\.pi\b|\.lock\b/;

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sched-msg-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tool(seed: CronJob[] = []) {
  const jobs = new Map(seed.map((j) => [j.id, j]));
  const storage: any = {
    hasJobWithName: () => false, getJob: (id: string) => jobs.get(id), getAllJobs: () => [...jobs.values()],
    updateJob: vi.fn(), addJob: vi.fn(), removeJob: () => false,
  };
  const scheduler: any = { addJob: vi.fn(), updateJob: vi.fn(), removeJob: vi.fn() };
  const ctx: any = { cwd: root, hasUI: false, sessionManager: { getEntries: () => [], getSessionId: () => "s" } };
  return (params: Record<string, unknown>) =>
    createPromptTool(() => storage, () => scheduler).execute("id", params as any, undefined as any, undefined as any, ctx).then((r: any) => ({ error: r.isError === true, text: r.content[0].text as string }));
}

describe("agent-facing error messages", () => {
  it("job not found tells the agent to list and shows known ids", async () => {
    const run = tool([job()]);
    for (const action of ["remove", "enable", "update"]) {
      const r = await run({ action, jobId: "nope", name: "x" });
      expect(r.error).toBe(true);
      expect(r.text).toContain('"nope"');
      expect(r.text).toContain('action:"list"');
      expect(r.text).toContain("jobid00001 (nightly)");
    }
    expect((await run({ action: "remove" })).text).toContain('action:"list"');
  });

  it("add without schedule explains per-type formats", async () => {
    const r = await tool()({ action: "add", prompt: "x" });
    expect(r.text).toContain('type "once"');
    expect(r.text).toContain('type "interval"');
  });

  it("update with no fields is an explicit error naming updatable fields", async () => {
    const r = await tool([job()])({ action: "update", jobId: "jobid00001" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("No fields to update");
    expect(r.text).toContain("schedule");
    expect(r.text).toContain("prompt");
  });

  it("a command on schedule_prompt names schedule_shell", async () => {
    const r = await tool()({ action: "add", schedule: "5m", type: "interval", command: "echo hi" });
    expect(r.text).toContain("schedule_shell");
  });

  it("non-interactive shell add names the alternative", async () => {
    const storage: any = { hasJobWithName: () => false, addJob: vi.fn() };
    const ctx: any = { cwd: root, hasUI: false, sessionManager: { getEntries: () => [], getSessionId: () => "s" } };
    const r: any = await createShellTool(() => storage, () => ({}) as any).execute("id", { action: "add", schedule: "5m", type: "interval", command: "echo hi" } as any, undefined as any, undefined as any, ctx);
    expect(r.content[0].text).toContain("schedule_prompt");
    expect(storage.addJob).not.toHaveBeenCalled();
  });

  it("cron type with a one-time schedule says to set type once", () => {
    for (const s of ["+10s", "2030-01-01T00:00:00Z"]) {
      const v: any = CronScheduler.validateSchedule("cron", s);
      expect(v.ok).toBe(false);
      expect(v.error).toContain('set type to "once"');
      expect(v.error).toContain("6 fields");
    }
  });

  it("cron parse errors include the received expression, format and example", () => {
    const v: any = CronScheduler.validateSchedule("cron", "0 0 99 * * *");
    expect(v.ok).toBe(false);
    expect(v.error).toContain('received "0 0 99 * * *"');
    expect(v.error).toContain("day-of-month");
    expect(v.error).toContain("0 30 9 * * 1-5");
  });

  it("endAt messages carry the value, an example and the constraint", () => {
    expect(() => normalizeEndAt("tomorrow")).toThrow(/"tomorrow".*2026-12-31T23:59:59Z|2026-12-31T23:59:59Z.*"tomorrow"/);
    expect(() => normalizeEndAt("2026-02-30T00:00:00Z")).toThrow(/2026-02-30T00:00:00Z.*real day/);
    expect(() => validateJobDeadline({ type: "once", schedule: "2030-01-02T00:00:00.000Z", endAt: "2030-01-01T00:00:00.000Z" }))
      .toThrow(/2030-01-02T00:00:00.000Z.*2030-01-01T00:00:00.000Z/);
    expect(() => validateJobDeadline({ type: "cron", schedule: "* * * * * *", endAt: "2000-01-01T00:00:00.000Z" }))
      .toThrow(/2000-01-01T00:00:00.000Z.*endAt:null/);
  });

  it("command job parameter errors name parameter, rule and fix", () => {
    expect(jobKindError({ command: "x", timeoutMs: 0 })).toMatch(/'timeoutMs'.*milliseconds.*got 0.*stall limit.*not a total/);
    expect(jobKindError({ command: "x", shell: "zsh" as any })).toMatch(/'shell'.*"zsh".*omit it/);
    expect(jobKindError({ command: "x", model: "m" })).toMatch(/'model'.*Drop them/);
    expect(jobKindError({ prompt: "p", cwd: "d" })).toMatch(/'cwd'.*pass 'command'/);
    expect(jobKindError({ prompt: "p", command: "c" })).toContain("both were given");
    expect(jobKindError({})).toContain("neither was given");
    const r: any = resolveCommandCwd(root, "missing-dir");
    expect(r.error).toContain("missing-dir");
    expect(r.error).toContain(root);
    expect(r.error).toContain("outside the project");
  });

  it("storage read failure names the cause and a fix without storage file names or paths", () => {
    mkdirSync(join(root, ".pi"), { recursive: true });
    // A directory where the store file should be makes readFileSync fail with EISDIR (not ENOENT).
    mkdirSync(join(root, ".pi", "schedule-prompts.json"));
    let message = "";
    try { new CronStorage(root).load(); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("Cannot read scheduled prompts");
    expect(message).toMatch(/EISDIR|illegal operation/i);
    expect(message).toContain("repair or remove");
    expect(message).not.toContain(root);
    expect(message).not.toMatch(FORBIDDEN);
  });

  it("tool definition never names settings keys, storage files or environment variables", () => {
    for (const create of [createPromptTool, createShellTool]) {
      const definition: any = create(() => ({}) as any, () => ({}) as any);
      expect(JSON.stringify({ d: definition.description, g: definition.promptGuidelines, s: definition.promptSnippet, p: definition.parameters })).not.toMatch(FORBIDDEN);
    }
  });
});
