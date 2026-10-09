import type { CronJob } from "./types.js";

/** Strict calendar validation; Date.parse alone accepts e.g. February 30. */
export function normalizeEndAt(value: unknown): string {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!match) throw new Error("endAt must be an ISO timestamp with seconds and an explicit timezone (Z or ±HH:mm)");
  const [, y, mo, d, h, mi, s, , zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error("endAt contains an invalid calendar date, time or timezone offset");
  }
  const timestamp = Date.parse(value as string);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid endAt timestamp");
  const normalized = new Date(timestamp).toISOString();
  if (normalized.length !== 24) throw new Error("endAt must normalize to a four-digit UTC year");
  return normalized;
}

export type DeadlineState = "none" | "active" | "expired" | "invalid";

export function deadlineState(endAt: unknown, now = Date.now()): DeadlineState {
  if (endAt === undefined) return "none";
  try {
    return now >= Date.parse(normalizeEndAt(endAt)) ? "expired" : "active";
  } catch {
    return "invalid";
  }
}

/** Does not require a future date when merely editing an already-expired job. */
export function validateJobDeadline(
  job: Pick<CronJob, "type" | "schedule" | "endAt">,
  requireFuture = true,
  now = Date.now(),
): void {
  if (job.endAt === undefined) return;
  const end = Date.parse(normalizeEndAt(job.endAt));
  if (requireFuture && now >= end) {
    throw new Error("endAt has expired; extend or clear the deadline before enabling the job");
  }
  if (job.type === "once" && !(Date.parse(job.schedule) < end)) {
    throw new Error("A once job's schedule must be strictly before endAt");
  }
}

export function deadlineLabel(endAt: unknown): string {
  const state = deadlineState(endAt);
  if (state === "none") return "No deadline";
  if (state === "invalid") return "Invalid deadline";
  return `End: ${endAt}${state === "expired" ? " (expired)" : ""}`;
}
