/** Node clamps larger delays to 1ms; duration syntax has a minimum positive unit of 1s. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function parseInterval(interval: string): number | null {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Number(match[1]) * units[match[2]];
}

/** Persisted intervalMs is a cache, never an independent timer authority. */
export function intervalError(schedule: string, cached: number): string | undefined {
  const derived = parseInterval(schedule);
  if (derived === null || !Number.isSafeInteger(derived) || derived < 1000 || derived > MAX_TIMER_MS) {
    return `Invalid interval schedule ${JSON.stringify(schedule)}; expected a duration from 1s through the ${MAX_TIMER_MS}ms timer limit`;
  }
  if (cached !== derived) return `Invalid intervalMs ${cached} for schedule ${JSON.stringify(schedule)}; expected ${derived}ms`;
  return undefined;
}
