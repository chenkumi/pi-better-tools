import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import { createPromptTool, createShellTool } from "../src/tool.js";
import type { CronJob } from "../src/types.js";

let root: string;
let storage: CronStorage;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sched-kind-"))); storage = new CronStorage(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = { schedule: "5m", intervalMs: 300000, enabled: false, type: "interval", createdAt: "2026-01-01T00:00:00.000Z", runCount: 0 } as const;
const promptJob: CronJob = { ...base, id: "promptjob1", name: "p", prompt: "hello" };
const shellJob: CronJob = { ...base, id: "shelljob01", name: "s", command: "echo hi" };
const ctx: any = { cwd: root, hasUI: true, ui: { confirm: vi.fn() }, sessionManager: { getEntries: () => [], getSessionId: () => "sess" } };
const scheduler: any = { addJob: vi.fn(), removeJob: vi.fn(), updateJob: vi.fn(), getNextRun: () => null };
const call = (create: typeof createPromptTool, params: Record<string, unknown>) =>
  create(() => storage, () => scheduler).execute("id", params as any, undefined as any, undefined as any, ctx);
const text = (r: any) => r.content[0].text as string;

describe("schedule_prompt / schedule_shell split", () => {
  it("expose distinct names and parameter shapes", () => {
    const prompt: any = createPromptTool(() => storage, () => scheduler);
    const shell: any = createShellTool(() => storage, () => scheduler);
    expect([prompt.name, shell.name]).toEqual(["schedule_prompt", "schedule_shell"]);
    expect(Object.keys(prompt.parameters.properties)).toEqual(expect.arrayContaining(["prompt", "model", "notify", "extensions", "skills"]));
    for (const key of ["command", "shell", "cwd", "timeoutMs"]) expect(prompt.parameters.properties[key]).toBeUndefined();
    expect(Object.keys(shell.parameters.properties)).toEqual(expect.arrayContaining(["command", "shell", "cwd", "timeoutMs"]));
    for (const key of ["prompt", "model", "notify", "extensions", "skills"]) expect(shell.parameters.properties[key]).toBeUndefined();
  });

  it("list shows only jobs of the tool's own kind", async () => {
    storage.addJob(promptJob);
    storage.addJob(shellJob);
    const prompts = text(await call(createPromptTool, { action: "list" }));
    const shells = text(await call(createShellTool, { action: "list" }));
    expect(prompts).toContain("promptjob1");
    expect(prompts).not.toContain("shelljob01");
    expect(shells).toContain("shelljob01");
    expect(shells).not.toContain("promptjob1");
  });

  it("each tool refuses to change a job of the other kind", async () => {
    storage.addJob(promptJob);
    storage.addJob(shellJob);
    for (const action of ["remove", "enable", "disable", "update"]) {
      const a: any = await call(createPromptTool, { action, jobId: "shelljob01", description: "x" });
      expect([a.isError, text(a)]).toEqual([true, expect.stringContaining("manage it with schedule_shell")]);
      const b: any = await call(createShellTool, { action, jobId: "promptjob1", description: "x" });
      expect([b.isError, text(b)]).toEqual([true, expect.stringContaining("manage it with schedule_prompt")]);
    }
    expect(storage.getAllJobs().map((j) => j.id).sort()).toEqual(["promptjob1", "shelljob01"]);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("cleanup removes only disabled jobs of its own kind", async () => {
    storage.addJob(promptJob);
    storage.addJob(shellJob);
    await call(createShellTool, { action: "cleanup" });
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["promptjob1"]);
    await call(createPromptTool, { action: "cleanup" });
    expect(storage.getAllJobs()).toEqual([]);
  });
});
