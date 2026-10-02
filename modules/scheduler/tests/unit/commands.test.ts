import { describe, expect, it, vi } from "vitest";
import { registerScheduleCommands } from "../../src/commands.js";

function setup() {
  let command: any;
  const service = {
    registry: { list: vi.fn().mockResolvedValue([]) },
    status: vi.fn().mockResolvedValue({ localTime: "local time", runtime: { role: "host", independent: {} }, schedules: [], runs: [], total: 0 }),
    cancel: vi.fn().mockResolvedValue({}),
  };
  const ctx = { ui: { notify: vi.fn() } };
  registerScheduleCommands({ registerCommand: (_name: string, c: unknown) => { command = c; } } as never, service as never);
  return { command, service, ctx };
}

describe("human schedule commands", () => {
  it("shows status without JSON and lists history", async () => {
    const { command, service, ctx } = setup();
    await command.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Scheduler: host; Pi must stay open"), "info");
    await command.handler("runs job", ctx); expect(service.status).toHaveBeenLastCalledWith({ id: "job", runsLimit: 20 });
  });
  it("cancels future schedules separately from runs", async () => {
    const { command, service, ctx } = setup();
    await command.handler("cancel job", ctx); expect(service.cancel).toHaveBeenCalledWith({ id: "job" });
    await command.handler("run cancel run-1", ctx); expect(service.cancel).toHaveBeenCalledWith({ runId: "run-1" });
  });
  it.each(['create {"prompt":"danger"}', 'update job 1 {}', 'runner install', 'run job', 'pause job 1', 'cancel'])
    ("rejects removed/invalid command %s without side effects", async (input) => {
      const { command, service, ctx } = setup(); await command.handler(input, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no JSON input"), "error");
      expect(service.cancel).not.toHaveBeenCalled(); expect(service.status).not.toHaveBeenCalled();
    });
  it("shows errors without hiding mutation failures", async () => {
    const { command, service, ctx } = setup(); service.cancel.mockRejectedValue(new Error("disk unavailable"));
    await command.handler("cancel job", ctx); expect(ctx.ui.notify).toHaveBeenCalledWith("disk unavailable", "error");
  });
});
