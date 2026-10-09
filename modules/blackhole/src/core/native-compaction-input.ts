import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
const evidenceTypes = new Set(["shell-job-completed", "subagent_background", "pi-runtime-recovery", "scheduled_prompt", "background-runtime-recovery-shell", "background-runtime-recovery-subagent", "blackhole-pre-compaction-output"]);

/** Same eligible-entry ordering as Pi 1.1.0 buildContextEntries on an already selected branch.
 * Do not scan edits outside this checkpoint's retained range. No target-relative chronology rule.
 */
export function nativeContextEntries(branch: readonly any[]): any[] {
  let index = -1;
  for (let i = 0; i < branch.length; i++) if (branch[i].type === "compaction") index = i;
  if (index < 0) return [...branch];
  const checkpoint = branch[index];
  const start = checkpoint.firstKeptEntryId ? branch.findIndex(e => e.id === checkpoint.firstKeptEntryId) : -1;
  return [checkpoint, ...(start >= 0 && start < index ? branch.slice(start, index).filter(e => !(e.type === "message" && e.message.role === "system")) : []), ...branch.slice(index + 1)];
}
export function nativeEligibleEdits(branch: readonly any[]): Map<string, any> {
  const edits = new Map<string, any>();
  for (const entry of nativeContextEntries(branch)) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  return edits;
}

/** Content always comes from Pi preparation. Raw entries prove identity only; never supply content. */
export function nativeCompactionInput(preparation: CompactionPreparation, branch: any[], projection?: any) {
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].filter((m: any) => !(m.role === "custom" && evidenceTypes.has(m.customType)));
  const candidates: Array<{ id: string; message: any }> = projection?.entries?.flatMap((entry: any) => entry.messages.map((message: any) => ({ id: entry.sourceEntry.id, message }))) ?? branch.filter(e => e.type === "message").map(e => ({ id: e.id, message: e.message }));
  const identity = new Map<any, string[]>(), serialized = new Map<string, string[]>();
  for (const candidate of candidates) {
    const exactIds = identity.get(candidate.message);
    if (exactIds) exactIds.push(candidate.id); else identity.set(candidate.message, [candidate.id]);
    const key = JSON.stringify(candidate.message), equalIds = serialized.get(key);
    if (equalIds) equalIds.push(candidate.id); else serialized.set(key, [candidate.id]);
  }
  const selectedIds = messages.map(message => {
    const exact = identity.get(message);
    if (exact?.length === 1) return exact[0];
    const equal = serialized.get(JSON.stringify(message));
    return equal?.length === 1 ? equal[0] : "";
  });
  return { ok: true as const, messages, selectedIds, firstKeptEntryId: preparation.firstKeptEntryId, compactAll: preparation.firstKeptEntryId === "" };
}

/** Preserve every boundary coordinate. Edited notification metadata is no longer authority:
 * Pi edits replace content only, not producer details. Do not resurrect those stale details.
 * A plain state skeleton contributes no evidence, including when previous proof names the ID.
 */
export function nativeEvidenceEntries(branch: any[]): any[] {
  const edits = nativeEligibleEdits(branch);
  return branch.map(entry => entry.type === "custom_message" && edits.has(entry.id)
    ? { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, type: "custom", customType: "blackhole-edited-evidence-boundary", data: { outcomeKnown: false } }
    : entry);
}
