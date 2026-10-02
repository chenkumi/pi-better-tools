import { describe, expect, it, vi } from "vitest";

import type { Run } from "../../src/domain.js";
import { commandFingerprint } from "../../src/pi-process-executor.js";
import { ProcessSupervisor } from "../../src/process-supervisor.js";

const run: Run = {
  runId: "run-1", scheduleId: "schedule-1", mode: "independent", status: "cancelling", plannedAt: "2026-09-17T00:00:00.000Z", events: [],
  processIdentity: {
    pid: 42,
    startedAt: "2026-09-17T00:00:00.000Z",
    commandFingerprint: commandFingerprint("C:/Program Files/pi/pi.exe", ["--mode", "json", "-p"]),
  },
};

describe("recovered process cancellation", () => {
  it("only terminates a live child whose PID, start timestamp, and command match", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const supervisor = new ProcessSupervisor({
      inspect: async () => ({ pid: 42, startedAt: "2026-09-17T00:00:00.000Z", commandLine: '"C:/Program Files/pi/pi.exe" --mode json -p' }),
    }, { terminateTree });
    await expect(supervisor.cancelRecoveredRun(run)).resolves.toBe("terminated");
    expect(terminateTree).toHaveBeenCalledWith(42);
  });

  it("marks PID reuse or unknown child orphaned without calling termination", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const supervisor = new ProcessSupervisor({
      inspect: async () => ({ pid: 42, startedAt: "2026-09-17T00:01:00.000Z", commandLine: '"C:/Program Files/pi/pi.exe" --mode json -p' }),
    }, { terminateTree });
    await expect(supervisor.cancelRecoveredRun(run)).resolves.toBe("orphaned");
    expect(terminateTree).not.toHaveBeenCalled();
  });
});
