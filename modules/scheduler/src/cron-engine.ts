import { Cron } from "croner";

import type { ScheduleTiming } from "./domain.js";

export class ScheduleTimingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTimingValidationError";
  }
}

export interface ScheduledTimer {
  stop(): void;
}

export interface CronEngineClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): { clear(): void };
}

const systemClock: CronEngineClock = {
  now: () => new Date(),
  setTimeout(callback, delayMs) {
    const timer = globalThis.setTimeout(callback, delayMs);
    return { clear: () => globalThis.clearTimeout(timer) };
  },
};

function parseOneShot(value: string): Date {
  const date = new Date(value);
  if (!value.trim() || Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ScheduleTimingValidationError(`Invalid ISO one-shot time: ${value}`);
  }
  return date;
}

/** A fire later than this after its slot (sleep, event-loop stall) is a missed occurrence, never a late run. */
export const LATE_FIRE_TOLERANCE_MS = 60_000;
/** Creation-time floor for cron cadence; sub-minute cadence would flood history with skipped_busy records. */
export const MIN_CRON_INTERVAL_MS = 60_000;

export interface TimingFire {
  /** The scheduled occurrence this callback belongs to. */
  slot: Date;
  /** True when the fire arrived later than LATE_FIRE_TOLERANCE_MS; the caller must record a miss, not run. */
  late: boolean;
}

export function isLateFire(slot: Date, now: Date, toleranceMs = LATE_FIRE_TOLERANCE_MS): boolean {
  return now.getTime() - slot.getTime() > toleranceMs;
}

/** Structural validation only; safe to run against already-stored schedules. */
function validateTimingShape(timing: ScheduleTiming): void {
  if (!["once", "cron"].includes(timing.kind)) throw new ScheduleTimingValidationError("Unknown timing kind");
  if (!timing.timezone.trim()) throw new ScheduleTimingValidationError("Schedule timezone is required");
  try { new Intl.DateTimeFormat("en", { timeZone: timing.timezone }); }
  catch { throw new ScheduleTimingValidationError(`Invalid timezone: ${timing.timezone}`); }
  if (timing.kind === "once") {
    parseOneShot(timing.expression);
    return;
  }
  try {
    new Cron(timing.expression, { timezone: timing.timezone });
  } catch (error) {
    throw new ScheduleTimingValidationError(error instanceof Error ? error.message : String(error));
  }
}

/** Creation/update validation: structural checks plus the minimum cron cadence. */
export function validateTiming(timing: ScheduleTiming): void {
  validateTimingShape(timing);
  if (timing.kind !== "cron") return;
  const runs = new Cron(timing.expression, { timezone: timing.timezone }).nextRuns(10);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_CRON_INTERVAL_MS) {
      throw new ScheduleTimingValidationError("Cron cadence must be at least one minute between occurrences.");
    }
  }
}

export function createCron(timing: ScheduleTiming, callback?: () => void | Promise<void>): Cron {
  if (timing.kind !== "cron") throw new ScheduleTimingValidationError("One-shot schedules do not create Croner jobs");
  try {
    return new Cron(timing.expression, { timezone: timing.timezone, protect: true }, callback);
  } catch (error) {
    throw new ScheduleTimingValidationError(error instanceof Error ? error.message : String(error));
  }
}

export function previewNextRuns(timing: ScheduleTiming, count = 5, now = new Date()): Date[] {
  if (!Number.isInteger(count) || count < 1) throw new ScheduleTimingValidationError("Preview count must be at least one");
  if (timing.kind === "once") {
    const due = parseOneShot(timing.expression);
    return due.getTime() >= now.getTime() ? [due] : [];
  }
  return createCron(timing).nextRuns(count, now);
}

/** Creates a timer for one schedule without inventing catch-up runs after downtime. */
export function scheduleTiming(timing: ScheduleTiming, callback: (fire: TimingFire) => void | Promise<void>, clock: CronEngineClock = systemClock): ScheduledTimer {
  validateTimingShape(timing);
  if (timing.kind === "cron") {
    let expected: Date | null = null;
    const cron = createCron(timing, () => {
      const now = clock.now();
      const slot = expected ?? now;
      expected = cron.nextRun(now);
      return callback({ slot, late: isLateFire(slot, now) });
    });
    expected = cron.nextRun();
    return { stop: () => cron.stop() };
  }

  const due = parseOneShot(timing.expression);
  let stopped = false;
  let timer: { clear(): void } | undefined;
  const arm = () => {
    if (stopped) return;
    const delay = due.getTime() - clock.now().getTime();
    if (delay <= 0) {
      try { void Promise.resolve(callback({ slot: due, late: isLateFire(due, clock.now()) })).catch(() => undefined); } catch { /* callback owns its error reporting */ }
      return;
    }
    // Node clamps overflowing delays to 1ms; re-arm long waits instead.
    timer = clock.setTimeout(arm, Math.min(delay, 2_147_483_647));
  };
  if (due.getTime() > clock.now().getTime()) arm();
  return { stop: () => { stopped = true; timer?.clear(); } };
}
