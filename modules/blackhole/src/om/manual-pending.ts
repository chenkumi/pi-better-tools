import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPendingState, clearPendingState, hasPendingData, pendingStorageCleared } from "./pending.js";
import { OM_OBSERVATIONS_DROPPED, OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED } from "./ledger/index.js";
export const PENDING_FLUSH_KEY = "blackhole.pendingFlush";
export function pendingFingerprint(sessionId: string): string {
  return createHash("sha256").update(JSON.stringify(readPendingState(sessionId))).digest("hex");
}
/** Admission appends are NOT a transaction. Pending batches and cursors survive
 * until session_compact confirms persistence; retries compare actual branch records.
 */
export function flushManualPending(pi: ExtensionAPI, sessionId: string, branch: readonly any[] = []): boolean {
  if (!hasPendingData(sessionId)) return false;
  const pending = readPendingState(sessionId);
  const groups = [
    [OM_OBSERVATIONS_RECORDED, pending.observationBatches?.length ? pending.observationBatches : pending.observation ? [pending.observation] : []],
    [OM_REFLECTIONS_RECORDED, pending.reflectionBatches?.length ? pending.reflectionBatches : pending.reflection ? [pending.reflection] : []],
    [OM_OBSERVATIONS_DROPPED, pending.droppedBatches?.length ? pending.droppedBatches : pending.dropped ? [pending.dropped] : []],
  ] as const;
  const acknowledged = new Set(branch.filter(e => e.type === "custom").map(e => `${e.customType}:${JSON.stringify(e.data)}`));
  for (const [type, batches] of groups) for (const batch of batches) {
    const key = `${type}:${JSON.stringify(batch.data)}`;
    if (acknowledged.has(key)) continue;
    pi.appendEntry(type, batch.data); // Throws leave the original pending state intact.
    acknowledged.add(key);
  }
  return true;
}
/** Never clear newer pending work. Deletion remains best-effort and observable. */
export function commitManualPending(sessionId: string, expectedFingerprint: string): boolean {
  if (pendingFingerprint(sessionId) !== expectedFingerprint) return false;
  clearPendingState(sessionId);
  return pendingStorageCleared(sessionId) && !hasPendingData(sessionId);
}
