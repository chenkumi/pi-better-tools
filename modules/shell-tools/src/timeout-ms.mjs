export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Bounded, safe description of a received argument for error messages. */
export function describeReceived(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** Convert a positive integer timeout in milliseconds to Pi shell timeout seconds. */
export function timeoutMsToSeconds(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === MAX_TIMEOUT_MS) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    const shown = typeof timeoutMs === "number" ? String(timeoutMs) : describeReceived(timeoutMs);
    throw new TypeError(`timeoutMs must be a positive integer between 1 and ${MAX_TIMEOUT_MS} milliseconds (e.g. 20000 = 20 seconds); received ${shown}. Omit timeoutMs for no timeout.`);
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS} milliseconds; received ${timeoutMs}. Omit timeoutMs for no timeout.`);
  }
  return timeoutMs / 1000;
}

/** Adapt partial/unvalidated renderer arguments without throwing during streaming. */
export function timeoutMsToRenderSeconds(timeoutMs) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs !== MAX_TIMEOUT_MS
    ? timeoutMs / 1000
    : undefined;
}
