import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShellTool } from "../src/tool.js";
import { defaultCommandShell } from "../src/command.js";
import type { CronJob } from "../src/types.js";

function makeStorage(seed: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seed.map((j) => [j.id, j]));
  return {
    hasJobWithName: (name: string) => [...jobs.values()].some((j) => j.name === name),
    addJob: vi.fn((job: CronJob) => jobs.set(job.id, job)),
    removeJob: (id: string) => jobs.delete(id),
    removeDisabledJobs: () => [],
    updateJob: vi.fn((id: string, partial: Partial<CronJob>) => { const j = jobs.get(id); if (!j) return false; Object.assign(j, partial); return true; }),
    updateJobWith: vi.fn((id: string, compute: (j: CronJob) => Partial<CronJob> | undefined) => { const j = jobs.get(id); if (!j) return false; const partial = compute(j); if (partial === undefined) return false; Object.assign(j, partial); return true; }),
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => [...jobs.values()],
  } as any;
}

let project: string;
let outside: string;
let storage: any;
let scheduler: any;
let confirm: ReturnType<typeof vi.fn>;
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: project,
    hasUI: true,
    ui: { confirm },
    sessionManager: { getEntries: () => [], getSessionId: () => "sess" },
    ...overrides,
  } as any;
}
const run = (params: Record<string, unknown>, ctx = makeCtx()) =>
  createShellTool(() => storage, () => scheduler).execute("id", params as any, undefined as any, undefined as any, ctx);
const text = (result: any) => result.content[0].text as string;
const commandJob = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "cmdjob0001", name: "cmd", schedule: "5m", intervalMs: 300000, command: "echo hi", enabled: true, type: "interval",
  createdAt: new Date().toISOString(), runCount: 0, ...overrides,
});

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-command-tool-")));
  project = join(base, "proj");
  outside = join(base, "outside");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(outside);
  confirm = vi.fn().mockResolvedValue(true);
  storage = makeStorage();
  scheduler = { addJob: vi.fn(), removeJob: vi.fn(), updateJob: vi.fn(), getNextRun: () => null, approveCommand: vi.fn().mockReturnValue(true) };
});
afterEach(() => rmSync(join(project, ".."), { recursive: true, force: true }));

