import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronTool } from "../src/tool.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

let project: string;
beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-review-g5-")));
  project = join(base, "proj");
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(join(project, ".."), { recursive: true, force: true }));

const job = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "cmdjob0001", name: "cmd", schedule: "5m", intervalMs: 300000, command: "echo A", enabled: false, type: "interval",
  createdAt: new Date().toISOString(), runCount: 0, session: "sess", ...overrides,
});

describe("G5-002: enable applies only the command spec the user confirmed", () => {
  const setup = () => {
    const storage = new CronStorage(project);
    const peer = new CronStorage(project);
    storage.addJob(job());
    const scheduler = { addJob: vi.fn(), removeJob: vi.fn(), updateJob: vi.fn(), getNextRun: () => null, approveCommand: vi.fn().mockReturnValue(true) };
    return { storage, peer, scheduler };
  };
  const enable = (storage: CronStorage, scheduler: unknown, confirm: () => Promise<boolean>) =>
    createCronTool(() => storage, () => scheduler as never).execute("id", { action: "enable", jobId: "cmdjob0001" } as never, undefined as never, undefined as never,
      { cwd: project, hasUI: true, ui: { confirm }, sessionManager: { getEntries: () => [], getSessionId: () => "sess" } } as never);

  it("refuses to enable when a peer changed the command while the confirmation was pending", async () => {
    const { storage, peer, scheduler } = setup();
    const result: any = await enable(storage, scheduler, async () => { peer.updateJob("cmdjob0001", { command: "echo B" }); return true; });
    expect(result.isError).toBe(true);
    expect(storage.getJob("cmdjob0001")).toMatchObject({ enabled: false, command: "echo B" });
    expect(scheduler.approveCommand).not.toHaveBeenCalled();
    expect(scheduler.updateJob).not.toHaveBeenCalled();
  });

  it("enables and approves the stored job when nothing changed (and keeps unrelated peer edits)", async () => {
    const { storage, peer, scheduler } = setup();
    const result: any = await enable(storage, scheduler, async () => { peer.updateJob("cmdjob0001", { runCount: 7 }); return true; });
    expect(result.isError).toBeUndefined();
    expect(storage.getJob("cmdjob0001")).toMatchObject({ enabled: true, command: "echo A", runCount: 7 });
    expect(scheduler.approveCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "echo A", enabled: true }));
    expect(result.details.jobs[0]).toMatchObject({ command: "echo A", runCount: 7, enabled: true });
  });
});
