import { describe, expect, it } from "vitest";

import { scheduleTiming, previewNextRuns, ScheduleTimingValidationError, validateTiming } from "../../src/cron-engine.js";

describe("cron engine", () => {
  it("requires timezone and offset, and bounds long timer delays", () => {
    expect(() => validateTiming({ kind: "once", expression: "2030-01-01T12:00:00", timezone: "UTC" })).toThrow();
    expect(() => validateTiming({ kind: "once", expression: "2030-01-01T12:00:00Z", timezone: "Not/AZone" })).toThrow();
    let fired = 0;
    let now = new Date("2030-01-01T00:00:00Z");
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const job = scheduleTiming({ kind: "once", expression: "2031-01-01T00:00:00Z", timezone: "UTC" }, () => { fired++; }, {
      now: () => now, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { clear() {} }; },
    });
    expect(timers[0].delay).toBe(2_147_483_647);
    now = new Date("2030-02-01T00:00:00Z"); timers[0].callback(); expect(fired).toBe(0);
    now = new Date("2031-01-01T00:00:00Z"); timers[1].callback(); expect(fired).toBe(1);
    job.stop();
  });
  it("validates cron and ISO one-shot timing and previews without catch-up", () => {
    expect(previewNextRuns({ kind: "once", expression: "2026-09-17T12:00:00.000Z", timezone: "Asia/Taipei" }, 3, new Date("2026-09-17T11:00:00.000Z")))
      .toEqual([new Date("2026-09-17T12:00:00.000Z")]);
    expect(previewNextRuns({ kind: "once", expression: "2026-09-17T10:00:00.000Z", timezone: "Asia/Taipei" }, 1, new Date("2026-09-17T11:00:00.000Z"))).toEqual([]);
    expect(previewNextRuns({ kind: "cron", expression: "0 * * * *", timezone: "Asia/Taipei" }, 2)).toHaveLength(2);
    expect(() => validateTiming({ kind: "once", expression: "tomorrow", timezone: "Asia/Taipei" })).toThrow(ScheduleTimingValidationError);
  });
});
