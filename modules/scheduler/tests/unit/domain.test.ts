import { describe, expect, it } from "vitest";

import { appendRunEvent, canTransitionRun, transitionRun, type Run } from "../../src/domain.js";

const plannedRun: Run = {
  runId: "run-1",
  scheduleId: "schedule-1",
  mode: "independent",
  status: "planned",
  plannedAt: "2026-09-17T00:00:00.000Z",
  events: [],
};

describe("run lifecycle", () => {
  it("allows only declared transitions and records terminal time", () => {
    expect(canTransitionRun("planned", "queued")).toBe(true);
    expect(canTransitionRun("succeeded", "running")).toBe(false);
    const queued = transitionRun(plannedRun, "queued", "2026-09-17T00:01:00.000Z");
    const running = transitionRun(queued, "running", "2026-09-17T00:02:00.000Z");
    const done = transitionRun(running, "succeeded", "2026-09-17T00:03:00.000Z");
    expect(done.endedAt).toBe("2026-09-17T00:03:00.000Z");
    expect(() => transitionRun(done, "running", "2026-09-17T00:04:00.000Z")).toThrow("Illegal run transition");
  });

  it("keeps abort requests as audit events rather than a terminal status", () => {
    const updated = appendRunEvent(plannedRun, { type: "abort_requested", at: "2026-09-17T00:01:00.000Z" });
    expect(updated.status).toBe("planned");
    expect(updated.events).toHaveLength(1);
  });
});