describe("schedule_shell add", () => {
  it("creates a command job after the user confirms the exact spec", async () => {
    const result: any = await run({ action: "add", name: "build", schedule: "5m", type: "interval", command: "npm run build", timeoutMs: 60_000 });
    expect(result.isError).toBeUndefined();
    expect(storage.addJob).toHaveBeenCalledOnce();
    const job = storage.addJob.mock.calls[0][0] as CronJob;
    expect(job).toMatchObject({ command: "npm run build", timeoutMs: 60_000, enabled: true, session: "sess" });
    expect(job.prompt).toBeUndefined();
    expect(job.cwd).toBeUndefined(); // default stays "the project", it is not frozen
    expect(scheduler.addJob).toHaveBeenCalledWith(job);
    expect(scheduler.approveCommand).toHaveBeenCalledWith(job);
    const [title, message] = confirm.mock.calls[0];
    expect(title).toMatch(/Confirm scheduled command/);
    expect(message).toContain("Command: npm run build");
    expect(message).toContain(`Shell: ${defaultCommandShell()}`);
    expect(message).toContain("60000 ms");
    expect(message).not.toContain("OUTSIDE");
    expect(text(result)).toContain("Created command job");
  });

  it("stores the resolved real directory when a cwd is given", async () => {
    await run({ action: "add", name: "sub", schedule: "5m", type: "interval", command: "ls", cwd: "sub", shell: "bash" });
    expect(storage.addJob.mock.calls[0][0]).toMatchObject({ cwd: join(project, "sub"), shell: "bash" });
  });

  it("warns in the confirmation when the directory is outside the project", async () => {
    await run({ action: "add", name: "out", schedule: "5m", type: "interval", command: "ls", cwd: outside });
    expect(confirm.mock.calls[0][1]).toContain("OUTSIDE the project");
    expect(storage.addJob.mock.calls[0][0]).toMatchObject({ cwd: outside });
  });

  it("refuses without an interactive UI and saves nothing", async () => {
    for (const ctx of [makeCtx({ hasUI: false }), makeCtx({ hasUI: undefined }), makeCtx({ ui: undefined })]) {
      const result: any = await run({ action: "add", name: "x", schedule: "5m", type: "interval", command: "echo" }, ctx);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/interactive/);
    }
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(scheduler.addJob).not.toHaveBeenCalled();
    expect(scheduler.approveCommand).not.toHaveBeenCalled();
  });

  it("saves nothing when the user declines", async () => {
    confirm.mockResolvedValue(false);
    const result: any = await run({ action: "add", name: "x", schedule: "5m", type: "interval", command: "echo" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not confirm/);
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(scheduler.approveCommand).not.toHaveBeenCalled();
  });

  it("rejects a missing directory before asking the user", async () => {
    const result: any = await run({ action: "add", name: "x", schedule: "5m", type: "interval", command: "echo", cwd: "missing" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not exist/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["a prompt alongside the command", { prompt: "p", command: "c" }, /'prompt' is not accepted by schedule_shell.*schedule_prompt/],
    ["a model with a command", { command: "c", model: "haiku" }, /only apply to prompt jobs/],
    ["notify with a command", { command: "c", notify: true }, /'notify'/],
    ["a prompt instead of a command", { prompt: "p", shell: "bash" }, /schedule_prompt/],
  ])("rejects %s", async (_label, extra, pattern) => {
    const result: any = await run({ action: "add", name: "x", schedule: "5m", type: "interval", ...extra });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(pattern);
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("still requires schedule and command", async () => {
    expect(text(await run({ action: "add", command: "echo" }))).toMatch(/'schedule'/);
    expect(text(await run({ action: "add", schedule: "5m" }))).toMatch(/'command'/);
  });
});

describe("schedule_shell update/enable/list", () => {
  it("reconfirms and re-approves when the command, shell or directory changes", async () => {
    storage = makeStorage([commandJob()]);
    const result: any = await run({ action: "update", jobId: "cmdjob0001", command: "echo changed", cwd: "sub" });
    expect(result.isError).toBeUndefined();
    expect(confirm.mock.calls[0][1]).toContain("Command: echo changed");
    expect(storage.updateJob).toHaveBeenCalledWith("cmdjob0001", expect.objectContaining({ command: "echo changed", cwd: join(project, "sub") }));
    expect(scheduler.approveCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "echo changed" }));
  });

  it("does not persist a changed command the user declined", async () => {
    storage = makeStorage([commandJob()]);
    confirm.mockResolvedValue(false);
    const result: any = await run({ action: "update", jobId: "cmdjob0001", command: "rm -rf /" });
    expect(result.isError).toBe(true);
    expect(storage.updateJob).not.toHaveBeenCalled();
    expect(storage.getJob("cmdjob0001").command).toBe("echo hi");
  });

  it("does not ask again for a change that does not affect what runs", async () => {
    storage = makeStorage([commandJob()]);
    const result: any = await run({ action: "update", jobId: "cmdjob0001", description: "nightly" }, makeCtx({ hasUI: false }));
    expect(result.isError).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("only manages shell jobs and points at schedule_prompt for prompt jobs", async () => {
    storage = makeStorage([commandJob(), { ...commandJob({ id: "promptjob1", name: "pr", enabled: false }), command: undefined, prompt: "p" }]);
    for (const action of ["remove", "enable", "disable", "update"]) {
      const result: any = await run({ action, jobId: "promptjob1", description: "x" });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/prompt job; manage it with schedule_prompt/);
    }
    expect(text(await run({ action: "list" }))).not.toContain("promptjob1");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses to change a job's kind", async () => {
    storage = makeStorage([commandJob(), { ...commandJob({ id: "promptjob1", name: "pr" }), command: undefined, prompt: "p" }]);
    expect(text(await run({ action: "update", jobId: "cmdjob0001", prompt: "now a prompt" }))).toMatch(/cannot be set on a command job/);
    expect(text(await run({ action: "update", jobId: "cmdjob0001", model: "haiku" }))).toMatch(/cannot be set on a command job/);
    expect(storage.updateJob).not.toHaveBeenCalled();
  });

  it("rejects an update to an invalid timeout even when the schema is bypassed", async () => {
    storage = makeStorage([commandJob()]);
    const result: any = await run({ action: "update", jobId: "cmdjob0001", timeoutMs: 0 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/'timeoutMs'/);
    expect(storage.updateJob).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires confirmation to enable a command job and approves it", async () => {
    storage = makeStorage([commandJob({ enabled: false })]);
    expect((await run({ action: "enable", jobId: "cmdjob0001" }, makeCtx({ hasUI: false }))) as any).toMatchObject({ isError: true });
    expect(storage.getJob("cmdjob0001").enabled).toBe(false);
    confirm.mockResolvedValueOnce(false);
    expect((await run({ action: "enable", jobId: "cmdjob0001" })) as any).toMatchObject({ isError: true });
    expect(storage.getJob("cmdjob0001").enabled).toBe(false);
    const ok: any = await run({ action: "enable", jobId: "cmdjob0001" });
    expect(ok.isError).toBeUndefined();
    expect(storage.getJob("cmdjob0001").enabled).toBe(true);
    expect(scheduler.approveCommand).toHaveBeenCalledOnce();
  });

  it("disables a command job without asking", async () => {
    storage = makeStorage([commandJob()]);
    const result: any = await run({ action: "disable", jobId: "cmdjob0001" }, makeCtx({ hasUI: false }));
    expect(result.isError).toBeUndefined();
    expect(storage.getJob("cmdjob0001").enabled).toBe(false);
  });

  it("lists the command, shell and directory instead of a prompt", async () => {
    storage = makeStorage([commandJob({ cwd: "/somewhere", shell: "bash" })]);
    const listing = text(await run({ action: "list" }));
    expect(listing).toContain("Command (bash): echo hi");
    expect(listing).toContain("Directory: /somewhere");
    expect(listing).not.toContain("Prompt:");
  });
});
