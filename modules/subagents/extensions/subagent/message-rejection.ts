/** A successfully evaluated but unavailable operation is not a runtime failure.
 * Never classify checkpoint/configuration/trust/ownership or unknown errors as
 * soft refusals. The rejected receipt remains authoritative to the model. */
const expectedCodes = new Set(["TASK_NOT_RUNNING", "SESSION_BUSY", "QUERY_CAPACITY", "CONTROL_CAPACITY", "BACKGROUND_CAPACITY", "MESSAGE_ABORTED"]);
export function isExpectedMessageRefusal(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  // Live owner/cwd checks deliberately use the opaque SESSION_BUSY code before
  // revealing any state. Only proven lifecycle contention is a soft refusal.
  if (receipt.errorCode === "SESSION_BUSY" && (typeof receipt.observedState !== "string" || !["queued", "startup", "running", "finalizing", "canceling", "busy", "ready"].includes(receipt.observedState))) return false;
  return receipt.status === "rejected" && (receipt.mode === "query" || receipt.mode === "control") &&
    typeof receipt.subagentSessionId === "string" && receipt.subagentSessionId.length > 0 &&
    typeof receipt.errorCode === "string" && expectedCodes.has(receipt.errorCode);
}
