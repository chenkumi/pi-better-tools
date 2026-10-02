export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Convert a positive integer timeout in milliseconds to Pi shell timeout seconds. */
export function timeoutMsToSeconds(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === MAX_TIMEOUT_MS) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer in milliseconds");
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs / 1000;
}

/** Adapt partial/unvalidated renderer arguments without throwing during streaming. */
export function timeoutMsToRenderSeconds(timeoutMs) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs !== MAX_TIMEOUT_MS
    ? timeoutMs / 1000
    : undefined;
}
