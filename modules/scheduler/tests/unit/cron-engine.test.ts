import { describe, expect, it } from "vitest";

import { isLateFire, LATE_FIRE_TOLERANCE_MS, scheduleTiming, previewNextRuns, ScheduleTimingValidationError, validateTiming } from "../../src/cron-engine.js";

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

  it("rejects sub-minute cron cadence but accepts per-minute", () => {
    expect(() => validateTiming({ kind: "cron", expression: "* * * * * *", timezone: "UTC" })).toThrow("at least one minute");
    expect(() => validateTiming({ kind: "cron", expression: "*/30 * * * * *", timezone: "UTC" })).toThrow(ScheduleTimingValidationError);
    expect(() => validateTiming({ kind: "cron", expression: "* * * * *", timezone: "UTC" })).not.toThrow();
    expect(() => validateTiming({ kind: "cron", expression: "0,1 * * * *", timezone: "UTC" })).not.toThrow();
  });
  it("classifies fires later than the tolerance as late (missed, no backfill)", () => {
    const slot = new Date("2030-01-01T00:00:00Z");
    expect(isLateFire(slot, new Date(slot.getTime() + LATE_FIRE_TOLERANCE_MS))).toBe(false);
    expect(isLateFire(slot, new Date(slot.getTime() + LATE_FIRE_TOLERANCE_MS + 1))).toBe(true);
  });
  it("passes the slot and lateness to one-shot callbacks", () => {
    let now = new Date("2030-01-01T00:00:00Z");
    const fires: Array<{ slot: string; late: boolean }> = []; const timers: Array<() => void> = [];
    scheduleTiming({ kind: "once", expression: "2030-01-01T01:00:00Z", timezone: "UTC" }, ({ slot, late }) => { fires.push({ slot: slot.toISOString(), late }); }, {
      now: () => now, setTimeout: (callback) => { timers.push(callback); return { clear() {} }; },
    });
    now = new Date("2030-01-01T05:00:00Z"); timers[0]();
    expect(fires).toEqual([{ slot: "2030-01-01T01:00:00.000Z", late: true }]);
  });
});
