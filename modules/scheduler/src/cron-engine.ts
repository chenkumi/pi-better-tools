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

export function validateTiming(timing: ScheduleTiming): void {
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
export function scheduleTiming(timing: ScheduleTiming, callback: () => void | Promise<void>, clock: CronEngineClock = systemClock): ScheduledTimer {
  validateTiming(timing);
  if (timing.kind === "cron") {
    const cron = createCron(timing, callback);
    return { stop: () => cron.stop() };
  }

  const due = parseOneShot(timing.expression);
  let stopped = false;
  let timer: { clear(): void } | undefined;
  const arm = () => {
    if (stopped) return;
    const delay = due.getTime() - clock.now().getTime();
    if (delay <= 0) {
      try { void Promise.resolve(callback()).catch(() => undefined); } catch { /* callback owns its error reporting */ }
      return;
    }
    // Node clamps overflowing delays to 1ms; re-arm long waits instead.
    timer = clock.setTimeout(arm, Math.min(delay, 2_147_483_647));
  };
  if (due.getTime() > clock.now().getTime()) arm();
  return { stop: () => { stopped = true; timer?.clear(); } };
}
